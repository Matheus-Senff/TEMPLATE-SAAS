"use server";

import type { EmailOtpType } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { fail, type ActionResult } from "@/lib/action";
import { audit } from "@/lib/audit";
import { hasVerifiedMfa, isRecoverySession, requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { hashKey, rateLimit, rateLimitAll, rateLimitPeek } from "@/lib/rate-limit";
import { verifyPassword } from "@/lib/reauth";
import { safePath } from "@/lib/redirect";
import { clientIp } from "@/lib/request";
import { createClient } from "@/lib/supabase/server";
import { authErrorMessage } from "./errors";
import {
  changePasswordSchema,
  confirmSchema,
  newPasswordSchema,
  reauthSchema,
  resetRequestSchema,
  signInSchema,
  signUpSchema,
} from "./schemas";

const tooMany = () => fail("Muitas tentativas. Aguarde alguns minutos.");

type Limit = readonly [limit: number, windowSeconds: number];

/**
 * Two layers, both failing closed (Postgres unavailable = refused):
 * - per IP (when the platform gives a trustworthy one, see request.ts): charged on every attempt, up front;
 * - per e-mail (hashed, no PII stored): only CHECKED up front and CHARGED after Supabase answered with the captcha
 *   accepted (see each action). A request without a valid Turnstile token never spends the victim's budget, so
 *   nobody can lock an account out without solving captchas. Rotating IPs still hits the e-mail limit.
 */
async function ipAllowed(flow: string, [limit, windowSeconds]: Limit): Promise<boolean> {
  const ip = await clientIp();
  return ip === "unknown" || (await rateLimit(`${flow}:ip:${ip}`, limit, windowSeconds)).allowed;
}
const emailKey = (flow: string, email: string) => `${flow}:email:${hashKey(email)}`;
const emailAllowed = (flow: string, email: string, [limit]: Limit) => rateLimitPeek(emailKey(flow, email), limit);
async function chargeEmail(flow: string, email: string, [limit, windowSeconds]: Limit): Promise<void> {
  await rateLimit(emailKey(flow, email), limit, windowSeconds);
}

const LIMITS = {
  signin: { ip: [20, 600], email: [10, 900] },
  signup: { ip: [5, 3600], email: [3, 3600] },
  reset: { ip: [5, 3600], email: [3, 3600] },
} as const satisfies Record<string, { ip: Limit; email: Limit }>;

async function withinLimits(flow: keyof typeof LIMITS, email: string): Promise<boolean> {
  return (await ipAllowed(flow, LIMITS[flow].ip)) && (await emailAllowed(flow, email, LIMITS[flow].email));
}

/**
 * Captcha: the Turnstile token goes to Supabase Auth as `options.captchaToken` and Supabase verifies it
 * ([auth.captcha] in config.toml), so calling Auth directly with the public key cannot skip it. Never verify the
 * same token here too: tokens are single use.
 * Returns where to go next; the form does a full page load so every client state (session, cache) restarts.
 */
export async function signIn(
  input: unknown,
  captchaToken?: string,
  next?: string,
): Promise<ActionResult<{ redirectTo: string }>> {
  const parsed = signInSchema.safeParse(input);
  if (!parsed.success) return fail("Dados inválidos", parsed.error.flatten().fieldErrors);
  if (!(await withinLimits("signin", parsed.data.email))) return tooMany();

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ ...parsed.data, options: { captchaToken } });
  if (error) {
    // Only a wrong password counts against the e-mail (the captcha passed); a missing/invalid token never does.
    if (error.code === "invalid_credentials") await chargeEmail("signin", parsed.data.email, LIMITS.signin.email);
    return fail(authErrorMessage("signin", error));
  }
  const target = safePath(next);
  // Two-step verification enrolled: this session is still aal1, so the code is asked before anything else.
  const enrolled = data.user?.factors?.some((factor) => factor.status === "verified");
  return {
    ok: true,
    data: { redirectTo: enrolled ? `/dois-fatores?next=${encodeURIComponent(target)}` : target },
  };
}

export async function signUp(input: unknown, captchaToken?: string): Promise<ActionResult> {
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) return fail("Dados inválidos", parsed.error.flatten().fieldErrors);
  if (!(await withinLimits("signup", parsed.data.email))) return tooMany();

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      captchaToken,
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/painel`,
    },
  });
  // Charged only when the captcha passed and an e-mail may have gone out.
  const existing = error?.code === "user_already_exists" || error?.code === "email_exists";
  if (!error || existing) await chargeEmail("signup", parsed.data.email, LIMITS.signup.email);
  if (error) {
    // Same answer as a new sign-up: the form must not reveal which e-mails already have an account.
    if (existing) {
      authErrorMessage("signup", error);
      return { ok: true };
    }
    return fail(authErrorMessage("signup", error));
  }
  return { ok: true };
}

/** Always "sent" unless the problem is on our side (limits, captcha, e-mail delivery): no account enumeration. */
export async function requestPasswordReset(input: unknown, captchaToken?: string): Promise<ActionResult> {
  const parsed = resetRequestSchema.safeParse(input);
  if (!parsed.success) return fail("E-mail inválido", parsed.error.flatten().fieldErrors);
  if (!(await withinLimits("reset", parsed.data.email))) return tooMany();

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    captchaToken,
    redirectTo: `${env.NEXT_PUBLIC_SITE_URL}/auth/callback?next=/redefinir-senha`,
  });
  if (!error) await chargeEmail("reset", parsed.data.email, LIMITS.reset.email);
  if (error) {
    const message = authErrorMessage("reset", error);
    const visible = ["captcha_failed", "over_request_rate_limit", "over_email_send_rate_limit"];
    if (visible.includes(error.code ?? "") || (error.status ?? 0) >= 500) return fail(message);
  }
  return { ok: true };
}

/**
 * Password change. Requires the current password unless this session came from a recovery/invite link in the
 * last hour. The current password is checked on a throwaway client (re-authentication); with
 * `secure_password_change` on, Supabase refuses password updates from sessions older than 24h, so the fresh
 * re-authenticated session performs the update in that case. Afterwards every other session (other devices and
 * the throwaway one) is signed out.
 */
export async function changePassword(
  input: unknown,
  captchaToken?: string,
): Promise<ActionResult<{ redirectTo: string }>> {
  const user = await requireUser("/painel/seguranca");
  const recovery = isRecoverySession(user);
  const parsed = recovery ? newPasswordSchema.safeParse(input) : changePasswordSchema.safeParse(input);
  if (!parsed.success) return fail("Confira os campos", parsed.error.flatten().fieldErrors);
  if (!(await rateLimitAll([[`password:${user.id}`, 5, 900]]))) return tooMany();

  const supabase = await createClient();
  let fresh: Awaited<ReturnType<typeof verifyPassword>> | null = null;
  if (!recovery) {
    const current = (parsed.data as { currentPassword?: string }).currentPassword;
    if (!user.email || !current) return fail("Informe a senha atual.");
    fresh = await verifyPassword(user.email, current, captchaToken);
    if (!fresh.ok) {
      return fresh.code === "invalid_credentials"
        ? fail("Senha atual incorreta.", { currentPassword: ["Senha atual incorreta"] })
        : fail(authErrorMessage("reauth", fresh));
    }
  }

  const password = parsed.data.password;
  let { error } = await supabase.auth.updateUser({ password });
  if (error?.code === "reauthentication_needed" && fresh?.ok) {
    ({ error } = await fresh.client.auth.updateUser({ password }));
  }
  if (error) {
    if (fresh?.ok) await fresh.client.auth.signOut({ scope: "local" });
    return fail(
      error.code === "insufficient_aal"
        ? "Por segurança, saia, entre de novo (com o código do autenticador) e repita a troca."
        : authErrorMessage("password", error),
    );
  }

  await supabase.auth.signOut({ scope: "others" });
  await audit({
    actorId: user.id,
    action: "user.password_changed",
    entity: "user",
    entityId: user.id,
    metadata: { via: recovery ? "recovery_link" : "current_password" },
    ip: await clientIp(),
  });
  return { ok: true, data: { redirectTo: "/painel" } };
}

export type MfaEnrollment = { factorId: string; qr: string; secret: string };

/**
 * Starts enrolling the FIRST authenticator (TOTP) on this session, after re-entering the password: a stolen
 * session cookie alone cannot attach the thief's authenticator through the app. Admin accounts are refused (their
 * factor must exist before promotion: see requireAdmin and README > Primeiro administrador). The code is then
 * confirmed in the browser (mfa.challengeAndVerify), which upgrades the session to aal2.
 */
export async function startMfaEnrollment(input: unknown, captchaToken?: string): Promise<ActionResult<MfaEnrollment>> {
  const user = await requireUser("/painel/seguranca");
  const parsed = reauthSchema.safeParse(input);
  if (!parsed.success) return fail("Informe sua senha", parsed.error.flatten().fieldErrors);
  if (!(await rateLimitAll([[`mfa-enroll:${user.id}`, 5, 900]]))) return tooMany();
  if (await hasVerifiedMfa()) return fail("A verificação em duas etapas já está ativa.");

  const supabase = await createClient();
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (profile?.role === "admin") {
    return fail("Contas de administrador ativam a verificação em duas etapas com o responsável técnico.");
  }
  if (!user.email) return fail("Sua conta não tem senha. Crie uma em “Esqueci a senha” e tente de novo.");
  const check = await verifyPassword(user.email, parsed.data.password, captchaToken);
  if (!check.ok) {
    return check.code === "invalid_credentials"
      ? fail("Senha incorreta.", { password: ["Senha incorreta"] })
      : fail(authErrorMessage("reauth", check));
  }
  await check.client.auth.signOut({ scope: "local" });

  // Abandoned enrollments stay as "unverified" factors and would conflict with a new one.
  const { data: factors } = await supabase.auth.mfa.listFactors();
  for (const factor of factors?.all ?? []) {
    if (factor.status === "unverified") await supabase.auth.mfa.unenroll({ factorId: factor.id });
  }
  const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: "Autenticador" });
  if (error) return fail(authErrorMessage("password", error));
  await audit({ actorId: user.id, action: "user.mfa_enrollment_started", entity: "user", entityId: user.id });
  return { ok: true, data: { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret } };
}

/**
 * Second step of the e-mail links (`/auth/confirm` page): the token is only spent by this POST, so link
 * scanners (Outlook Safe Links, antivirus) that GET the link cannot consume it before the user clicks.
 */
export async function confirmEmailLink(formData: FormData): Promise<void> {
  const parsed = confirmSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect("/entrar?erro=link");
  const { token_hash, type, next } = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type: type as EmailOtpType, token_hash });
  if (error) {
    authErrorMessage("confirm", error);
    redirect("/entrar?erro=link");
  }
  redirect(type === "recovery" || type === "invite" ? "/redefinir-senha" : safePath(next));
}

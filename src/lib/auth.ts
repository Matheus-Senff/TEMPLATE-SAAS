import "server-only";
import type { JwtPayload } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { cache } from "react";
import { env } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

/** Identity of the signed-in user, read from the verified access token (JWT claims). */
export type AuthUser = {
  id: string;
  email: string | null;
  /** Authenticator assurance level: "aal2" after a second factor (TOTP) in this session. */
  aal: string;
  /** How this session was authenticated (`password`, `oauth`, `recovery`, `totp`...), with UNIX timestamps. */
  amr: Array<{ method: string; timestamp: number | null }>;
  sessionId: string | null;
};

/** A session opened by a recovery or invite link may set a password without the current one, for this long. */
export const RECOVERY_WINDOW_SECONDS = 60 * 60;

export function toAuthUser(claims: JwtPayload): AuthUser {
  const amr = (claims.amr ?? []).map((entry) =>
    typeof entry === "string"
      ? { method: entry, timestamp: null }
      : { method: entry.method, timestamp: entry.timestamp },
  );
  return {
    id: claims.sub,
    email: claims.email ?? null,
    aal: claims.aal ?? "aal1",
    amr,
    sessionId: claims.session_id ?? null,
  };
}

/**
 * Signed-in user from `getClaims()` (cached per request). With asymmetric JWT signing keys (default in new
 * Supabase projects) the token is verified locally, with no network call to Auth; with the legacy HS256 secret
 * supabase-js falls back to asking Auth. A revoked session keeps a valid token until it expires (<= 1h), so
 * sensitive actions re-check the password (`verifyPassword`) instead of trusting the session alone.
 */
export const getUser = cache(async (): Promise<AuthUser | null> => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  return toAuthUser(data.claims);
});

/**
 * Two-step verification state of this session (cached per request): true when the session is aal2 or the user has
 * no verified factor. Costs one RPC only for aal1 sessions; the database enforces the same rule with restrictive
 * RLS policies (`public.mfa_satisfied()`), so the API cannot be used with the password alone either.
 */
export const isMfaSatisfied = cache(async (aal: string): Promise<boolean> => {
  if (aal === "aal2") return true;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("mfa_satisfied");
  if (error) throw new Error(`mfa_satisfied: ${error.message}`);
  return data === true;
});

/** Same as isMfaSatisfied but for "does this user have a verified factor at all". */
export const hasVerifiedMfa = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("has_verified_mfa");
  if (error) throw new Error(`has_verified_mfa: ${error.message}`);
  return data === true;
});

/**
 * Private pages and actions: redirects to /entrar when signed out, and to /dois-fatores when the user has
 * two-step verification but this session only used the password (aal1). Never rely on proxy.ts alone.
 * `allowPendingMfa` is only for the code-entry page itself.
 */
export async function requireUser(next = "/painel", { allowPendingMfa = false } = {}) {
  const user = await getUser();
  if (!user) redirect(`/entrar?next=${encodeURIComponent(next)}`);
  if (!allowPendingMfa && !(await isMfaSatisfied(user.aal))) {
    redirect(`/dois-fatores?next=${encodeURIComponent(next)}`);
  }
  return user;
}

/** True when this session came from a recovery/invite e-mail link opened in the last hour. */
export function isRecoverySession(user: AuthUser, now = Date.now()): boolean {
  return user.amr.some(
    ({ method, timestamp }) =>
      (method === "recovery" || method === "invite") &&
      (timestamp === null || now / 1000 - timestamp <= RECOVERY_WINDOW_SECONDS),
  );
}

/**
 * Platform admin area. Role lives in public.profiles (only the service role can change it). With
 * ADMIN_REQUIRE_MFA (default on in production builds) the session must be aal2. Admins WITH a factor never get
 * here at aal1 (requireUser sends them to /dois-fatores). An admin account whose factor did not exist when it was
 * promoted (none, or enrolled later by whoever has the password) is refused, with no self-enrolment path:
 * admins are bootstrapped out of band (README: enrol as a member first, then promote; promotion requires a factor).
 */
export async function requireAdmin(next = "/admin") {
  const user = await requireUser(next);
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("role").eq("id", user.id).single();
  if (data?.role !== "admin") redirect("/painel");
  if (env.ADMIN_REQUIRE_MFA) {
    // aal2 AND a factor that predates the promotion (public.admin_mfa_trusted, see the migration).
    const { data: trusted, error } = await supabase.rpc("admin_mfa_trusted");
    if (error) throw new Error(`admin_mfa_trusted: ${error.message}`);
    if (user.aal !== "aal2" || trusted !== true) redirect("/painel/seguranca?mfa=admin-sem-fator");
  }
  return user;
}

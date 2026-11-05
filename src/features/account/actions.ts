"use server";

import { authErrorMessage } from "@/features/auth/errors";
import { cancelCustomerBilling } from "@/features/billing/service";
import { stripe } from "@/features/billing/stripe";
import { FILES_BUCKET } from "@/features/files/config";
import { listAllFiles, removeFiles } from "@/features/files/storage";
import { orgsOnlyOwnedBy } from "@/features/organizations/service";
import { fail, type ActionResult } from "@/lib/action";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { reportError } from "@/lib/log";
import { rateLimit } from "@/lib/rate-limit";
import { verifyPassword } from "@/lib/reauth";
import { clientIp } from "@/lib/request";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/supabase/paginate";
import { createClient } from "@/lib/supabase/server";
import { deleteAccountSchema } from "./schema";

/**
 * LGPD portability: everything stored about the signed-in user. Tables with RLS are read as the user; the audit
 * trail is server-only, so the user's own rows (as actor or as subject) are read with the service role.
 * Every list is paginated (PostgREST returns at most 1000 rows per request).
 */
export async function exportMyData(): Promise<ActionResult<Record<string, unknown>>> {
  const user = await requireUser();
  if (!(await rateLimit(`export:${user.id}`, 5, 3600)).allowed) return fail("Muitas exportações. Tente mais tarde.");
  const supabase = await createClient();
  const admin = createAdminClient();
  try {
    const [profile, organizations, memberships, notifications, subscriptions, auditLogs, files] = await Promise.all([
      supabase.from("profiles").select("*").eq("id", user.id).single(),
      fetchAllRows((from, to) =>
        supabase.from("organizations").select("id, name, personal_owner_id, created_at").order("id").range(from, to),
      ),
      fetchAllRows((from, to) =>
        supabase.from("memberships").select("*").eq("user_id", user.id).order("org_id").range(from, to),
      ),
      fetchAllRows((from, to) =>
        supabase.from("notifications").select("*").order("created_at").order("id").range(from, to),
      ),
      fetchAllRows((from, to) =>
        supabase.from("subscriptions").select("*").order("created_at").order("id").range(from, to),
      ),
      fetchAllRows((from, to) =>
        admin
          .from("audit_logs")
          .select("action, entity, entity_id, metadata, ip, created_at")
          .or(`actor_id.eq.${user.id},entity_id.eq.${user.id}`)
          .order("created_at")
          .order("id")
          .range(from, to),
      ),
      listAllFiles(supabase, FILES_BUCKET, user.id),
    ]);
    await audit({
      actorId: user.id,
      action: "user.data_exported",
      entity: "user",
      entityId: user.id,
      ip: await clientIp(),
    });
    return {
      ok: true,
      data: {
        exportedAt: new Date().toISOString(),
        account: { id: user.id, email: user.email, createdAt: profile.data?.created_at ?? null },
        profile: profile.data,
        organizations,
        memberships,
        notifications,
        subscriptions,
        auditLogs,
        files,
      },
    };
  } catch (error) {
    reportError("account.export", error, { userId: user.id });
    return fail("Não foi possível gerar a exportação agora. Tente novamente.");
  }
}

/**
 * LGPD erasure, after re-authentication with the current password. Order matters: the local steps that can fail
 * first (files, queued jobs and pending invitations holding the e-mail, audit trail anonymized), then Stripe
 * (subscriptions cancelled, customer deleted, stored customer id cleared at once so the account never points to a
 * deleted customer), then the auth user (cascades to profile, personal organization, memberships, notifications,
 * subscriptions). Every step is idempotent: if one fails the account still works and a retry finishes the job.
 * Refused while the user is the only owner of a team organization.
 */
export async function deleteMyAccount(input: unknown, captchaToken?: string): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = deleteAccountSchema.safeParse(input);
  if (!parsed.success) return fail("Informe sua senha", parsed.error.flatten().fieldErrors);
  if (!(await rateLimit(`delete:${user.id}`, 5, 3600)).allowed) return fail("Muitas tentativas. Tente mais tarde.");
  if (!user.email) return fail("Sua conta não tem e-mail e senha. Fale com o suporte para excluí-la.");

  const check = await verifyPassword(user.email, parsed.data.password, captchaToken);
  if (!check.ok) {
    return check.code === "invalid_credentials"
      ? fail("Senha incorreta.", { password: ["Senha incorreta"] })
      : fail(authErrorMessage("reauth", check));
  }

  const admin = createAdminClient();
  try {
    if ((await orgsOnlyOwnedBy(user.id)).length > 0) {
      return fail("Você é o único dono de uma organização. Transfira a propriedade ou exclua a organização antes.");
    }
    const paths = (await listAllFiles(admin, FILES_BUCKET, user.id)).map((f) => f.path);
    await removeFiles(admin, FILES_BUCKET, paths);

    const cleanup = await Promise.all([
      admin.from("audit_logs").update({ actor_id: null, ip: null }).eq("actor_id", user.id),
      admin.from("audit_logs").update({ entity_id: null }).eq("entity_id", user.id),
      admin.from("jobs").delete().eq("user_id", user.id),
      admin.from("invitations").delete().eq("email", user.email.toLowerCase()).is("accepted_at", null),
    ]);
    const cleanupError = cleanup.find((result) => result.error)?.error;
    if (cleanupError) throw new Error(cleanupError.message);

    // Stripe customer of the personal organization (team organizations were checked above).
    const { data: org, error: orgError } = await admin
      .from("organizations")
      .select("stripe_customer_id")
      .eq("personal_owner_id", user.id)
      .maybeSingle();
    if (orgError) throw new Error(orgError.message);
    const customer = org?.stripe_customer_id;
    if (stripe && customer) {
      await cancelCustomerBilling(customer);
      const { error: clearError } = await admin
        .from("organizations")
        .update({ stripe_customer_id: null })
        .eq("personal_owner_id", user.id);
      if (clearError) throw new Error(clearError.message);
    }

    const { error } = await admin.auth.admin.deleteUser(user.id);
    if (error) throw new Error(error.message);
    await audit({ actorId: null, action: "user.deleted", entity: "user", metadata: { files: paths.length } });
  } catch (error) {
    reportError("account.delete", error, { userId: user.id });
    return fail("Não foi possível excluir a conta agora. Tente novamente.");
  }
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  return { ok: true };
}

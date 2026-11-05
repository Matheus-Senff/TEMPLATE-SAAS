"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { fail, type ActionResult } from "@/lib/action";
import { audit } from "@/lib/audit";
import { requireUser } from "@/lib/auth";
import { env } from "@/lib/env";
import { enqueue } from "@/lib/jobs";
import { reportError } from "@/lib/log";
import { notify } from "@/lib/notifications";
import { rateLimit, rateLimitAll } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { acceptInvitationSchema, createOrganizationSchema, inviteMemberSchema } from "./schema";
import { hashInvitationToken, invitationEmail } from "./service";

/**
 * Team organization owned by the caller. Organization + owner membership are written by the service role
 * (users have no insert grant on these tables) and undone together if the second write fails.
 */
export async function createOrganization(input: unknown): Promise<ActionResult<{ orgId: string }>> {
  const user = await requireUser();
  const parsed = createOrganizationSchema.safeParse(input);
  if (!parsed.success) return fail("Confira os campos", parsed.error.flatten().fieldErrors);
  if (!(await rateLimit(`org:create:${user.id}`, 3, 86_400)).allowed) {
    return fail("Limite de novas organizações por dia atingido. Tente amanhã.");
  }

  const admin = createAdminClient();
  const { data: org, error } = await admin
    .from("organizations")
    .insert({ name: parsed.data.name })
    .select("id")
    .single();
  if (error) return fail("Não foi possível criar a organização.");
  const { error: memberError } = await admin
    .from("memberships")
    .insert({ org_id: org.id, user_id: user.id, role: "owner" });
  if (memberError) {
    await admin.from("organizations").delete().eq("id", org.id);
    return fail("Não foi possível criar a organização.");
  }
  await audit({ actorId: user.id, action: "org.created", entity: "organization", entityId: org.id });
  return { ok: true, data: { orgId: org.id } };
}

/**
 * Invites someone by e-mail (owners/admins only, checked with `has_org_role` as the caller, so RLS rules apply).
 * Anti-abuse: the inviter's e-mail must be confirmed, limits per inviter and per organization, fixed subject.
 * The link carries a random token; only its hash is stored. The e-mail goes through the durable job queue.
 */
export async function inviteMember(input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = inviteMemberSchema.safeParse(input);
  if (!parsed.success) return fail("Confira os campos", parsed.error.flatten().fieldErrors);
  const { orgId, email, role } = parsed.data;

  const supabase = await createClient();
  const { data: allowed } = await supabase.rpc("has_org_role", { org: orgId, role: "admin" });
  if (!allowed) return fail("Só administradores da organização podem convidar.");
  const withinLimits = await rateLimitAll([
    [`org:invite:${user.id}`, 10, 3600],
    [`org:invite:org:${orgId}`, 30, 86_400],
  ]);
  if (!withinLimits) return fail("Muitos convites. Tente mais tarde.");

  const admin = createAdminClient();
  const { data: account } = await admin.auth.admin.getUserById(user.id);
  if (!account.user?.email_confirmed_at) return fail("Confirme seu e-mail antes de convidar pessoas.");

  const token = randomBytes(32).toString("base64url");
  const [{ data: org }, { data: inviter }] = await Promise.all([
    admin.from("organizations").select("name").eq("id", orgId).single(),
    admin.from("profiles").select("full_name, email").eq("id", user.id).single(),
  ]);
  const { error } = await admin.from("invitations").insert({
    org_id: orgId,
    email,
    role,
    token_hash: hashInvitationToken(token),
    invited_by: user.id,
  });
  if (error) return fail("Não foi possível criar o convite.");

  const link = `${env.NEXT_PUBLIC_SITE_URL}/convite?token=${token}`;
  const inviterName = inviter?.full_name ? `${inviter.full_name} (${inviter.email})` : (inviter?.email ?? "Alguém");
  try {
    await enqueue("email.send", {
      to: email,
      ...invitationEmail({ inviter: inviterName, orgName: org?.name ?? "uma organização", link }),
    });
  } catch (enqueueError) {
    reportError("org.invite", enqueueError, { orgId });
    return fail("Convite criado, mas o e-mail não pôde ser enviado. Tente novamente.");
  }
  await audit({
    actorId: user.id,
    action: "org.member_invited",
    entity: "organization",
    entityId: orgId,
    metadata: { role },
    ip: await clientIp(),
  });
  return { ok: true };
}

/**
 * Accepts an invitation (form on /convite). The signed-in e-mail must be the invited one; the token must be
 * unused and not expired. Membership is written by the service role, then the user lands on the dashboard.
 */
export async function acceptInvitation(formData: FormData): Promise<void> {
  const user = await requireUser("/painel");
  const parsed = acceptInvitationSchema.safeParse({ token: formData.get("token") });
  if (!parsed.success) redirect("/painel?convite=invalido");

  const admin = createAdminClient();
  const { data: invitation } = await admin
    .from("invitations")
    .select("id, org_id, email, role, invited_by")
    .eq("token_hash", hashInvitationToken(parsed.data.token))
    .is("accepted_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle();
  if (!invitation || invitation.email !== user.email?.toLowerCase()) redirect("/painel?convite=invalido");

  const { error } = await admin
    .from("memberships")
    .upsert(
      { org_id: invitation.org_id, user_id: user.id, role: invitation.role },
      { onConflict: "org_id,user_id", ignoreDuplicates: true },
    );
  if (error) {
    reportError("org.accept", error, { orgId: invitation.org_id });
    redirect("/painel?convite=erro");
  }
  await admin.from("invitations").update({ accepted_at: new Date().toISOString() }).eq("id", invitation.id);
  await audit({ actorId: user.id, action: "org.member_joined", entity: "organization", entityId: invitation.org_id });
  if (invitation.invited_by) {
    await notify(invitation.invited_by, { type: "success", title: "Convite aceito", link: "/painel" });
  }
  redirect("/painel?convite=aceito");
}

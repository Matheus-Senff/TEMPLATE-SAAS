import "server-only";
import { createHash } from "node:crypto";
import { emailLayout, escapeHtml } from "@/lib/email";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type OrgRole = "owner" | "admin" | "member";
export type ActiveOrg = {
  id: string;
  name: string;
  personal: boolean;
  stripeCustomerId: string | null;
  role: OrgRole;
};

const RANK: Record<OrgRole, number> = { owner: 3, admin: 2, member: 1 };
export const hasRole = (role: string, min: OrgRole) => (RANK[role as OrgRole] ?? 0) >= RANK[min];

/**
 * Organization the signed-in user is working in. Today: the personal organization created at sign-up (individual
 * account and billing). For B2B, keep the chosen org id in a cookie or in the URL (`/org/[id]/...`) and validate
 * it here with a membership read (RLS) before trusting it. Read with the user's client, so RLS applies.
 */
export async function getActiveOrg(userId: string): Promise<ActiveOrg> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("id, name, personal_owner_id, stripe_customer_id, memberships!inner(role, user_id)")
    .eq("personal_owner_id", userId)
    .eq("memberships.user_id", userId)
    .single();
  if (error) throw new Error(`getActiveOrg: ${error.message}`);
  return {
    id: data.id,
    name: data.name,
    personal: data.personal_owner_id === userId,
    stripeCustomerId: data.stripe_customer_id,
    role: (data.memberships[0]?.role ?? "member") as OrgRole,
  };
}

/** Owners and admins of an organization (who receives billing notifications). */
export async function orgAdminIds(orgId: string): Promise<string[]> {
  const { data, error } = await createAdminClient()
    .from("memberships")
    .select("user_id, role")
    .eq("org_id", orgId)
    .in("role", ["owner", "admin"]);
  if (error) throw new Error(`orgAdminIds: ${error.message}`);
  return (data ?? []).map((m) => m.user_id);
}

/**
 * Team organizations that would be left without an owner if this user disappeared. Account deletion refuses while
 * there are any (transfer ownership or delete the organization first); personal organizations go with the user.
 */
export async function orgsOnlyOwnedBy(userId: string): Promise<string[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("memberships")
    .select("org_id, organizations!inner(personal_owner_id)")
    .eq("user_id", userId)
    .eq("role", "owner")
    .is("organizations.personal_owner_id", null);
  if (error) throw new Error(`orgsOnlyOwnedBy: ${error.message}`);
  const blocked: string[] = [];
  for (const { org_id } of data ?? []) {
    const { count } = await admin
      .from("memberships")
      .select("user_id", { count: "exact", head: true })
      .eq("org_id", org_id)
      .eq("role", "owner");
    if ((count ?? 0) <= 1) blocked.push(org_id);
  }
  return blocked;
}

/** Invitation tokens travel only in the e-mail; the database keeps their SHA-256. */
export const hashInvitationToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Invitation shown on /convite, valid only for the invited e-mail, unused and not expired. Service role: the
 * visitor is not a member of the organization yet, so RLS would hide it.
 */
export async function describeInvitation(token: string, email: string | null): Promise<{ orgName: string } | null> {
  if (!token || !email) return null;
  const { data } = await createAdminClient()
    .from("invitations")
    .select("email, accepted_at, expires_at, organizations(name)")
    .eq("token_hash", hashInvitationToken(token))
    .maybeSingle();
  const valid =
    data && !data.accepted_at && new Date(data.expires_at) > new Date() && data.email === email.toLowerCase();
  return valid ? { orgName: data.organizations?.name ?? "uma organização" } : null;
}

/** Text of the invitation e-mail: who invites, to what. Names are user-controlled: escaped and shortened. */
export function invitationEmail(input: { inviter: string; orgName: string; link: string }) {
  const short = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);
  const inviter = short(input.inviter, 80);
  const orgName = short(input.orgName, 60);
  return {
    // Fixed subject: an attacker-chosen organization name never shows up in the inbox list.
    subject: "Você recebeu um convite",
    html: emailLayout(
      "Você recebeu um convite",
      `<p>${escapeHtml(inviter)} convidou você para participar de <strong>${escapeHtml(orgName)}</strong>.</p>` +
        `<p>O link vale por 7 dias.</p><p><a href="${escapeHtml(input.link)}">Aceitar convite</a></p>` +
        `<p style="font-size:12px;color:#666">Não conhece quem enviou? Ignore este e-mail.</p>`,
    ),
    text: `${inviter} convidou você para participar de "${orgName}": ${input.link} (válido por 7 dias). Não conhece quem enviou? Ignore este e-mail.`,
  };
}

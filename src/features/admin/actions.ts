"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { fail, type ActionResult } from "@/lib/action";
import { audit } from "@/lib/audit";
import { requireAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { notify } from "@/lib/notifications";
import { clientIp } from "@/lib/request";
import { createAdminClient } from "@/lib/supabase/admin";

const input = z.object({ userId: z.string().uuid(), role: z.enum(["admin", "member"]) });

/** Promotes or demotes a user. Admin only, audited, and an admin cannot demote themselves. */
export async function setUserRole(values: unknown): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = input.safeParse(values);
  if (!parsed.success) return fail("Dados inválidos");
  const { userId, role } = parsed.data;
  if (userId === admin.id) return fail("Você não pode alterar o próprio papel.");

  const client = createAdminClient();
  if (role === "admin" && env.ADMIN_REQUIRE_MFA) {
    // The factor must exist BEFORE the promotion (public.admin_mfa_trusted): ask the person to enable it first.
    const { data: enrolled, error: mfaError } = await client.rpc("user_has_verified_mfa", { p_user: userId });
    if (mfaError) return fail("Não foi possível alterar o papel.");
    if (!enrolled)
      return fail("A pessoa precisa ativar a verificação em duas etapas (Segurança) antes de virar admin.");
  }
  const { error } = await client.from("profiles").update({ role }).eq("id", userId);
  if (error) return fail("Não foi possível alterar o papel.");
  await audit({
    actorId: admin.id,
    action: "user.role_changed",
    entity: "user",
    entityId: userId,
    metadata: { role },
    ip: await clientIp(),
  });
  await notify(userId, {
    type: "info",
    title: role === "admin" ? "Você agora é administrador" : "Seu acesso de administrador foi removido",
  });
  revalidatePath("/admin");
  return { ok: true };
}

/** Gives a dead background job one more attempt (it runs on the next worker pass or cron). Admin only. */
export async function retryJob(jobId: unknown): Promise<ActionResult> {
  const admin = await requireAdmin();
  const parsed = z.string().uuid().safeParse(jobId);
  if (!parsed.success) return fail("Dados inválidos");
  const { error } = await createAdminClient().rpc("retry_job", { p_id: parsed.data });
  if (error) return fail("Não foi possível reenfileirar o job.");
  await audit({ actorId: admin.id, action: "job.retried", entity: "job", entityId: parsed.data });
  revalidatePath("/admin");
  return { ok: true };
}

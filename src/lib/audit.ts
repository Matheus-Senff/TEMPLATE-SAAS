import "server-only";
import type { Json } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";

export type AuditEntry = {
  actorId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, Json>;
  ip?: string | null;
};

/** Appends to public.audit_logs (server-only table). Never throws; no personal data in metadata. */
export async function audit(entry: AuditEntry): Promise<void> {
  const { error } = await createAdminClient()
    .from("audit_logs")
    .insert({
      actor_id: entry.actorId,
      action: entry.action,
      entity: entry.entity,
      entity_id: entry.entityId ?? null,
      metadata: entry.metadata ?? null,
      ip: entry.ip ?? null,
    });
  if (error) console.warn(`audit: failed to record "${entry.action}"`, error.message);
}

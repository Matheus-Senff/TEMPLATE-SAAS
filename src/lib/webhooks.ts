import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/** A claim without processed_at older than this is treated as a crashed attempt and retried. */
const STALE_CLAIM_MS = 5 * 60 * 1000;

/**
 * - `processed`: the handler ran now and succeeded (answer 2xx).
 * - `duplicate`: an earlier delivery already finished it (answer 2xx so the provider stops retrying).
 * - `in_progress`: another delivery holds a fresh claim and has not finished yet. Answer non-2xx (409) so the
 *   provider retries later: if that attempt crashed, the retry takes over its stale claim instead of being lost.
 */
export type ProcessOutcome = "processed" | "duplicate" | "in_progress";

/**
 * Runs `handler` at most once per (source, id): providers retry and may deliver twice.
 * The id is claimed first; if the handler fails, the claim is released so the retry runs it again.
 * If a previous attempt died mid-way (timeout), its stale claim is taken over on the next delivery.
 * Only a finished event (`processed_at` set) counts as a duplicate.
 */
export async function processOnce(
  source: string,
  id: string,
  type: string,
  handler: () => Promise<void>,
): Promise<{ outcome: ProcessOutcome }> {
  const admin = createAdminClient();
  const { error } = await admin.from("webhook_events").insert({ source, id, type });
  if (error) {
    if (error.code !== "23505") throw new Error(`processOnce(): ${error.message}`);
    const { data: stale, error: staleError } = await admin
      .from("webhook_events")
      .update({ created_at: new Date().toISOString() })
      .eq("source", source)
      .eq("id", id)
      .is("processed_at", null)
      .lt("created_at", new Date(Date.now() - STALE_CLAIM_MS).toISOString())
      .select("id");
    if (staleError) throw new Error(`processOnce(): ${staleError.message}`);
    if (!stale?.length) {
      const { data: existing, error: readError } = await admin
        .from("webhook_events")
        .select("processed_at")
        .eq("source", source)
        .eq("id", id)
        .maybeSingle();
      if (readError) throw new Error(`processOnce(): ${readError.message}`);
      // Finished before: duplicate. Fresh claim still running (or just released by a failure): retry later.
      return { outcome: existing?.processed_at ? "duplicate" : "in_progress" };
    }
  }
  try {
    await handler();
  } catch (handlerError) {
    await admin.from("webhook_events").delete().eq("source", source).eq("id", id);
    throw handlerError;
  }
  const { error: doneError } = await admin
    .from("webhook_events")
    .update({ processed_at: new Date().toISOString() })
    .eq("source", source)
    .eq("id", id);
  if (doneError) throw new Error(`processOnce(): ${doneError.message}`);
  return { outcome: "processed" };
}

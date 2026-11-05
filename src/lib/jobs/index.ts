import "server-only";
import { after } from "next/server";
import { reportError } from "@/lib/log";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";
import { jobHandlers, type JobPayload, type JobType } from "./handlers";

export type EnqueueOptions = {
  /** Run no earlier than this. Default: now. */
  runAt?: Date;
  /** Same key again = no new job while the first one exists (e.g. `welcome-<userId>`). */
  idempotencyKey?: string;
  /** Attempts before the job is marked "dead". Default 5. */
  maxAttempts?: number;
  /** Owner of personal data in the payload: the job is erased with the account. */
  userId?: string;
};

/** Exponential backoff between attempts: 30s, 1min, 2min, 4min... capped at 6h. */
export const backoffSeconds = (attempt: number) => Math.min(30 * 2 ** Math.max(0, attempt - 1), 6 * 60 * 60);

/** A worker that dies leaves its jobs "running"; after this many seconds another run takes them over. */
const LOCK_SECONDS = 300;

/**
 * Durable background work: the job is stored in Postgres BEFORE anything is attempted, then processed right after
 * the response (`after()`); whatever fails is retried with backoff by later runs and /api/cron/jobs.
 * Use instead of calling e-mail/integrations directly in a request. Returns the job id (null if deduplicated).
 */
export async function enqueue<T extends JobType>(
  type: T,
  payload: JobPayload<T>,
  { runAt, idempotencyKey, maxAttempts, userId }: EnqueueOptions = {},
): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("jobs")
    .upsert(
      {
        type,
        payload: payload as unknown as NonNullable<Json>,
        run_at: (runAt ?? new Date()).toISOString(),
        idempotency_key: idempotencyKey ?? null,
        max_attempts: maxAttempts ?? 5,
        user_id: userId ?? null,
      },
      { onConflict: "idempotency_key", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw new Error(`enqueue(${type}): ${error.message}`);
  const id = data?.[0]?.id ?? null;
  if (id && !runAt) kick();
  return id;
}

/** Processes due jobs after the response is sent; outside a request (scripts) the cron picks them up. */
function kick() {
  try {
    after(() => runJobs({ limit: 5 }));
  } catch {
    // Not inside a request scope: nothing to do, the job is already stored.
  }
}

export type RunSummary = { claimed: number; done: number; retried: number; dead: number };

/** Claims due jobs (`for update skip locked`), runs their handlers and records done / retry / dead. */
export async function runJobs({ limit = 10, budgetMs = 25_000 } = {}): Promise<RunSummary> {
  const started = Date.now();
  const admin = createAdminClient();
  const summary: RunSummary = { claimed: 0, done: 0, retried: 0, dead: 0 };
  while (Date.now() - started < budgetMs) {
    const { data: jobs, error } = await admin.rpc("claim_jobs", {
      p_limit: Math.min(limit - summary.claimed, 10),
      p_lock_seconds: LOCK_SECONDS,
    });
    if (error) throw new Error(`runJobs: ${error.message}`);
    if (!jobs?.length) break;
    summary.claimed += jobs.length;
    for (const job of jobs) {
      const handler = jobHandlers[job.type as JobType] as
        ((payload: unknown, ctx: { id: string; attempts: number }) => Promise<void>) | undefined;
      try {
        if (!handler) throw new Error(`no handler for job type "${job.type}"`);
        await handler(job.payload, { id: job.id, attempts: job.attempts });
        const { error: doneError } = await admin.rpc("complete_job", { p_id: job.id });
        if (doneError) throw new Error(doneError.message);
        summary.done++;
      } catch (jobError) {
        const message = jobError instanceof Error ? jobError.message : String(jobError);
        const { data: status } = await admin.rpc("fail_job", {
          p_id: job.id,
          p_error: message,
          p_retry_in_seconds: backoffSeconds(job.attempts),
        });
        if (status === "dead") {
          summary.dead++;
          reportError("jobs", jobError, { jobId: job.id, type: job.type, attempts: job.attempts });
        } else {
          summary.retried++;
        }
      }
    }
    if (summary.claimed >= limit) break;
  }
  return summary;
}

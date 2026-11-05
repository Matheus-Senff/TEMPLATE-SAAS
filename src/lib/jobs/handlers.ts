import "server-only";
import { sendEmail, type EmailMessage } from "@/lib/email";

export type JobContext = { id: string; attempts: number };

/**
 * Job types and what they do. A handler must be safe to run more than once (a worker can die after the work and
 * before marking it done): use the job id as idempotency key with external APIs, as below.
 * New type: add it here; `enqueue()` is typed from this map.
 */
export const jobHandlers = {
  "email.send": async (payload: Omit<EmailMessage, "idempotencyKey">, job: JobContext) => {
    await sendEmail({ ...payload, idempotencyKey: `job-${job.id}` });
  },
} satisfies Record<string, (payload: never, job: JobContext) => Promise<void>>;

export type JobType = keyof typeof jobHandlers;
export type JobPayload<T extends JobType> = Parameters<(typeof jobHandlers)[T]>[0];

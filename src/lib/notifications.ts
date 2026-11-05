import "server-only";
import { emailLayout, escapeHtml } from "@/lib/email";
import { env } from "@/lib/env";
import { enqueue } from "@/lib/jobs";
import { isSafePath } from "@/lib/redirect";
import { createAdminClient } from "@/lib/supabase/admin";

export type NotificationType = "info" | "success" | "warning" | "error";
export type NotifyInput = { type?: NotificationType; title: string; body?: string; link?: string };
export type NotifyOptions = {
  /** Critical events (payment failed, security): also e-mail the user, through the durable job queue. */
  email?: boolean;
  /**
   * Same key = same notification (e.g. `${event.id}:${userId}` in webhooks): a redelivery or a retried job after
   * a partial failure neither duplicates the bell nor the e-mail.
   */
  idempotencyKey?: string;
};

function notificationEmail(input: NotifyInput) {
  const link = input.link ? `${env.NEXT_PUBLIC_SITE_URL}${input.link}` : env.NEXT_PUBLIC_SITE_URL;
  const body = input.body ? `<p style="line-height:1.5">${escapeHtml(input.body)}</p>` : "";
  return {
    subject: input.title,
    html: emailLayout(input.title, `${body}<p><a href="${escapeHtml(link)}">Abrir</a></p>`),
    text: `${input.title}\n\n${input.body ?? ""}\n\n${link}`,
  };
}

/**
 * Creates an in-app notification (bell). Delivered in real time through Supabase Realtime Broadcast (only the
 * owner can join the channel). Call from Server Actions, webhooks and cron whenever something the user cares about
 * happens; `{ email: true }` also queues an e-mail (retried if the provider fails). Pass `idempotencyKey` from any
 * code that can run twice (webhooks, jobs, cron).
 * Returns false (and does nothing) when the user no longer exists: webhooks and jobs about deleted accounts must
 * finish instead of failing and being retried forever.
 */
export async function notify(userId: string, input: NotifyInput, options: NotifyOptions = {}): Promise<boolean> {
  if (input.link && !isSafePath(input.link)) {
    throw new Error("notify(): link must be a relative path");
  }
  const admin = createAdminClient();
  const { error } = await admin.from("notifications").insert({
    user_id: userId,
    type: input.type ?? "info",
    title: input.title,
    body: input.body,
    link: input.link,
    idempotency_key: options.idempotencyKey ?? null,
  });
  if (error?.code === "23503") {
    console.warn("notify(): user no longer exists, skipped");
    return false;
  }
  // Already created by an earlier delivery: keep going so a missing e-mail job still gets queued (deduplicated too).
  const duplicate = error?.code === "23505" && Boolean(options.idempotencyKey);
  if (error && !duplicate) throw new Error(`notify(): ${error.message}`);

  if (options.email) {
    const { data: profile } = await admin.from("profiles").select("email").eq("id", userId).maybeSingle();
    if (profile?.email) {
      await enqueue(
        "email.send",
        { to: profile.email, ...notificationEmail(input) },
        { userId, ...(options.idempotencyKey && { idempotencyKey: `notify:${options.idempotencyKey}` }) },
      );
    }
  }
  return true;
}

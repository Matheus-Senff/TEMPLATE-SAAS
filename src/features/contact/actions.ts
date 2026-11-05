"use server";

import { fail, type ActionResult } from "@/lib/action";
import { emailLayout, escapeHtml } from "@/lib/email";
import { env } from "@/lib/env";
import { enqueue } from "@/lib/jobs";
import { reportError } from "@/lib/log";
import { hashKey, rateLimitAll } from "@/lib/rate-limit";
import { clientIp } from "@/lib/request";
import { verifyTurnstile } from "@/lib/turnstile";
import { contactSchema, type ContactInput } from "./schema";

function contactEmail(input: ContactInput) {
  const rows = [
    ["Nome", input.name],
    ["E-mail", input.email],
    ["Telefone", input.phone || "-"],
  ]
    .map(([label, value]) => `<p style="margin:0 0 4px"><strong>${label}:</strong> ${escapeHtml(value ?? "")}</p>`)
    .join("");
  return {
    subject: `Novo contato: ${input.name}`,
    html: emailLayout(
      "Nova mensagem de contato",
      `${rows}<p style="white-space:pre-wrap">${escapeHtml(input.message)}</p>`,
    ),
    text: `${input.name} <${input.email}> ${input.phone ?? ""}\n\n${input.message}`,
  };
}

/**
 * Public form: Turnstile + rate limit per IP and per e-mail. The e-mail is a durable job (public.jobs): stored
 * before answering "sent", delivered right after the response and retried with backoff if Resend fails.
 */
export async function sendContact(input: unknown, captchaToken?: string): Promise<ActionResult> {
  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) return fail("Confira os campos", parsed.error.flatten().fieldErrors);
  if (parsed.data.website) return { ok: true };

  const ip = await clientIp();
  if (!(await verifyTurnstile(captchaToken, ip))) return fail("Confirme que você não é um robô.");
  const limits = [
    [`contact:ip:${ip}`, 5, 600] as const,
    [`contact:email:${hashKey(parsed.data.email)}`, 3, 600] as const,
  ];
  if (!(await rateLimitAll(limits))) return fail("Muitas mensagens. Tente mais tarde.");

  const data = parsed.data;
  if (!env.CONTACT_EMAIL) {
    console.info("[contact] CONTACT_EMAIL not set; message received");
    return { ok: true };
  }
  try {
    await enqueue("email.send", { to: env.CONTACT_EMAIL, replyTo: data.email, ...contactEmail(data) });
  } catch (error) {
    reportError("contact", error);
    return fail("Não foi possível enviar agora. Tente novamente em instantes.");
  }
  return { ok: true };
}

"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getActiveOrg, hasRole } from "@/features/organizations/service";
import { fail, type ActionResult } from "@/lib/action";
import { requireUser } from "@/lib/auth";
import { reportError } from "@/lib/log";
import { rateLimit } from "@/lib/rate-limit";
import { BillingError, createCheckoutSession, createPortalSession } from "./service";

const checkoutInput = z.object({
  priceId: z.string().startsWith("price_"),
  mode: z.enum(["payment", "subscription"]).default("subscription"),
});

/**
 * Runs a Stripe call and redirects to the URL it returns. Any failure becomes `fail()` with a message the user
 * can act on (never the error page); unexpected errors go to Sentry. `redirect()` stays outside the try/catch
 * because it works by throwing.
 */
async function withBilling(userId: string, scope: string, run: () => Promise<string>): Promise<ActionResult> {
  // Fail open on purpose: Stripe rate-limits its own API and nothing here is sensitive to brute force.
  if (!(await rateLimit(`billing:${userId}`, 10, 60, { failOpen: true })).allowed) {
    return fail("Muitas tentativas. Aguarde um minuto.");
  }
  let url: string;
  try {
    url = await run();
  } catch (error) {
    if (error instanceof BillingError) return fail(error.message);
    reportError(scope, error, { userId });
    return fail("Não foi possível falar com o sistema de pagamento agora. Tente novamente em instantes.");
  }
  redirect(url);
}

const NOT_ADMIN = "Só administradores da organização gerenciam a assinatura.";

/** Billing is per organization (the active one); only its owners/admins start checkout or open the portal. */
export async function startCheckout(input: z.input<typeof checkoutInput>): Promise<ActionResult> {
  const user = await requireUser();
  const parsed = checkoutInput.safeParse(input);
  if (!parsed.success) return fail("Plano inválido");
  const org = await getActiveOrg(user.id);
  if (!hasRole(org.role, "admin")) return fail(NOT_ADMIN);
  return withBilling(user.id, "billing.checkout", () =>
    createCheckoutSession({ orgId: org.id, userId: user.id, email: user.email ?? undefined, ...parsed.data }),
  );
}

export async function openBillingPortal(): Promise<ActionResult> {
  const user = await requireUser();
  const org = await getActiveOrg(user.id);
  if (!hasRole(org.role, "admin")) return fail(NOT_ADMIN);
  return withBilling(user.id, "billing.portal", () => createPortalSession(org.id));
}

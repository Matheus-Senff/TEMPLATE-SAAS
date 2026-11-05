import "server-only";
import type Stripe from "stripe";
import { orgAdminIds } from "@/features/organizations/service";
import { audit } from "@/lib/audit";
import { reportError } from "@/lib/log";
import { notify, type NotifyInput } from "@/lib/notifications";
import { createAdminClient } from "@/lib/supabase/admin";
import { billingConfig, stripe } from "./stripe";

/**
 * Billing belongs to an ORGANIZATION (organizations.stripe_customer_id, subscriptions.org_id). Every user has a
 * personal organization, so individual accounts work the same way; teams share one subscription.
 */

/** Statuses that still hold (or may recover) a subscription: no second checkout while one exists. */
export const OPEN_SUBSCRIPTION_STATUSES = ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"] as const;

export class BillingError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function requireStripe(): Stripe {
  if (!stripe) throw new BillingError("Pagamentos desativados", 503);
  return stripe;
}

/** The browser picks the price, so it must be in STRIPE_PRICE_IDS (required in production). */
export function assertPriceAllowed(priceId: string, allowed: readonly string[] = billingConfig.allowedPriceIds): void {
  if (allowed.length > 0 && !allowed.includes(priceId)) throw new BillingError("Preço não permitido", 400);
}

const ALREADY_SUBSCRIBED = "Você já tem uma assinatura. Use “Gerenciar assinatura”.";

async function storedCustomerId(orgId: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("organizations")
    .select("stripe_customer_id")
    .eq("id", orgId)
    .single();
  if (error) throw new Error(`storedCustomerId: ${error.message}`);
  return data.stripe_customer_id;
}

/**
 * One Stripe customer per organization. The idempotency key makes concurrent first checkouts (double click, two
 * tabs) get the same customer from Stripe, and the conditional update never overwrites a customer already saved.
 */
async function getOrCreateCustomerId(orgId: string, email: string | undefined): Promise<string> {
  const existing = await storedCustomerId(orgId);
  if (existing) return existing;

  const customer = await requireStripe().customers.create(
    { email, metadata: { orgId } },
    { idempotencyKey: `customer-org-${orgId}` },
  );
  const { error } = await createAdminClient()
    .from("organizations")
    .update({ stripe_customer_id: customer.id })
    .eq("id", orgId)
    .is("stripe_customer_id", null);
  if (error) throw new Error(`getOrCreateCustomerId: ${error.message}`);
  return (await storedCustomerId(orgId)) ?? customer.id;
}

/** Live subscriptions in Stripe itself: the local table may lag behind the webhook. */
async function hasOpenStripeSubscription(customer: string): Promise<boolean> {
  const { data } = await requireStripe().subscriptions.list({ customer, status: "all", limit: 20 });
  return data.some((subscription) => (OPEN_SUBSCRIPTION_STATUSES as readonly string[]).includes(subscription.status));
}

/** Stripe's minimum lifetime for a Checkout Session is 30 minutes (the default is 24 hours). */
const CHECKOUT_TTL_SECONDS = 35 * 60;

/** Open Checkout Sessions of the customer, oldest first. */
async function openCheckouts(customer: string) {
  const { data } = await requireStripe().checkout.sessions.list({ customer, status: "open", limit: 20 });
  return data;
}

/** Expires open subscription Checkouts (except `keep`), so an old tab can no longer start a second subscription. */
async function expireOpenSubscriptionCheckouts(customer: string, keep?: string): Promise<void> {
  for (const session of await openCheckouts(customer)) {
    if (session.mode !== "subscription" || session.id === keep) continue;
    await requireStripe()
      .checkout.sessions.expire(session.id)
      .catch((error: unknown) => {
        // Completed or expired in the meantime: nothing left to close.
        if (
          (error as { code?: string }).code !== "resource_missing" &&
          (error as { type?: string }).type !== "StripeInvalidRequestError"
        )
          throw error;
      });
  }
}

/**
 * Checkout URL for an organization (the caller checked the user may manage its billing). For subscriptions it
 * refuses when one already exists, locally OR in Stripe (statuses that still hold or may recover access), reuses an
 * open Checkout Session for the same price and EXPIRES open sessions for other prices (plan A tab left open + plan B
 * would otherwise end in two subscriptions). New sessions live 35 minutes instead of Stripe's default 24 hours.
 */
export async function createCheckoutSession(input: {
  orgId: string;
  userId: string;
  email?: string;
  priceId: string;
  mode: "payment" | "subscription";
}): Promise<string> {
  const client = requireStripe();
  assertPriceAllowed(input.priceId);
  if (input.mode === "subscription") {
    const { data: open } = await createAdminClient()
      .from("subscriptions")
      .select("id")
      .eq("org_id", input.orgId)
      .in("status", [...OPEN_SUBSCRIPTION_STATUSES])
      .limit(1);
    if (open?.length) throw new BillingError(ALREADY_SUBSCRIBED, 409);
  }
  const customer = await getOrCreateCustomerId(input.orgId, input.email);
  if (input.mode === "subscription" && (await hasOpenStripeSubscription(customer))) {
    throw new BillingError(ALREADY_SUBSCRIBED, 409);
  }
  const open = await openCheckouts(customer);
  const reusable = open.find(
    (session) => session.mode === input.mode && session.metadata?.priceId === input.priceId && session.url,
  );
  if (reusable?.url) return reusable.url;
  if (input.mode === "subscription") await expireOpenSubscriptionCheckouts(customer);

  // Same bucket as the idempotency key below: a retried click sends identical parameters.
  const bucket = Math.floor(Date.now() / 300_000);

  const metadata = { orgId: input.orgId, userId: input.userId, priceId: input.priceId };
  const session = await client.checkout.sessions.create(
    {
      mode: input.mode,
      customer,
      client_reference_id: input.orgId,
      line_items: [{ price: input.priceId, quantity: 1 }],
      success_url: billingConfig.successUrl,
      cancel_url: billingConfig.cancelUrl,
      metadata,
      expires_at: bucket * 300 + CHECKOUT_TTL_SECONDS,
      ...(input.mode === "subscription" && { subscription_data: { metadata } }),
    },
    // Same click retried within 5 minutes -> same session (no duplicates from double submits).
    { idempotencyKey: `checkout-${customer}-${input.mode}-${input.priceId}-${bucket}` },
  );
  if (!session.url) throw new BillingError("O Stripe não retornou a URL do checkout", 502);
  return session.url;
}

/** Customer Portal. Never creates a customer: without one there is nothing to manage (the UI hides the button). */
export async function createPortalSession(orgId: string): Promise<string> {
  const client = requireStripe();
  const customer = await storedCustomerId(orgId);
  if (!customer) throw new BillingError("Você ainda não tem assinatura para gerenciar.", 404);
  const session = await client.billingPortal.sessions.create({ customer, return_url: billingConfig.portalReturnUrl });
  return session.url;
}

export type CheckoutReturn = "synced" | "processing" | "ignored";

/**
 * Return from Checkout (`?session_id=`): reads the session from Stripe and syncs its subscription right away,
 * so the dashboard is correct without waiting for the webhook (same upsert as the webhook, so running both is
 * harmless). Sessions of other organizations are ignored. "processing" = not paid yet (boleto/Pix) or still open.
 */
export async function syncCheckoutSession(sessionId: string, orgId: string): Promise<CheckoutReturn> {
  const session = await requireStripe().checkout.sessions.retrieve(sessionId);
  if ((session.metadata?.orgId ?? session.client_reference_id) !== orgId) return "ignored";
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (subscriptionId) await syncSubscription({ id: subscriptionId } as Stripe.Subscription);
  const paid = session.status === "complete" && session.payment_status !== "unpaid";
  return paid ? "synced" : "processing";
}

const isMissing = (error: unknown) => (error as { code?: string } | null)?.code === "resource_missing";

/**
 * Account deletion: cancels every live subscription of the customer (no further charges), then deletes the
 * customer. A customer already gone in Stripe counts as done. A customer with >100 subscriptions is not expected.
 */
export async function cancelCustomerBilling(customerId: string): Promise<void> {
  const client = requireStripe();
  try {
    const { data } = await client.subscriptions.list({ customer: customerId, status: "all", limit: 100 });
    for (const subscription of data) {
      if (subscription.status === "canceled" || subscription.status === "incomplete_expired") continue;
      await client.subscriptions.cancel(subscription.id);
    }
    await client.customers.del(customerId);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/** Verifies the `stripe-signature` header against the raw body. */
export async function constructWebhookEvent(rawBody: string, signature: string | null): Promise<Stripe.Event> {
  const client = requireStripe();
  if (!billingConfig.webhookSecret || !signature) throw new BillingError("Assinatura ausente", 400);
  try {
    return await client.webhooks.constructEventAsync(rawBody, signature, billingConfig.webhookSecret);
  } catch {
    throw new BillingError("Assinatura do Stripe inválida", 400);
  }
}

const customerIdOf = (customer: string | { id: string } | null): string | null =>
  typeof customer === "string" ? customer : (customer?.id ?? null);

type Org = { id: string };

async function findOrg(column: "id" | "stripe_customer_id", value: string): Promise<Org | null> {
  const { data, error } = await createAdminClient().from("organizations").select("id").eq(column, value).maybeSingle();
  if (error) throw new Error(`findOrg: ${error.message}`);
  return data;
}

/**
 * Organization behind a Stripe object: metadata.orgId (set on every session and subscription this code creates),
 * then the customer. Null when it no longer exists (account deleted): the event is acknowledged and skipped.
 */
async function orgFor(
  metadata: Record<string, string> | null | undefined,
  customer: string | null,
): Promise<Org | null> {
  if (metadata?.orgId) return findOrg("id", metadata.orgId);
  if (customer) return findOrg("stripe_customer_id", customer);
  return null;
}

/** Checkout sessions also carry the org id in client_reference_id. */
async function orgForSession(session: Stripe.Checkout.Session): Promise<Org | null> {
  const fromMetadata = await orgFor(session.metadata, customerIdOf(session.customer));
  if (fromMetadata || !session.client_reference_id) return fromMetadata;
  return findOrg("id", session.client_reference_id);
}

/**
 * Re-reads the subscription from Stripe instead of trusting the event payload: events can arrive late or out of
 * order (an old "updated" after "deleted" must not reactivate access). Ignores organizations that no longer exist.
 */
async function syncSubscription(eventSubscription: Stripe.Subscription): Promise<void> {
  const subscription = await requireStripe().subscriptions.retrieve(eventSubscription.id);
  const org = await orgFor(subscription.metadata, customerIdOf(subscription.customer));
  if (!org) return;
  const item = subscription.items.data[0];
  const { error } = await createAdminClient()
    .from("subscriptions")
    .upsert({
      id: subscription.id,
      org_id: org.id,
      status: subscription.status,
      price_id: item?.price.id ?? null,
      current_period_end: item?.current_period_end ? new Date(item.current_period_end * 1000).toISOString() : null,
      cancel_at_period_end: subscription.cancel_at_period_end,
    });
  if (error) throw new Error(`syncSubscription: ${error.message}`);
}

/**
 * Who hears about a payment: the user who paid (if still a member) or else the organization's admins. The Stripe
 * event id makes it idempotent: a redelivery after a partial failure does not notify (or e-mail) twice.
 */
async function notifyBilling(
  eventId: string,
  org: Org,
  purchaser: string | undefined,
  input: NotifyInput,
  email = false,
) {
  const admins = await orgAdminIds(org.id);
  const targets = purchaser && admins.includes(purchaser) ? [purchaser] : admins;
  for (const userId of targets) await notify(userId, input, { email, idempotencyKey: `${eventId}:${userId}` });
}

/**
 * Safety net after a subscription checkout: closes the customer's other open subscription Checkouts and, if two
 * live subscriptions exist anyway (race between tabs), keeps the oldest and sets the newer ones to cancel at the
 * end of the period. Chosen over an automatic refund on purpose: it stops further charges and is reversible,
 * while refunding (how much, which plan to keep) is left to a person, who is alerted (Sentry, audit, platform
 * admins' bell).
 */
async function guardDuplicateSubscriptions(eventId: string, session: Stripe.Checkout.Session): Promise<void> {
  const customer = customerIdOf(session.customer);
  if (!customer) return;
  await expireOpenSubscriptionCheckouts(customer);
  const { data } = await requireStripe().subscriptions.list({ customer, status: "all", limit: 20 });
  const live = data
    .filter((subscription) => (OPEN_SUBSCRIPTION_STATUSES as readonly string[]).includes(subscription.status))
    .sort((a, b) => a.created - b.created);
  const [keep, ...duplicates] = live;
  if (!keep) return;
  for (const duplicate of duplicates) {
    if (duplicate.cancel_at_period_end) continue;
    await requireStripe().subscriptions.update(duplicate.id, {
      cancel_at_period_end: true,
      metadata: { ...duplicate.metadata, duplicate_of: keep.id },
    });
    await audit({
      actorId: null,
      action: "billing.duplicate_subscription",
      entity: "stripe_subscription",
      entityId: duplicate.id,
      metadata: { kept: keep.id, customer },
    });
    reportError("billing.duplicate_subscription", new Error("Duplicate subscription set to cancel at period end"), {
      customer,
      kept: keep.id,
      duplicate: duplicate.id,
    });
    const { data: admins } = await createAdminClient().from("profiles").select("id").eq("role", "admin");
    for (const admin of admins ?? []) {
      await notify(
        admin.id,
        {
          type: "warning",
          title: "Assinatura duplicada no Stripe",
          body: `${duplicate.id} vai cancelar no fim do período (mantida: ${keep.id}). Avalie o estorno.`,
        },
        { idempotencyKey: `${eventId}:dup:${duplicate.id}:${admin.id}` },
      );
    }
  }
}

/**
 * Grant access here: runs only when the money is confirmed. Events about an organization deleted in the meantime
 * are acknowledged and skipped (failing would make Stripe retry for days; auditing would re-create user ids).
 */
async function onCheckoutPaid(eventId: string, session: Stripe.Checkout.Session): Promise<void> {
  const org = await orgForSession(session);
  if (!org) return;
  const purchaser = session.metadata?.userId;
  await audit({
    actorId: purchaser && (await orgAdminIds(org.id)).includes(purchaser) ? purchaser : null,
    action: "checkout.paid",
    entity: "organization",
    entityId: org.id,
    metadata: {
      session: session.id,
      mode: session.mode,
      amountTotal: session.amount_total,
      currency: session.currency,
    },
  });
  await notifyBilling(eventId, org, purchaser, { type: "success", title: "Pagamento confirmado", link: "/painel" });
}

/** Business rules for Stripe events. Idempotency is handled by the webhook route (processOnce). */
export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const session = event.data.object;
      if (event.type === "checkout.session.completed" && session.mode === "subscription") {
        await guardDuplicateSubscriptions(event.id, session);
      }
      if (session.payment_status === "unpaid") break;
      await onCheckoutPaid(event.id, session);
      break;
    }
    case "checkout.session.async_payment_failed": {
      const session = event.data.object;
      const org = await orgForSession(session);
      if (org) {
        await notifyBilling(event.id, org, session.metadata?.userId, {
          type: "error",
          title: "Pagamento não confirmado",
          body: "O pagamento não foi compensado. Tente outra forma de pagamento.",
          link: "/painel",
        });
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(event.data.object);
      break;
    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const org = await orgFor(null, customerIdOf(invoice.customer));
      if (org) {
        await notifyBilling(
          event.id,
          org,
          undefined,
          {
            type: "error",
            title: "Falha no pagamento",
            body: "Atualize sua forma de pagamento para manter o acesso.",
            link: "/painel",
          },
          true,
        );
      }
      break;
    }
    default:
      break;
  }
}

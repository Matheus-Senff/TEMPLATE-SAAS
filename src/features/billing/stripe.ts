import "server-only";
import Stripe from "stripe";
import { env } from "@/lib/env";

/** `null` while STRIPE_SECRET_KEY is empty: the billing module is off (routes answer 503). */
export const stripe = env.STRIPE_SECRET_KEY ? new Stripe(env.STRIPE_SECRET_KEY) : null;

export const billingConfig = {
  enabled: stripe !== null,
  webhookSecret: env.STRIPE_WEBHOOK_SECRET,
  allowedPriceIds: env.STRIPE_PRICE_IDS ?? [],
  /** Stripe replaces {CHECKOUT_SESSION_ID}: the dashboard syncs that session on return (see syncCheckoutSession). */
  successUrl: `${env.NEXT_PUBLIC_SITE_URL}/painel?checkout=sucesso&session_id={CHECKOUT_SESSION_ID}`,
  cancelUrl: `${env.NEXT_PUBLIC_SITE_URL}/painel?checkout=cancelado`,
  portalReturnUrl: `${env.NEXT_PUBLIC_SITE_URL}/painel`,
} as const;

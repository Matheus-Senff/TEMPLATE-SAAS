import { NextResponse } from "next/server";
import { BillingError, constructWebhookEvent, handleStripeEvent } from "@/features/billing/service";
import { processOnce } from "@/lib/webhooks";

/**
 * Stripe calls this directly: no session, verified by signature on the raw body, idempotent per event id.
 * 2xx only after the event was handled and recorded: 409 while another delivery of the same event is still
 * running (Stripe retries later) and 500 on failure (Stripe retries with backoff for up to 3 days).
 */
export async function POST(request: Request) {
  try {
    const event = await constructWebhookEvent(await request.text(), request.headers.get("stripe-signature"));
    const { outcome } = await processOnce("stripe", event.id, event.type, () => handleStripeEvent(event));
    if (outcome === "in_progress") {
      return NextResponse.json({ error: "Event is being processed; retry later" }, { status: 409 });
    }
    return NextResponse.json({ received: true, duplicate: outcome === "duplicate" });
  } catch (error) {
    if (error instanceof BillingError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

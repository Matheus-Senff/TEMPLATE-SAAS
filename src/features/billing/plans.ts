import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Plans and what each one unlocks (per ORGANIZATION). Stripe is the source of truth; the webhook mirrors it into
 * public.subscriptions and access is decided from that table, never by calling Stripe on each request:
 *   - server code: `await getOrgPlan(org.id)` then `PLANS[plan].limits...`
 *   - SQL/RLS on tenant tables: `(select public.has_active_subscription(org_id))`
 * The browser only hides buttons; the server always checks.
 */
export type PlanId = "free" | "pro";

export const PLANS: Record<PlanId, { name: string; limits: { members: number } }> = {
  free: { name: "Gratuito", limits: { members: 1 } },
  pro: { name: "Pro", limits: { members: 20 } },
};

/**
 * Statuses that grant the paid plan; keep in sync with public.has_active_subscription(). To give a grace period
 * while Stripe retries a failed card, add "past_due" in both places.
 */
export const PAID_STATUSES: readonly string[] = ["active", "trialing"];

export function planOf(subscription: { status: string; current_period_end: string | null } | null): PlanId {
  if (!subscription || !PAID_STATUSES.includes(subscription.status)) return "free";
  const end = subscription.current_period_end;
  return !end || new Date(end) > new Date() ? "pro" : "free";
}

/** Current plan of an organization, read as the signed-in user (RLS: members only). */
export async function getOrgPlan(orgId: string): Promise<PlanId> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("subscriptions")
    .select("status, current_period_end")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getOrgPlan: ${error.message}`);
  return planOf(data);
}

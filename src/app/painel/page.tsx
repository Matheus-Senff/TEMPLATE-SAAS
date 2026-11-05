import type { Metadata } from "next";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { PrivacyCard } from "@/features/account/privacy-card";
import { BillingCard } from "@/features/billing/billing-card";
import { syncCheckoutSession, type CheckoutReturn } from "@/features/billing/service";
import { billingConfig } from "@/features/billing/stripe";
import { FilesCard } from "@/features/files/files-card";
import { getActiveOrg, hasRole } from "@/features/organizations/service";
import { requireUser } from "@/lib/auth";
import { reportError } from "@/lib/log";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Painel", robots: { index: false, follow: false } };

/** Back from Stripe Checkout: sync now (idempotent with the webhook); on any doubt show "processing". */
async function checkoutReturn(sessionId: string | undefined, orgId: string): Promise<CheckoutReturn | null> {
  if (!billingConfig.enabled || !sessionId?.startsWith("cs_")) return null;
  try {
    return await syncCheckoutSession(sessionId, orgId);
  } catch (error) {
    reportError("billing.checkout_return", error, { orgId });
    return "processing";
  }
}

/** Private: proxy.ts redirects signed-out visitors and requireUser() checks again here. */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string; session_id?: string }>;
}) {
  const user = await requireUser();
  const { checkout, session_id: sessionId } = await searchParams;
  // Billing belongs to the active organization (today: the personal one created at sign-up).
  const org = await getActiveOrg(user.id);
  const returned = checkout === "sucesso" ? await checkoutReturn(sessionId, org.id) : null;

  const supabase = await createClient();
  const [{ data: profile }, { data: subscription }] = await Promise.all([
    supabase.from("profiles").select("full_name, role").eq("id", user.id).single(),
    supabase
      .from("subscriptions")
      .select("status")
      .eq("org_id", org.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Olá, {profile?.full_name ?? user.email}</h1>
        <div className="flex gap-2">
          <Link href="/painel/seguranca" className={buttonVariants({ variant: "secondary", size: "sm" })}>
            Segurança
          </Link>
          {profile?.role === "admin" && (
            <Link href="/admin" className={buttonVariants({ variant: "secondary", size: "sm" })}>
              Administração
            </Link>
          )}
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <FilesCard />
        <BillingCard
          status={subscription?.status ?? null}
          enabled={billingConfig.enabled}
          hasCustomer={Boolean(org.stripeCustomerId)}
          canManage={hasRole(org.role, "admin")}
          processing={returned === "processing"}
        />
        <PrivacyCard />
      </div>
    </section>
  );
}

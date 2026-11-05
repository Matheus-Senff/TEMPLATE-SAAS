import { afterEach, describe, expect, it, vi } from "vitest";
import { claimsFor, expectRedirect, mockAdmin, mockServerClient, type Result } from "./helpers/admin-mock";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  for (const mod of [
    "@/lib/supabase/admin",
    "@/lib/supabase/server",
    "@/lib/rate-limit",
    "@/lib/notifications",
    "@/lib/audit",
    "@/lib/log",
    "@/features/billing/stripe",
    "@/features/billing/service",
    "@/features/organizations/service",
  ]) {
    vi.doUnmock(mod);
  }
});

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "99999999-9999-4999-8999-999999999999";

function fakeStripe({
  subscriptions = [] as Array<Record<string, unknown> & { id: string; status: string }>,
  openSessions = [] as Array<Record<string, unknown>>,
  session = {} as Record<string, unknown>,
  subscription = undefined as Record<string, unknown> | undefined,
} = {}) {
  return {
    customers: { create: vi.fn(async () => ({ id: "cus_new" })) },
    subscriptions: {
      list: vi.fn(async () => ({ data: subscriptions })),
      retrieve: vi.fn(async () => subscription),
      update: vi.fn(async () => ({})),
    },
    checkout: {
      sessions: {
        list: vi.fn(async () => ({ data: openSessions })),
        create: vi.fn(async () => ({ url: "https://checkout.stripe.com/new" })),
        retrieve: vi.fn(async () => session),
        expire: vi.fn(async () => ({})),
      },
    },
    billingPortal: { sessions: { create: vi.fn(async () => ({ url: "https://billing.stripe.com/p" })) } },
  };
}

async function service(stripe: ReturnType<typeof fakeStripe>, results: Record<string, Result[]> = {}) {
  const admin = mockAdmin(results);
  vi.doMock("@/features/billing/stripe", () => ({
    stripe,
    billingConfig: {
      enabled: true,
      allowedPriceIds: [],
      successUrl: "https://app.test/painel?checkout=sucesso&session_id={CHECKOUT_SESSION_ID}",
      cancelUrl: "https://app.test/painel?checkout=cancelado",
      portalReturnUrl: "https://app.test/painel",
    },
  }));
  vi.doMock("@/lib/notifications", () => ({ notify: vi.fn(async () => true) }));
  vi.doMock("@/lib/audit", () => ({ audit: vi.fn() }));
  return { admin, service: await import("@/features/billing/service") };
}

const noLocalSub = { subscriptions: [{ data: [], error: null }] };
const withCustomer = (id: string | null) => ({ data: { stripe_customer_id: id }, error: null });

describe("checkout guard", () => {
  it("refuses when Stripe already has a live subscription the webhook did not record yet", async () => {
    const stripe = fakeStripe({ subscriptions: [{ id: "sub_1", status: "past_due" }] });
    const { service: billing } = await service(stripe, { ...noLocalSub, organizations: [withCustomer("cus_1")] });
    await expect(
      billing.createCheckoutSession({ orgId: ORG, userId: USER, priceId: "price_1", mode: "subscription" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("ignores ended subscriptions", async () => {
    const stripe = fakeStripe({ subscriptions: [{ id: "sub_old", status: "canceled" }] });
    const { service: billing } = await service(stripe, { ...noLocalSub, organizations: [withCustomer("cus_1")] });
    await expect(
      billing.createCheckoutSession({ orgId: ORG, userId: USER, priceId: "price_1", mode: "subscription" }),
    ).resolves.toBe("https://checkout.stripe.com/new");
  });

  it("reuses an open Checkout Session for the same price instead of creating another", async () => {
    const stripe = fakeStripe({
      openSessions: [
        { mode: "subscription", metadata: { priceId: "price_other" }, url: "https://checkout.stripe.com/other" },
        { mode: "subscription", metadata: { priceId: "price_1" }, url: "https://checkout.stripe.com/open" },
      ],
    });
    const { service: billing } = await service(stripe, { ...noLocalSub, organizations: [withCustomer("cus_1")] });
    expect(
      await billing.createCheckoutSession({ orgId: ORG, userId: USER, priceId: "price_1", mode: "subscription" }),
    ).toBe("https://checkout.stripe.com/open");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("creates the session with {CHECKOUT_SESSION_ID} in the success URL and an idempotency key", async () => {
    const stripe = fakeStripe();
    const { service: billing } = await service(stripe, { ...noLocalSub, organizations: [withCustomer("cus_1")] });
    await billing.createCheckoutSession({ orgId: ORG, userId: USER, priceId: "price_1", mode: "subscription" });
    const [params, options] = stripe.checkout.sessions.create.mock.calls[0] as unknown as [
      Record<string, unknown>,
      { idempotencyKey: string },
    ];
    expect(params).toMatchObject({
      customer: "cus_1",
      client_reference_id: ORG,
      success_url: expect.stringContaining("session_id={CHECKOUT_SESSION_ID}"),
      metadata: { orgId: ORG, userId: USER, priceId: "price_1" },
    });
    expect(options.idempotencyKey).toMatch(/^checkout-cus_1-subscription-price_1-\d+$/);
  });

  it("creates the organization's Stripe customer once, with an idempotency key, without overwriting one", async () => {
    const stripe = fakeStripe();
    const { admin, service: billing } = await service(stripe, {
      ...noLocalSub,
      organizations: [withCustomer(null), { data: null, error: null }, withCustomer("cus_new")],
    });
    await billing.createCheckoutSession({
      orgId: ORG,
      userId: USER,
      email: "a@x.com",
      priceId: "price_1",
      mode: "subscription",
    });
    expect(stripe.customers.create).toHaveBeenCalledWith(
      { email: "a@x.com", metadata: { orgId: ORG } },
      { idempotencyKey: `customer-org-${ORG}` },
    );
    expect(admin.calls).toContainEqual({ table: "organizations", method: "is", args: ["stripe_customer_id", null] });
  });

  it("checks existing subscriptions of the organization (not of the user)", async () => {
    const stripe = fakeStripe();
    const { admin, service: billing } = await service(stripe, {
      ...noLocalSub,
      organizations: [withCustomer("cus_1")],
    });
    await billing.createCheckoutSession({ orgId: ORG, userId: USER, priceId: "price_1", mode: "subscription" });
    expect(admin.calls).toContainEqual({ table: "subscriptions", method: "eq", args: ["org_id", ORG] });
  });
});

describe("Customer Portal", () => {
  it("never creates a customer just to open the portal", async () => {
    const stripe = fakeStripe();
    const { service: billing } = await service(stripe, { organizations: [withCustomer(null)] });
    await expect(billing.createPortalSession(ORG)).rejects.toMatchObject({ status: 404 });
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it("opens the portal for an existing customer", async () => {
    const stripe = fakeStripe();
    const { service: billing } = await service(stripe, { organizations: [withCustomer("cus_1")] });
    expect(await billing.createPortalSession(ORG)).toBe("https://billing.stripe.com/p");
  });
});

describe("return from Checkout", () => {
  const subscription = {
    id: "sub_1",
    status: "active",
    metadata: { orgId: ORG, userId: USER },
    customer: "cus_1",
    cancel_at_period_end: false,
    items: { data: [{ price: { id: "price_1" }, current_period_end: 1_900_000_000 }] },
  };

  it("syncs the subscription right away (same upsert as the webhook)", async () => {
    const stripe = fakeStripe({
      session: {
        client_reference_id: ORG,
        metadata: { orgId: ORG },
        status: "complete",
        payment_status: "paid",
        subscription: "sub_1",
      },
      subscription,
    });
    const { admin, service: billing } = await service(stripe, {
      organizations: [{ data: { id: ORG }, error: null }],
    });
    expect(await billing.syncCheckoutSession("cs_1", ORG)).toBe("synced");
    const upsert = admin.calls.find((c) => c.table === "subscriptions" && c.method === "upsert");
    expect(upsert?.args[0]).toMatchObject({ id: "sub_1", status: "active", org_id: ORG });
  });

  it("reports boleto/Pix still unpaid as processing", async () => {
    const stripe = fakeStripe({
      session: { client_reference_id: ORG, status: "complete", payment_status: "unpaid", subscription: null },
    });
    const { service: billing } = await service(stripe);
    expect(await billing.syncCheckoutSession("cs_1", ORG)).toBe("processing");
  });

  it("ignores a session that belongs to another organization", async () => {
    const stripe = fakeStripe({ session: { client_reference_id: "other-org", subscription: "sub_1" } });
    const { service: billing } = await service(stripe);
    expect(await billing.syncCheckoutSession("cs_1", ORG)).toBe("ignored");
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });
});

describe("billing actions", () => {
  const setup = async (impl: () => Promise<string>, role = "owner") => {
    mockAdmin();
    vi.doMock("@/features/organizations/service", () => ({
      getActiveOrg: vi.fn(async () => ({ id: ORG, name: "Ana", personal: true, stripeCustomerId: "cus_1", role })),
      hasRole: (current: string, min: string) =>
        ({ owner: 3, admin: 2, member: 1 })[current as "owner"] >= { owner: 3, admin: 2, member: 1 }[min as "owner"],
    }));
    vi.doMock("@/lib/rate-limit", () => ({
      rateLimit: vi.fn(async () => ({ allowed: true, remaining: 1, resetAt: new Date() })),
    }));
    const reportError = vi.fn();
    vi.doMock("@/lib/log", () => ({ reportError }));
    class BillingError extends Error {
      constructor(
        message: string,
        readonly status: number,
      ) {
        super(message);
      }
    }
    vi.doMock("@/features/billing/service", () => ({
      BillingError,
      createCheckoutSession: vi.fn(impl),
      createPortalSession: vi.fn(impl),
    }));
    mockServerClient({ claims: claimsFor(USER) });
    return { actions: await import("@/features/billing/actions"), reportError, BillingError };
  };

  it("turns an unexpected Stripe failure into a friendly error (no error page) and reports it", async () => {
    const { actions, reportError } = await setup(async () => {
      throw new Error("Stripe API down");
    });
    const result = await actions.startCheckout({ priceId: "price_1" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("sistema de pagamento") });
    expect(reportError).toHaveBeenCalledWith("billing.checkout", expect.any(Error), { userId: USER });
  });

  it("only owners/admins of the organization manage billing", async () => {
    const { actions } = await setup(async () => "https://checkout.stripe.com/x", "member");
    expect(await actions.startCheckout({ priceId: "price_1" })).toMatchObject({ ok: false });
  });

  it("redirects to Stripe on success", async () => {
    const { actions } = await setup(async () => "https://checkout.stripe.com/x");
    expect(await expectRedirect(actions.openBillingPortal())).toBe("https://checkout.stripe.com/x");
  });
});

describe("plans", () => {
  it("grants the paid plan only for active/trialing subscriptions inside the period", async () => {
    mockAdmin();
    const { planOf } = await import("@/features/billing/plans");
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(planOf(null)).toBe("free");
    expect(planOf({ status: "active", current_period_end: future })).toBe("pro");
    expect(planOf({ status: "trialing", current_period_end: null })).toBe("pro");
    expect(planOf({ status: "past_due", current_period_end: future })).toBe("free");
    expect(planOf({ status: "active", current_period_end: past })).toBe("free");
  });
});

describe("no second subscription from an old Checkout tab", () => {
  it("expires open subscription Checkouts for other prices and creates short-lived sessions", async () => {
    const stripe = fakeStripe({
      openSessions: [{ id: "cs_plan_a", mode: "subscription", metadata: { priceId: "price_a" }, url: "https://a" }],
    });
    const { service: billing } = await service(stripe, { ...noLocalSub, organizations: [withCustomer("cus_1")] });
    const before = Math.floor(Date.now() / 1000);
    await billing.createCheckoutSession({ orgId: ORG, userId: USER, priceId: "price_b", mode: "subscription" });
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_plan_a");
    const [params] = stripe.checkout.sessions.create.mock.calls[0] as unknown as [{ expires_at: number }];
    // Stripe accepts 30 min to 24 h; 35 min from the start of the 5-minute idempotency bucket.
    expect(params.expires_at - before).toBeGreaterThanOrEqual(30 * 60);
    expect(params.expires_at - before).toBeLessThanOrEqual(35 * 60);
  });

  it("after a subscription checkout, keeps the oldest live subscription and stops the duplicate at period end", async () => {
    const stripe = fakeStripe({
      openSessions: [{ id: "cs_other", mode: "subscription", metadata: { priceId: "price_a" } }],
      subscriptions: [
        { id: "sub_new", status: "active", created: 200, cancel_at_period_end: false, metadata: {} },
        { id: "sub_old", status: "active", created: 100, cancel_at_period_end: false, metadata: {} },
        { id: "sub_gone", status: "canceled", created: 50, cancel_at_period_end: false, metadata: {} },
      ],
    });
    const { service: billing } = await service(stripe, {
      organizations: [{ data: { id: ORG }, error: null }],
      memberships: [
        { data: [{ user_id: USER, role: "owner" }], error: null },
        { data: [{ user_id: USER, role: "owner" }], error: null },
      ],
      profiles: [{ data: [{ id: "admin-1" }], error: null }],
    });
    const notify = (await import("@/lib/notifications")).notify as ReturnType<typeof vi.fn>;
    await billing.handleStripeEvent({
      id: "evt_9",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_done",
          mode: "subscription",
          customer: "cus_1",
          payment_status: "paid",
          metadata: { orgId: ORG, userId: USER },
        },
      },
    } as never);
    expect(stripe.checkout.sessions.expire).toHaveBeenCalledWith("cs_other");
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.update).toHaveBeenCalledWith("sub_new", {
      cancel_at_period_end: true,
      metadata: { duplicate_of: "sub_old" },
    });
    expect(notify).toHaveBeenCalledWith(
      "admin-1",
      expect.objectContaining({ title: "Assinatura duplicada no Stripe" }),
      { idempotencyKey: "evt_9:dup:sub_new:admin-1" },
    );
  });
});

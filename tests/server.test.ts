import { afterEach, describe, expect, it, vi } from "vitest";
import { mockAdmin } from "./helpers/admin-mock";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/supabase/admin");
  vi.doUnmock("@/lib/notifications");
  vi.doUnmock("@/lib/audit");
  vi.doUnmock("@/lib/rate-limit");
  vi.doUnmock("@/lib/request");
  vi.doUnmock("next/server");
  vi.doUnmock("@/lib/jobs");
  vi.doUnmock("@/lib/log");
});

describe("env", () => {
  it("rejects a half-configured Turnstile", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "secret");
    await expect(import("@/lib/env")).rejects.toThrow("TURNSTILE");
  });

  it("requires STRIPE_PRICE_IDS in production when Stripe is on", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_123");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_123");
    await expect(import("@/lib/env")).rejects.toThrow("STRIPE_PRICE_IDS is required");
  });
});

describe("rate limit", () => {
  it("returns the database decision", async () => {
    mockAdmin(
      {},
      { rate_limit: { data: [{ allowed: false, remaining: 0, reset_at: "2030-01-01T00:00:00Z" }], error: null } },
    );
    const { rateLimit } = await import("@/lib/rate-limit");
    expect((await rateLimit("k", 1, 60)).allowed).toBe(false);
  });

  it("fails closed when the database is unavailable (auth, e-mail, deletion)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockAdmin();
    const { rateLimit } = await import("@/lib/rate-limit");
    expect((await rateLimit("signin:ip:1.2.3.4", 1, 60)).allowed).toBe(false);
  });

  it("fails open only when the caller opts in", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockAdmin();
    const { rateLimit } = await import("@/lib/rate-limit");
    expect((await rateLimit("billing:u1", 1, 60, { failOpen: true })).allowed).toBe(true);
  });

  it("rateLimitAll stops at the first exceeded limit", async () => {
    const { client } = mockAdmin(
      {},
      {
        rate_limit: [
          { data: [{ allowed: false, remaining: 0, reset_at: "2030-01-01T00:00:00Z" }], error: null },
          { data: [{ allowed: true, remaining: 1, reset_at: "2030-01-01T00:00:00Z" }], error: null },
        ],
      },
    );
    const { rateLimitAll } = await import("@/lib/rate-limit");
    expect(
      await rateLimitAll([
        ["a", 1, 60],
        ["b", 1, 60],
      ]),
    ).toBe(false);
    expect(client.rpc).toHaveBeenCalledOnce();
  });

  it("hashKey keeps e-mails out of the rate_limits table", async () => {
    mockAdmin();
    const { hashKey } = await import("@/lib/rate-limit");
    expect(hashKey(" Ana@X.com ")).toBe(hashKey("ana@x.com"));
    expect(hashKey("ana@x.com")).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("processOnce", () => {
  it("skips a delivery that was already processed", async () => {
    mockAdmin({
      webhook_events: [
        { error: { code: "23505", message: "duplicate" } },
        { data: [], error: null },
        { data: { processed_at: "2026-01-01T00:00:00Z" }, error: null },
      ],
    });
    const handler = vi.fn();
    const { processOnce } = await import("@/lib/webhooks");
    expect(await processOnce("stripe", "evt_1", "t", handler)).toEqual({ outcome: "duplicate" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("reports a fresh unfinished claim as in progress (not a duplicate), so the provider retries", async () => {
    mockAdmin({
      webhook_events: [
        { error: { code: "23505", message: "duplicate" } },
        { data: [], error: null },
        { data: { processed_at: null }, error: null },
      ],
    });
    const handler = vi.fn();
    const { processOnce } = await import("@/lib/webhooks");
    expect(await processOnce("stripe", "evt_4", "t", handler)).toEqual({ outcome: "in_progress" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("takes over a stale claim left by a crashed attempt", async () => {
    mockAdmin({
      webhook_events: [{ error: { code: "23505", message: "duplicate" } }, { data: [{ id: "evt_3" }], error: null }],
    });
    const handler = vi.fn(async () => {});
    const { processOnce } = await import("@/lib/webhooks");
    expect(await processOnce("stripe", "evt_3", "t", handler)).toEqual({ outcome: "processed" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("releases the claim when the handler fails", async () => {
    const { calls } = mockAdmin();
    const { processOnce } = await import("@/lib/webhooks");
    await expect(processOnce("stripe", "evt_2", "t", async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    expect(calls.some((c) => c.table === "webhook_events" && c.method === "delete")).toBe(true);
  });
});

describe("notify", () => {
  it.each(["https://evil.com", "//evil.com"])("rejects absolute link %s", async (link) => {
    mockAdmin();
    const { notify } = await import("@/lib/notifications");
    await expect(notify("u1", { title: "x", link })).rejects.toThrow("relative path");
  });
});

describe("billing", () => {
  const checkout = (type: string, payment_status: string) =>
    ({
      id: "evt",
      type,
      data: {
        object: {
          id: "cs_1",
          client_reference_id: "o1",
          metadata: { orgId: "o1", userId: "u1" },
          payment_status,
          mode: "payment",
        },
      },
    }) as never;

  const owners = { data: [{ user_id: "u1", role: "owner" }], error: null };
  const setup = async (org: unknown = { id: "o1" }) => {
    mockAdmin({ organizations: [{ data: org, error: null }], memberships: [owners, owners] });
    const notify = vi.fn(async () => true);
    vi.doMock("@/lib/notifications", () => ({ notify }));
    vi.doMock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
    const service = await import("@/features/billing/service");
    return { ...service, notify };
  };

  it("accepts any price with an empty allowlist and only listed prices otherwise", async () => {
    const { assertPriceAllowed } = await setup();
    expect(() => assertPriceAllowed("price_x", [])).not.toThrow();
    expect(() => assertPriceAllowed("price_cheap", ["price_ok"])).toThrow("Preço não permitido");
  });

  it("does not confirm a boleto checkout before the money arrives", async () => {
    const { handleStripeEvent, notify } = await setup();
    await handleStripeEvent(checkout("checkout.session.completed", "unpaid"));
    expect(notify).not.toHaveBeenCalled();
  });

  it.each(["checkout.session.completed", "checkout.session.async_payment_succeeded"])(
    "confirms %s when paid",
    async (type) => {
      const { handleStripeEvent, notify } = await setup();
      await handleStripeEvent(checkout(type, "paid"));
      // Keyed by event + user: a redelivery of the same event does not notify twice.
      expect(notify).toHaveBeenCalledWith("u1", expect.objectContaining({ type: "success" }), {
        email: false,
        idempotencyKey: "evt:u1",
      });
    },
  );

  it("notifies the organization's admins when the purchaser is no longer a member", async () => {
    mockAdmin({
      organizations: [{ data: { id: "o1" }, error: null }],
      memberships: [
        { data: [{ user_id: "admin1", role: "admin" }], error: null },
        { data: [{ user_id: "admin1", role: "admin" }], error: null },
      ],
    });
    const notify = vi.fn(async () => true);
    vi.doMock("@/lib/notifications", () => ({ notify }));
    vi.doMock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
    const { handleStripeEvent } = await import("@/features/billing/service");
    await handleStripeEvent(checkout("checkout.session.completed", "paid"));
    expect(notify).toHaveBeenCalledWith("admin1", expect.objectContaining({ title: "Pagamento confirmado" }), {
      email: false,
      idempotencyKey: "evt:admin1",
    });
  });

  it("acknowledges and skips a paid checkout of an account deleted meanwhile (no 500 retry loop)", async () => {
    const { handleStripeEvent, notify } = await setup(null);
    await expect(handleStripeEvent(checkout("checkout.session.completed", "paid"))).resolves.toBeUndefined();
    expect(notify).not.toHaveBeenCalled();
  });

  it("webhook answers 503 while Stripe is disabled", async () => {
    mockAdmin();
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(new Request("http://x/api/stripe/webhook", { method: "POST", body: "{}" }));
    expect(res.status).toBe(503);
  });
});

describe("contact", () => {
  const valid = { name: "Ana Souza", email: "ANA@x.com", phone: "", message: "Quero um orçamento.", website: "" };

  const setup = async ({ allowed = true, enqueueFails = false } = {}) => {
    vi.stubEnv("CONTACT_EMAIL", "equipe@x.com");
    const rateLimitAll = vi.fn(async () => allowed);
    const enqueue = vi.fn(async () => {
      if (enqueueFails) throw new Error("db down");
      return "job-1";
    });
    vi.doMock("@/lib/request", () => ({ clientIp: async () => "1.2.3.4" }));
    vi.doMock("@/lib/rate-limit", () => ({ rateLimitAll, hashKey: (v: string) => `h:${v}` }));
    vi.doMock("@/lib/jobs", () => ({ enqueue }));
    vi.doMock("@/lib/log", () => ({ reportError: vi.fn() }));
    const { sendContact } = await import("@/features/contact/actions");
    return { sendContact, enqueue, rateLimitAll };
  };

  it("stores the e-mail as a durable job (retried if the provider fails) before answering", async () => {
    const { sendContact, enqueue } = await setup();
    expect(await sendContact(valid)).toEqual({ ok: true });
    expect(enqueue).toHaveBeenCalledWith(
      "email.send",
      expect.objectContaining({ to: "equipe@x.com", replyTo: "ana@x.com", subject: "Novo contato: Ana Souza" }),
    );
  });

  it("tells the visitor to retry when the job cannot be stored", async () => {
    const { sendContact } = await setup({ enqueueFails: true });
    expect((await sendContact(valid)).ok).toBe(false);
  });

  it("returns field errors for invalid input", async () => {
    const { sendContact } = await setup();
    const result = await sendContact({ ...valid, message: "oi" });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.fieldErrors?.message).toBeTruthy();
  });

  it("silently drops bots that fill the honeypot", async () => {
    const { sendContact, enqueue, rateLimitAll } = await setup();
    expect(await sendContact({ ...valid, website: "spam" })).toEqual({ ok: true });
    expect(enqueue).not.toHaveBeenCalled();
    expect(rateLimitAll).not.toHaveBeenCalled();
  });

  it("limits per IP and per e-mail", async () => {
    const { sendContact, rateLimitAll } = await setup({ allowed: false });
    expect((await sendContact(valid)).ok).toBe(false);
    const keys = (rateLimitAll.mock.calls[0] as unknown as [Array<[string]>])[0].map(([key]) => key);
    expect(keys).toEqual(["contact:ip:1.2.3.4", "contact:email:h:ana@x.com"]);
  });
});

describe("files", () => {
  it("validates size and type and builds a path inside the user's folder", async () => {
    const { buildObjectPath, validateFile } = await import("@/features/files/config");
    expect(validateFile({ size: 10, type: "application/pdf" })).toBeNull();
    expect(validateFile({ size: 10, type: "text/html" })).toMatch(/não permitido/);
    expect(validateFile({ size: 30 * 1024 * 1024, type: "application/pdf" })).toMatch(/25 MB/);
    expect(buildObjectPath("u1", "Relatório final.pdf")).toMatch(/^u1\/[0-9a-f-]{36}-Relatorio-final\.pdf$/);
  });
});

describe("cron", () => {
  it("rejects calls without the secret", async () => {
    vi.stubEnv("CRON_SECRET", "a-long-random-secret-123");
    mockAdmin();
    const { GET } = await import("@/app/api/cron/cleanup/route");
    const res = await GET(new Request("http://x/api/cron/cleanup") as never);
    expect(res.status).toBe(401);
  });
});

describe("billing with Stripe enabled", () => {
  const fakeStripe = (subscription?: Record<string, unknown>) => ({
    subscriptions: { retrieve: vi.fn(async () => subscription) },
    customers: { create: vi.fn(async () => ({ id: "cus_1" })) },
    checkout: { sessions: { create: vi.fn(async () => ({ url: "https://checkout" })) } },
  });

  const setup = async (stripe: ReturnType<typeof fakeStripe>, results: Parameters<typeof mockAdmin>[0]) => {
    const { calls } = mockAdmin(results);
    vi.doMock("@/features/billing/stripe", () => ({
      stripe,
      billingConfig: { enabled: true, allowedPriceIds: [], successUrl: "s", cancelUrl: "c", portalReturnUrl: "p" },
    }));
    vi.doMock("@/lib/notifications", () => ({ notify: vi.fn() }));
    vi.doMock("@/lib/audit", () => ({ audit: vi.fn() }));
    return { calls, service: await import("@/features/billing/service") };
  };

  afterEach(() => vi.doUnmock("@/features/billing/stripe"));

  it("refuses a second subscription checkout", async () => {
    const stripe = fakeStripe();
    const { service } = await setup(stripe, { subscriptions: [{ data: [{ id: "sub_1" }], error: null }] });
    await expect(
      service.createCheckoutSession({ orgId: "o1", userId: "u1", priceId: "price_1", mode: "subscription" }),
    ).rejects.toThrow("já tem uma assinatura");
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("syncs the current state from Stripe, not the (possibly stale) event payload", async () => {
    const stripe = fakeStripe({
      id: "sub_1",
      status: "canceled",
      metadata: {},
      customer: "cus_1",
      cancel_at_period_end: false,
      items: { data: [{ price: { id: "price_1" }, current_period_end: 1_900_000_000 }] },
    });
    const { calls, service } = await setup(stripe, {
      organizations: [{ data: { id: "o1" }, error: null }],
    });
    await service.handleStripeEvent({
      id: "evt",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_1", status: "active" } },
    } as never);
    const upsert = calls.find((c) => c.table === "subscriptions" && c.method === "upsert");
    expect(upsert?.args[0]).toMatchObject({ id: "sub_1", status: "canceled", org_id: "o1" });
    // No orgId in metadata: found through the customer.
    expect(calls).toContainEqual({ table: "organizations", method: "eq", args: ["stripe_customer_id", "cus_1"] });
  });

  it("ignores subscription events for deleted accounts", async () => {
    const stripe = fakeStripe({
      id: "sub_1",
      status: "canceled",
      metadata: {},
      customer: "cus_1",
      items: { data: [] },
    });
    const { calls, service } = await setup(stripe, {
      organizations: [{ data: null, error: null }],
    });
    await service.handleStripeEvent({
      id: "evt",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_1" } },
    } as never);
    expect(calls.some((c) => c.table === "subscriptions" && c.method === "upsert")).toBe(false);
  });
});

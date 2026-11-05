import { afterEach, describe, expect, it, vi } from "vitest";
import { claimsFor, fakeSupabase, mockAdmin, mockServerClient } from "./helpers/admin-mock";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  for (const mod of [
    "@/lib/supabase/admin",
    "@/lib/supabase/server",
    "@/lib/rate-limit",
    "@/lib/request",
    "@/lib/reauth",
    "@/lib/audit",
    "@/lib/log",
    "@/features/billing/service",
    "@/features/billing/stripe",
  ]) {
    vi.doUnmock(mod);
  }
});

const USER = "11111111-1111-4111-8111-111111111111";

function stubs({ verify = { ok: true, client: fakeSupabase().client } as unknown, stripeOn = true } = {}) {
  const audit = vi.fn(async () => {});
  const cancelCustomerBilling = vi.fn(async () => {});
  const verifyPassword = vi.fn(async () => verify);
  vi.doMock("@/lib/rate-limit", () => ({
    rateLimit: vi.fn(async () => ({ allowed: true, remaining: 1, resetAt: new Date() })),
  }));
  vi.doMock("@/lib/request", () => ({ clientIp: async () => "1.2.3.4" }));
  vi.doMock("@/lib/audit", () => ({ audit }));
  vi.doMock("@/lib/log", () => ({ reportError: vi.fn() }));
  vi.doMock("@/lib/reauth", () => ({ verifyPassword }));
  vi.doMock("@/features/billing/service", () => ({ cancelCustomerBilling }));
  vi.doMock("@/features/billing/stripe", () => ({ stripe: stripeOn ? {} : null }));
  return { audit, cancelCustomerBilling, verifyPassword };
}

describe("deleteMyAccount", () => {
  const files = { data: [{ name: "a.pdf", id: "f1", metadata: { size: 10 }, created_at: "2026-01-01" }], error: null };

  it("requires the current password", async () => {
    const { verifyPassword } = stubs();
    mockAdmin();
    mockServerClient({ claims: claimsFor(USER) });
    const { deleteMyAccount } = await import("@/features/account/actions");
    expect((await deleteMyAccount({})).ok).toBe(false);
    expect(verifyPassword).not.toHaveBeenCalled();
  });

  it("refuses a wrong password and deletes nothing", async () => {
    stubs({ verify: { ok: false, code: "invalid_credentials", status: 400 } });
    const admin = mockAdmin();
    mockServerClient({ claims: claimsFor(USER) });
    const { deleteMyAccount } = await import("@/features/account/actions");
    expect(await deleteMyAccount({ password: "errada" }, "tok")).toMatchObject({
      ok: false,
      fieldErrors: { password: ["Senha incorreta"] },
    });
    expect(admin.client.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("cancels Stripe, removes files, anonymizes the audit trail (actor, IP and entity_id) and deletes the user", async () => {
    const { cancelCustomerBilling, verifyPassword, audit } = stubs();
    const admin = mockAdmin(
      {
        memberships: [{ data: [], error: null }],
        organizations: [{ data: { stripe_customer_id: "cus_org" }, error: null }],
      },
      {},
      { storage: { list: [files] } },
    );
    const server = mockServerClient({ claims: claimsFor(USER) });
    const { deleteMyAccount } = await import("@/features/account/actions");

    expect(await deleteMyAccount({ password: "certa" }, "tok")).toEqual({ ok: true });
    expect(verifyPassword).toHaveBeenCalledWith(`${USER}@x.com`, "certa", "tok");
    expect(cancelCustomerBilling).toHaveBeenCalledWith("cus_org");
    expect(admin.calls).toContainEqual({ table: "jobs", method: "eq", args: ["user_id", USER] });
    expect(admin.calls).toContainEqual({ table: "invitations", method: "eq", args: ["email", `${USER}@x.com`] });
    expect(admin.calls).toContainEqual({ table: "storage:user-files", method: "remove", args: [[`${USER}/a.pdf`]] });
    const updates = admin.calls.filter((c) => c.table === "audit_logs" && c.method === "update").map((c) => c.args[0]);
    expect(updates).toEqual([{ actor_id: null, ip: null }, { entity_id: null }]);
    expect(admin.calls).toContainEqual({ table: "audit_logs", method: "eq", args: ["entity_id", USER] });
    expect(admin.client.auth.admin.deleteUser).toHaveBeenCalledWith(USER);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "user.deleted", actorId: null }));
    expect(server.client.auth.signOut).toHaveBeenCalled();
  });

  it("keeps the account (and says so) when a step fails", async () => {
    const { cancelCustomerBilling } = stubs();
    cancelCustomerBilling.mockRejectedValueOnce(new Error("stripe down"));
    const admin = mockAdmin({
      memberships: [{ data: [], error: null }],
      organizations: [{ data: { stripe_customer_id: "cus_1" }, error: null }],
    });
    mockServerClient({ claims: claimsFor(USER) });
    const { deleteMyAccount } = await import("@/features/account/actions");
    expect((await deleteMyAccount({ password: "certa" })).ok).toBe(false);
    expect(admin.client.auth.admin.deleteUser).not.toHaveBeenCalled();
  });

  it("runs the local steps first and clears the stored customer id right after cancelling Stripe", async () => {
    const { cancelCustomerBilling } = stubs();
    const admin = mockAdmin(
      {
        memberships: [{ data: [], error: null }],
        organizations: [{ data: { stripe_customer_id: "cus_org" }, error: null }],
      },
      {},
      { storage: { list: [files] } },
    );
    cancelCustomerBilling.mockImplementation(async () => {
      // Files, jobs and the audit trail are handled before Stripe; the user still exists.
      expect(admin.calls.some((c) => c.table === "storage:user-files" && c.method === "remove")).toBe(true);
      expect(admin.calls.some((c) => c.table === "jobs" && c.method === "delete")).toBe(true);
      expect(admin.client.auth.admin.deleteUser).not.toHaveBeenCalled();
    });
    admin.client.auth.admin.deleteUser.mockResolvedValueOnce({ data: {}, error: { message: "auth down" } } as never);
    mockServerClient({ claims: claimsFor(USER) });
    const { deleteMyAccount } = await import("@/features/account/actions");

    expect((await deleteMyAccount({ password: "certa" })).ok).toBe(false);
    expect(cancelCustomerBilling).toHaveBeenCalledWith("cus_org");
    // The deletion failed after Stripe: the account must not keep pointing to the deleted customer.
    expect(admin.calls).toContainEqual({
      table: "organizations",
      method: "update",
      args: [{ stripe_customer_id: null }],
    });
  });

  it("refuses while the user is the only owner of a team organization", async () => {
    const { cancelCustomerBilling } = stubs();
    const admin = mockAdmin({
      memberships: [
        { data: [{ org_id: "team-1", organizations: { personal_owner_id: null } }], error: null },
        { data: null, error: null, count: 1 },
      ],
    });
    mockServerClient({ claims: claimsFor(USER) });
    const { deleteMyAccount } = await import("@/features/account/actions");
    const result = await deleteMyAccount({ password: "certa" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("único dono") });
    expect(cancelCustomerBilling).not.toHaveBeenCalled();
    expect(admin.client.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
});

describe("exportMyData", () => {
  it("includes the user's audit rows and paginates past the 1000-row API cap", async () => {
    stubs();
    const page = (n: number, offset = 0) =>
      Array.from({ length: n }, (_, i) => ({ id: `n${offset + i}`, title: "x", created_at: "2026-01-01" }));
    const admin = mockAdmin({
      audit_logs: [{ data: [{ action: "user.role_changed", entity: "user", entity_id: USER }], error: null }],
    });
    mockServerClient({
      claims: claimsFor(USER),
      results: {
        profiles: [{ data: { id: USER, created_at: "2026-01-01" }, error: null }],
        organizations: [{ data: [{ id: "o1", name: "Ana", personal_owner_id: USER }], error: null }],
        memberships: [{ data: [{ org_id: "o1", user_id: USER, role: "owner" }], error: null }],
        notifications: [
          { data: page(1000), error: null },
          { data: page(3, 1000), error: null },
        ],
        subscriptions: [{ data: [], error: null }],
      },
    });
    const { exportMyData } = await import("@/features/account/actions");
    const result = await exportMyData();
    expect(result.ok).toBe(true);
    const data = result.ok
      ? (result.data as { notifications: unknown[]; auditLogs: unknown[]; organizations: unknown[] })
      : null;
    expect(data?.notifications).toHaveLength(1003);
    expect(data?.organizations).toHaveLength(1);
    expect(data?.auditLogs).toEqual([{ action: "user.role_changed", entity: "user", entity_id: USER }]);
    expect(admin.calls).toContainEqual({
      table: "audit_logs",
      method: "or",
      args: [`actor_id.eq.${USER},entity_id.eq.${USER}`],
    });
  });
});

describe("cancelCustomerBilling", () => {
  const setup = async (stripe: Record<string, unknown>) => {
    mockAdmin();
    vi.doMock("@/features/billing/stripe", () => ({
      stripe,
      billingConfig: { enabled: true, allowedPriceIds: [], successUrl: "s", cancelUrl: "c", portalReturnUrl: "p" },
    }));
    vi.doMock("@/lib/notifications", () => ({ notify: vi.fn() }));
    vi.doMock("@/lib/audit", () => ({ audit: vi.fn() }));
    return (await import("@/features/billing/service")).cancelCustomerBilling;
  };

  it("cancels live subscriptions before deleting the customer", async () => {
    const stripe = {
      subscriptions: {
        list: vi.fn(async () => ({
          data: [
            { id: "sub_live", status: "active" },
            { id: "sub_old", status: "canceled" },
          ],
        })),
        cancel: vi.fn(async () => ({})),
      },
      customers: { del: vi.fn(async () => ({})) },
    };
    const cancel = await setup(stripe);
    await cancel("cus_1");
    expect(stripe.subscriptions.cancel).toHaveBeenCalledTimes(1);
    expect(stripe.subscriptions.cancel).toHaveBeenCalledWith("sub_live");
    expect(stripe.customers.del).toHaveBeenCalledWith("cus_1");
  });

  it("treats a customer already deleted in Stripe as done", async () => {
    const stripe = {
      subscriptions: { list: vi.fn(async () => Promise.reject({ code: "resource_missing" })), cancel: vi.fn() },
      customers: { del: vi.fn() },
    };
    const cancel = await setup(stripe);
    await expect(cancel("cus_gone")).resolves.toBeUndefined();
  });
});

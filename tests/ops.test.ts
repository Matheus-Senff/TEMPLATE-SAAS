import { afterEach, describe, expect, it, vi } from "vitest";
import { claimsFor, expectRedirect, mockAdmin, mockServerClient } from "./helpers/admin-mock";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.restoreAllMocks();
  for (const mod of [
    "@/lib/supabase/admin",
    "@/lib/supabase/server",
    "@/lib/email",
    "@/lib/log",
    "@/lib/jobs",
    "@/lib/audit",
    "@/lib/notifications",
    "@/lib/rate-limit",
    "@/lib/request",
    "next/server",
  ]) {
    vi.doUnmock(mod);
  }
});

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "99999999-9999-4999-8999-999999999999";

describe("job queue", () => {
  const job = (overrides: Record<string, unknown> = {}) => ({
    id: "job-1",
    type: "email.send",
    payload: { to: "a@x.com", subject: "Oi", html: "<p>Oi</p>" },
    attempts: 1,
    ...overrides,
  });

  it("backs off exponentially, capped at 6 hours", async () => {
    mockAdmin();
    const { backoffSeconds } = await import("@/lib/jobs");
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([30, 60, 120, 240]);
    expect(backoffSeconds(30)).toBe(6 * 60 * 60);
  });

  it("enqueue stores the job first and processes it after the response", async () => {
    const after = vi.fn();
    vi.doMock("next/server", async (orig) => ({ ...(await orig<Record<string, unknown>>()), after }));
    const admin = mockAdmin({ jobs: [{ data: [{ id: "job-1" }], error: null }] });
    const { enqueue } = await import("@/lib/jobs");
    expect(await enqueue("email.send", { to: "a@x.com", subject: "s", html: "h" }, { userId: USER })).toBe("job-1");
    const upsert = admin.calls.find((c) => c.table === "jobs" && c.method === "upsert");
    expect(upsert?.args[0]).toMatchObject({ type: "email.send", user_id: USER, max_attempts: 5 });
    expect(upsert?.args[1]).toEqual({ onConflict: "idempotency_key", ignoreDuplicates: true });
    expect(after).toHaveBeenCalledOnce();
  });

  it("enqueue fails loudly when the job cannot be stored (the caller must not report success)", async () => {
    mockAdmin({ jobs: [{ data: null, error: { message: "db down" } }] });
    const { enqueue } = await import("@/lib/jobs");
    await expect(enqueue("email.send", { to: "a@x.com", subject: "s", html: "h" })).rejects.toThrow("db down");
  });

  it("runs handlers with the job id as idempotency key and completes the job", async () => {
    const sendEmail = vi.fn(async () => ({ id: "re_1" }));
    vi.doMock("@/lib/email", () => ({ sendEmail }));
    const admin = mockAdmin(
      {},
      { claim_jobs: [{ data: [job()], error: null }], complete_job: { data: null, error: null } },
    );
    const { runJobs } = await import("@/lib/jobs");
    expect(await runJobs({ limit: 10 })).toEqual({ claimed: 1, done: 1, retried: 0, dead: 0 });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "a@x.com", idempotencyKey: "job-job-1" }));
    expect(admin.calls).toContainEqual({ table: "rpc:complete_job", method: "rpc", args: [{ p_id: "job-1" }] });
  });

  it("schedules a retry with backoff when the handler fails", async () => {
    vi.doMock("@/lib/email", () => ({ sendEmail: vi.fn(async () => Promise.reject(new Error("Resend 500"))) }));
    const admin = mockAdmin(
      {},
      { claim_jobs: [{ data: [job({ attempts: 2 })], error: null }], fail_job: { data: "pending", error: null } },
    );
    const { runJobs } = await import("@/lib/jobs");
    expect(await runJobs()).toMatchObject({ retried: 1, dead: 0 });
    expect(admin.calls).toContainEqual({
      table: "rpc:fail_job",
      method: "rpc",
      args: [{ p_id: "job-1", p_error: "Resend 500", p_retry_in_seconds: 60 }],
    });
  });

  it("reports a job that died after its last attempt", async () => {
    const reportError = vi.fn();
    vi.doMock("@/lib/log", () => ({ reportError }));
    mockAdmin(
      {},
      { claim_jobs: [{ data: [job({ type: "unknown.type" })], error: null }], fail_job: { data: "dead", error: null } },
    );
    const { runJobs } = await import("@/lib/jobs");
    expect(await runJobs()).toMatchObject({ dead: 1 });
    expect(reportError).toHaveBeenCalledWith("jobs", expect.any(Error), expect.objectContaining({ jobId: "job-1" }));
  });

  it("/api/cron/jobs requires the cron secret", async () => {
    vi.stubEnv("CRON_SECRET", "a-long-random-secret-123");
    mockAdmin({}, { claim_jobs: { data: [], error: null } });
    const { GET } = await import("@/app/api/cron/jobs/route");
    expect((await GET(new Request("http://x/api/cron/jobs") as never)).status).toBe(401);
    const ok = await GET(
      new Request("http://x/api/cron/jobs", { headers: { authorization: "Bearer a-long-random-secret-123" } }) as never,
    );
    expect(await ok.json()).toEqual({ ok: true, claimed: 0, done: 0, retried: 0, dead: 0 });
  });
});

describe("notify with e-mail", () => {
  it("queues an e-mail to the user for critical events", async () => {
    const enqueue = vi.fn(async () => "job-1");
    vi.doMock("@/lib/jobs", () => ({ enqueue }));
    mockAdmin({
      notifications: [{ data: null, error: null }],
      profiles: [{ data: { email: "ana@x.com" }, error: null }],
    });
    const { notify } = await import("@/lib/notifications");
    expect(await notify(USER, { type: "error", title: "Falha no pagamento", link: "/painel" }, { email: true })).toBe(
      true,
    );
    expect(enqueue).toHaveBeenCalledWith(
      "email.send",
      expect.objectContaining({ to: "ana@x.com", subject: "Falha no pagamento" }),
      { userId: USER },
    );
  });

  it("does nothing for a deleted user (no retry loop)", async () => {
    const enqueue = vi.fn();
    vi.doMock("@/lib/jobs", () => ({ enqueue }));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAdmin({ notifications: [{ data: null, error: { code: "23503", message: "fk" } }] });
    const { notify } = await import("@/lib/notifications");
    expect(await notify(USER, { title: "x" }, { email: true })).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("feature flags", () => {
  it("uses the table row, then FLAG_<KEY>, then the code default", async () => {
    mockAdmin({ feature_flags: [{ data: [{ key: "novo_painel", enabled: true }], error: null }] });
    expect(await (await import("@/lib/flags")).isEnabled("novo_painel")).toBe(true);

    vi.resetModules();
    vi.stubEnv("FLAG_NOVO_PAINEL", "true");
    mockAdmin({ feature_flags: [{ data: [], error: null }] });
    expect(await (await import("@/lib/flags")).isEnabled("novo_painel")).toBe(true);

    vi.resetModules();
    vi.unstubAllEnvs();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAdmin({ feature_flags: [{ data: null, error: { message: "down" } }] });
    expect(await (await import("@/lib/flags")).isEnabled("novo_painel")).toBe(false);
  });
});

describe("organizations", () => {
  const stubs = () => {
    const audit = vi.fn(async () => {});
    const enqueue = vi.fn(async () => "job-1");
    vi.doMock("@/lib/audit", () => ({ audit }));
    vi.doMock("@/lib/jobs", () => ({ enqueue }));
    vi.doMock("@/lib/log", () => ({ reportError: vi.fn() }));
    vi.doMock("@/lib/notifications", () => ({ notify: vi.fn(async () => true) }));
    vi.doMock("@/lib/request", () => ({ clientIp: async () => "1.2.3.4" }));
    const rateLimitAll = vi.fn(async () => true);
    vi.doMock("@/lib/rate-limit", () => ({
      rateLimit: vi.fn(async () => ({ allowed: true, remaining: 1, resetAt: new Date() })),
      rateLimitAll,
    }));
    return { audit, enqueue, rateLimitAll };
  };

  it("creates a team organization with the caller as owner (and rolls back on failure)", async () => {
    stubs();
    const admin = mockAdmin({
      organizations: [
        { data: { id: ORG }, error: null },
        { data: null, error: null },
      ],
      memberships: [{ data: null, error: { message: "boom" } }],
    });
    mockServerClient({ claims: claimsFor(USER) });
    const { createOrganization } = await import("@/features/organizations/actions");
    expect((await createOrganization({ name: "Equipe" })).ok).toBe(false);
    expect(admin.calls).toContainEqual({ table: "organizations", method: "delete", args: [] });
  });

  it("only admins of the organization can invite", async () => {
    const { enqueue } = stubs();
    mockAdmin();
    mockServerClient({ claims: claimsFor(USER), rpc: { has_org_role: { data: false, error: null } } });
    const { inviteMember } = await import("@/features/organizations/actions");
    expect(await inviteMember({ orgId: ORG, email: "novo@x.com" })).toMatchObject({ ok: false });
    expect(enqueue).not.toHaveBeenCalled();
  });

  const confirmed = (at: string | null) => ({
    auth: { admin: { getUserById: vi.fn(async () => ({ data: { user: { email_confirmed_at: at } }, error: null })) } },
  });

  it("refuses invitations from an account whose e-mail is not confirmed", async () => {
    const { enqueue } = stubs();
    const admin = mockAdmin({}, {}, confirmed(null));
    mockServerClient({ claims: claimsFor(USER), rpc: { has_org_role: { data: true, error: null } } });
    const { inviteMember } = await import("@/features/organizations/actions");
    expect(await inviteMember({ orgId: ORG, email: "novo@x.com" })).toMatchObject({ ok: false });
    expect(enqueue).not.toHaveBeenCalled();
    expect(admin.calls.some((c) => c.table === "invitations")).toBe(false);
  });

  it("limits invitations per inviter and per organization", async () => {
    const { rateLimitAll } = stubs();
    mockAdmin({}, {}, confirmed("2026-01-01T00:00:00Z"));
    mockServerClient({ claims: claimsFor(USER), rpc: { has_org_role: { data: true, error: null } } });
    const { inviteMember } = await import("@/features/organizations/actions");
    await inviteMember({ orgId: ORG, email: "novo@x.com" });
    const keys = (rateLimitAll.mock.calls[0] as unknown as [Array<[string, number, number]>])[0];
    expect(keys).toEqual([
      [`org:invite:${USER}`, 10, 3600],
      [`org:invite:org:${ORG}`, 30, 86_400],
    ]);
  });

  it("keeps the (user-controlled) organization name out of the subject, escaped and short in the body", async () => {
    mockAdmin();
    const { invitationEmail } = await import("@/features/organizations/service");
    const mail = invitationEmail({
      inviter: "Ana (ana@x.com)",
      orgName: `<b>GANHE PRÊMIO</b> ${"x".repeat(200)}`,
      link: "https://app.test/convite?token=t",
    });
    expect(mail.subject).toBe("Você recebeu um convite");
    expect(mail.html).toContain("&lt;b&gt;GANHE");
    expect(mail.html).not.toContain("<b>GANHE");
    expect(mail.text).toContain("Ana (ana@x.com) convidou você");
    expect(mail.text.length).toBeLessThan(260);
  });

  it("stores only the token hash and e-mails the link through the job queue", async () => {
    const { enqueue } = stubs();
    const admin = mockAdmin(
      {
        organizations: [{ data: { name: "Equipe" }, error: null }],
        profiles: [{ data: { full_name: "Ana", email: "ana@x.com" }, error: null }],
      },
      {},
      confirmed("2026-01-01T00:00:00Z"),
    );
    mockServerClient({ claims: claimsFor(USER), rpc: { has_org_role: { data: true, error: null } } });
    const { inviteMember } = await import("@/features/organizations/actions");
    expect(await inviteMember({ orgId: ORG, email: "Novo@X.com", role: "member" })).toEqual({ ok: true });
    const insert = admin.calls.find((c) => c.table === "invitations" && c.method === "insert")?.args[0] as {
      token_hash: string;
      email: string;
    };
    expect(insert.email).toBe("novo@x.com");
    const text = (enqueue.mock.calls[0] as unknown as [string, { text: string }])[1].text;
    const token = /token=([\w-]+)/.exec(text)?.[1] ?? "";
    const { hashInvitationToken } = await import("@/features/organizations/service");
    expect(insert.token_hash).toBe(hashInvitationToken(token));
    expect(text).not.toContain(insert.token_hash);
  });

  it("accepts an invitation only for the invited e-mail", async () => {
    stubs();
    mockAdmin({
      invitations: [
        { data: { id: "i1", org_id: ORG, email: "outra@x.com", role: "member", invited_by: null }, error: null },
      ],
    });
    mockServerClient({ claims: claimsFor(USER) });
    const { acceptInvitation } = await import("@/features/organizations/actions");
    const form = new FormData();
    form.set("token", "x".repeat(43));
    expect(await expectRedirect(acceptInvitation(form))).toBe("/painel?convite=invalido");
  });

  it("adds the membership and marks the invitation as used", async () => {
    const { audit } = stubs();
    const admin = mockAdmin({
      invitations: [
        { data: { id: "i1", org_id: ORG, email: `${USER}@x.com`, role: "member", invited_by: null }, error: null },
      ],
    });
    mockServerClient({ claims: claimsFor(USER) });
    const { acceptInvitation } = await import("@/features/organizations/actions");
    const form = new FormData();
    form.set("token", "x".repeat(43));
    expect(await expectRedirect(acceptInvitation(form))).toBe("/painel?convite=aceito");
    expect(admin.calls).toContainEqual({
      table: "memberships",
      method: "upsert",
      args: [
        { org_id: ORG, user_id: USER, role: "member" },
        { onConflict: "org_id,user_id", ignoreDuplicates: true },
      ],
    });
    expect(admin.calls.some((c) => c.table === "invitations" && c.method === "update")).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: "org.member_joined" }));
  });
});

describe("notify idempotency", () => {
  it("stores the key and, on a redelivery, still queues the (deduplicated) e-mail without failing", async () => {
    const enqueue = vi.fn(async () => "job-1");
    vi.doMock("@/lib/jobs", () => ({ enqueue }));
    const admin = mockAdmin({
      notifications: [{ data: null, error: { code: "23505", message: "duplicate key" } }],
      profiles: [{ data: { email: "ana@x.com" }, error: null }],
    });
    const { notify } = await import("@/lib/notifications");
    expect(await notify(USER, { title: "Falha no pagamento" }, { email: true, idempotencyKey: "evt_1:u1" })).toBe(true);
    const insert = admin.calls.find((c) => c.table === "notifications" && c.method === "insert");
    expect(insert?.args[0]).toMatchObject({ idempotency_key: "evt_1:u1" });
    expect(enqueue).toHaveBeenCalledWith("email.send", expect.objectContaining({ to: "ana@x.com" }), {
      userId: USER,
      idempotencyKey: "notify:evt_1:u1",
    });
  });

  it("without a key, a unique violation is still an error", async () => {
    vi.doMock("@/lib/jobs", () => ({ enqueue: vi.fn() }));
    mockAdmin({ notifications: [{ data: null, error: { code: "23505", message: "duplicate key" } }] });
    const { notify } = await import("@/lib/notifications");
    await expect(notify(USER, { title: "x" })).rejects.toThrow("duplicate key");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSupabaseTestDb } from "./helpers/supabase-db";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
let t: Awaited<ReturnType<typeof createSupabaseTestDb>>;

beforeAll(async () => {
  t = await createSupabaseTestDb();
  await t.createUser(A, "a@x.com", "Ana");
  await t.createUser(B, "b@x.com", "Bruno");
});
afterAll(() => t.close());

describe("profiles", () => {
  it("is created by the auth trigger with the user's name", async () => {
    const rows = await t.asService.query<{ full_name: string; role: string }>(
      `select full_name, role from public.profiles where id = $1`,
      [A],
    );
    expect(rows).toEqual([{ full_name: "Ana", role: "member" }]);
  });

  it("each user sees only their own profile", async () => {
    const rows = await t.as(A).query<{ id: string }>(`select id from public.profiles`);
    expect(rows.map((r) => r.id)).toEqual([A]);
  });

  it("a user cannot promote themselves to admin", async () => {
    await expect(t.as(A).query(`update public.profiles set role = 'admin' where id = $1`, [A])).rejects.toThrow(
      /permission denied/,
    );
    await t.as(A).query(`update public.profiles set full_name = 'Ana Souza' where id = $1`, [A]);
    const rows = await t.asService.query<{ full_name: string; role: string }>(
      `select full_name, role from public.profiles where id = $1`,
      [A],
    );
    expect(rows[0]).toEqual({ full_name: "Ana Souza", role: "member" });
  });

  it("anonymous visitors have no access to any table", async () => {
    for (const table of ["profiles", "notifications", "subscriptions"]) {
      await expect(t.anon.query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
    }
  });
});

describe("notifications", () => {
  it("a welcome notification is created with the account", async () => {
    const rows = await t.as(A).query<{ title: string; link: string }>(`select title, link from public.notifications`);
    expect(rows).toEqual([{ title: "Bem-vindo(a)!", link: "/painel" }]);
  });

  it("users read and mark only their own, and cannot create them", async () => {
    await t.asService.query(`delete from public.notifications`);
    await t.asService.query(`insert into public.notifications (user_id, title) values ($1, 'para A'), ($2, 'para B')`, [
      A,
      B,
    ]);
    const mine = await t.as(A).query<{ title: string }>(`select title from public.notifications`);
    expect(mine.map((n) => n.title)).toEqual(["para A"]);

    const touched = await t
      .as(A)
      .query(`update public.notifications set read_at = now() where user_id = $1 returning id`, [B]);
    expect(touched).toEqual([]);
    await expect(
      t.as(A).query(`insert into public.notifications (user_id, title) values ($1, 'x')`, [A]),
    ).rejects.toThrow(/permission denied/);
    await expect(t.as(A).query(`update public.notifications set title = 'x'`)).rejects.toThrow(/permission denied/);
  });

  it("rejects backslash links (browsers read /\\evil.com as //evil.com)", async () => {
    await expect(
      t.asService.query(`insert into public.notifications (user_id, title, link) values ($1, 'x', $2)`, [
        A,
        "/\\evil.com",
      ]),
    ).rejects.toThrow(/check constraint/);
  });

  it("rejects absolute links (open redirect)", async () => {
    await expect(
      t.asService.query(`insert into public.notifications (user_id, title, link) values ($1, 'x', '//evil.com')`, [A]),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("realtime (broadcast from the database)", () => {
  const topic = (id: string) => `user:${id}:notifications`;

  it("each new notification is broadcast to the owner's private topic", async () => {
    await t.asService.query(`insert into public.notifications (user_id, title) values ($1, 'ao vivo')`, [A]);
    const rows = await t.root.query<{ topic: string; event: string; private: boolean; payload: { title: string } }>(
      `select topic, event, private, payload from realtime.messages where payload ->> 'title' = 'ao vivo'`,
    );
    expect(rows).toEqual([
      {
        topic: topic(A),
        event: "notification_created",
        private: true,
        payload: expect.objectContaining({ title: "ao vivo" }),
      },
    ]);
  });

  it("only the owner is authorized to join that private channel", async () => {
    const asA = (channel: string) =>
      t
        .as(A, { settings: { "realtime.topic": channel } })
        .query<{ topic: string }>(`select topic from realtime.messages where extension = 'broadcast'`);
    expect((await asA(topic(A))).length).toBeGreaterThan(0);
    expect(await asA(topic(B))).toEqual([]);
  });

  it("notifications are not streamed with postgres_changes", async () => {
    const rows = await t.root.query(
      `select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'notifications'`,
    );
    expect(rows).toEqual([]);
  });
});

describe("server-only tables", () => {
  it.each(["audit_logs", "webhook_events", "rate_limits"])("%s is closed to signed-in users", async (table) => {
    await expect(t.as(A).query(`select * from public.${table}`)).rejects.toThrow(/permission denied/);
  });

  it("rate_limit() is not callable by users", async () => {
    await expect(t.as(A).query(`select * from public.rate_limit('k', 1, 60)`)).rejects.toThrow(/permission denied/);
  });
});

describe("rate_limit()", () => {
  it("allows up to the limit inside the window", async () => {
    const hit = async () =>
      (
        await t.asService.query<{ allowed: boolean }>(`select allowed from public.rate_limit('login:1.2.3.4', 2, 60)`)
      )[0]?.allowed;
    expect(await hit()).toBe(true);
    expect(await hit()).toBe(true);
    expect(await hit()).toBe(false);
  });
});

describe("storage", () => {
  it("users only see files under their own folder", async () => {
    await t.asService.query(
      `insert into storage.objects (bucket_id, name) values ('user-files', $1), ('user-files', $2)`,
      [`${A}/a.pdf`, `${B}/b.pdf`],
    );
    const rows = await t.as(A).query<{ name: string }>(`select name from storage.objects`);
    expect(rows.map((r) => r.name)).toEqual([`${A}/a.pdf`]);
    await expect(
      t.as(A).query(`insert into storage.objects (bucket_id, name) values ('user-files', $1)`, [`${B}/x.pdf`]),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("storage quota (bytes per user)", () => {
  const C = "33333333-3333-3333-3333-333333333333";
  const upload = (name: string, size: number | null) =>
    t
      .as(C)
      .query(`insert into storage.objects (bucket_id, name, metadata) values ('user-files', $1, $2)`, [
        name,
        size === null ? null : JSON.stringify({ size }),
      ]);

  it("counts only the user's own bytes in the bucket", async () => {
    await t.createUser(C);
    await t.root.query(`insert into storage.buckets (id, name) values ('other', 'other') on conflict (id) do nothing`);
    await t.asService.query(
      `insert into storage.objects (bucket_id, name, metadata) values
        ('user-files', $1, '{"size": 600000000}'), ('other', $2, '{"size": 900000000}'),
        ('user-files', $3, '{"size": 900000000}')`,
      [`${C}/big.pdf`, `${C}/elsewhere.pdf`, `${A}/not-mine.pdf`],
    );
    const [row] = await t.as(C).query<{ bytes: string }>(`select public.user_storage_bytes() as bytes`);
    expect(Number(row?.bytes)).toBe(600000000);
  });

  it("allows uploads under the quota and blocks the one that would exceed it", async () => {
    await expect(upload(`${C}/ok.pdf`, 400000000)).resolves.toBeDefined();
    await expect(upload(`${C}/too-much.pdf`, 200000000)).rejects.toThrow(/row-level security/);
  });

  it("blocks any upload once the stored total reaches the quota", async () => {
    await t.asService.query(
      `insert into storage.objects (bucket_id, name, metadata) values ('user-files', $1, '{"size": 100000000}')`,
      [`${C}/fill.pdf`],
    );
    await expect(upload(`${C}/tiny.txt`, null)).rejects.toThrow(/row-level security/);
  });

  it("matches the folder by prefix: another user's id as a sub-folder does not count as own", async () => {
    await expect(upload(`x/${C}/sneaky.pdf`, 1)).rejects.toThrow(/row-level security/);
  });
});

describe("storage after account deletion", () => {
  it("a still-valid JWT cannot upload once the profile is gone (no orphan files)", async () => {
    const D = "44444444-4444-4444-4444-444444444444";
    await t.createUser(D);
    await t.root.query(`delete from auth.users where id = $1`, [D]);
    await expect(
      t.as(D).query(`insert into storage.objects (bucket_id, name) values ('user-files', $1)`, [`${D}/orphan.pdf`]),
    ).rejects.toThrow(/row-level security/);
  });

  it("users can rename files only inside their own folder", async () => {
    await expect(
      t.as(A).query(`update storage.objects set name = $1 where name = $2`, [`${B}/stolen.pdf`, `${A}/a.pdf`]),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("organizations", () => {
  const G = "66666666-6666-6666-6666-666666666666";
  let team = "";
  const personalOf = async (user: string) =>
    (
      await t.asService.query<{ id: string }>(`select id from public.organizations where personal_owner_id = $1`, [
        user,
      ])
    )[0]!.id;

  beforeAll(async () => {
    await t.createUser(G, "g@x.com", "Gabi");
    team = (
      await t.asService.query<{ id: string }>(`insert into public.organizations (name) values ('Equipe') returning id`)
    )[0]!.id;
    await t.asService.query(
      `insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'member')`,
      [team, A, G],
    );
  });

  it("every account gets a personal organization it owns, in the sign-up transaction", async () => {
    const rows = await t.as(A).query<{ name: string; role: string }>(
      `select o.name, m.role from public.organizations o join public.memberships m on m.org_id = o.id
       where o.personal_owner_id = $1`,
      [A],
    );
    expect(rows).toEqual([{ name: "Ana", role: "owner" }]);
  });

  it("members see only their organizations and the members of those", async () => {
    const orgsOfB = await t.as(B).query<{ id: string }>(`select id from public.organizations`);
    expect(orgsOfB.map((o) => o.id)).toEqual([await personalOf(B)]);
    const membersSeenByG = await t
      .as(G)
      .query<{ user_id: string }>(`select user_id from public.memberships where org_id = $1 order by user_id`, [team]);
    expect(membersSeenByG.map((m) => m.user_id)).toEqual([A, G]);
    expect(await t.as(B).query(`select 1 from public.memberships where org_id = $1`, [team])).toEqual([]);
  });

  it("helpers answer by role: owner > admin > member", async () => {
    const check = (user: string, sql: string) =>
      t
        .as(user)
        .query<{ ok: boolean }>(sql, [team])
        .then((r) => r[0]?.ok);
    expect(await check(A, `select public.has_org_role($1, 'admin') as ok`)).toBe(true);
    expect(await check(G, `select public.has_org_role($1, 'admin') as ok`)).toBe(false);
    expect(await check(G, `select public.has_org_role($1, 'member') as ok`)).toBe(true);
    expect(await check(G, `select public.is_org_member($1) as ok`)).toBe(true);
    expect(await check(B, `select public.is_org_member($1) as ok`)).toBe(false);
  });

  it("only admins rename; nobody changes billing ids or joins an organization by themselves", async () => {
    expect(
      await t.as(G).query(`update public.organizations set name = 'x' where id = $1 returning id`, [team]),
    ).toEqual([]);
    await t.as(A).query(`update public.organizations set name = 'Equipe A' where id = $1`, [team]);
    await expect(
      t.as(A).query(`update public.organizations set stripe_customer_id = 'cus_x' where id = $1`, [team]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      t.as(B).query(`insert into public.memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [team, B]),
    ).rejects.toThrow(/permission denied/);
  });

  it("billing is per organization: members read its subscription, others do not", async () => {
    await t.asService.query(
      `insert into public.subscriptions (id, org_id, status, current_period_end) values ('sub_team', $1, 'active', now() + interval '1 month')`,
      [team],
    );
    expect(await t.as(G).query(`select id from public.subscriptions where org_id = $1`, [team])).toEqual([
      { id: "sub_team" },
    ]);
    expect(await t.as(B).query(`select id from public.subscriptions where org_id = $1`, [team])).toEqual([]);
    const active = (user: string) =>
      t
        .as(user)
        .query<{ ok: boolean }>(`select public.has_active_subscription($1) as ok`, [team])
        .then((r) => r[0]?.ok);
    expect(await active(G)).toBe(true);
    expect(await active(B)).toBe(false);
  });

  it("invitations: admins list them without seeing the token hash; members see none", async () => {
    await t.asService.query(
      `insert into public.invitations (org_id, email, role, token_hash) values ($1, 'novo@x.com', 'member', 'hash')`,
      [team],
    );
    expect(await t.as(A).query(`select email from public.invitations where org_id = $1`, [team])).toEqual([
      { email: "novo@x.com" },
    ]);
    await expect(t.as(A).query(`select token_hash from public.invitations`)).rejects.toThrow(/permission denied/);
    expect(await t.as(G).query(`select email from public.invitations`)).toEqual([]);
  });
});

describe("jobs (durable queue)", () => {
  const enqueue = (type: string, extra = "") =>
    t.asService
      .query<{ id: string }>(
        `insert into public.jobs (type, payload${extra ? ", max_attempts" : ""}) values ($1, '{}'${extra}) returning id`,
        [type],
      )
      .then((r) => r[0]!.id);
  const status = (id: string) =>
    t.asService
      .query<{ status: string; attempts: number }>(`select status, attempts from public.jobs where id = $1`, [id])
      .then((r) => r[0]);

  it("is closed to users (table and functions)", async () => {
    await expect(t.as(A).query(`select * from public.jobs`)).rejects.toThrow(/permission denied/);
    await expect(t.as(A).query(`select * from public.claim_jobs(10, 300)`)).rejects.toThrow(/permission denied/);
  });

  it("claims each due job once (skip locked), completes it, and does not claim future jobs", async () => {
    const now = await enqueue("test.now");
    const later = (
      await t.asService.query<{ id: string }>(
        `insert into public.jobs (type, run_at) values ('test.later', now() + interval '1 hour') returning id`,
      )
    )[0]!.id;
    const first = await t.asService.query<{ id: string }>(`select id from public.claim_jobs(10, 300)`);
    expect(first.map((j) => j.id)).toContain(now);
    expect(first.map((j) => j.id)).not.toContain(later);
    expect(await t.asService.query(`select id from public.claim_jobs(10, 300)`)).toEqual([]);
    await t.asService.query(`select public.complete_job($1)`, [now]);
    expect(await status(now)).toEqual({ status: "done", attempts: 1 });
  });

  it("retries failures later and marks the job dead after max_attempts", async () => {
    const id = await enqueue("test.flaky", ", 2");
    await t.asService.query(`select public.claim_jobs(10, 300)`);
    const [retry] = await t.asService.query<{ fail_job: string }>(`select public.fail_job($1, 'boom', 60)`, [id]);
    expect(retry?.fail_job).toBe("pending");
    expect(await t.asService.query(`select id from public.claim_jobs(10, 300)`)).toEqual([]);
    await t.asService.query(`update public.jobs set run_at = now() where id = $1`, [id]);
    await t.asService.query(`select public.claim_jobs(10, 300)`);
    const [dead] = await t.asService.query<{ fail_job: string }>(`select public.fail_job($1, 'boom again', 60)`, [id]);
    expect(dead?.fail_job).toBe("dead");
    await t.asService.query(`select public.retry_job($1)`, [id]);
    expect(await status(id)).toEqual({ status: "pending", attempts: 2 });
  });

  it("takes over a job whose worker died (expired lock)", async () => {
    const id = await enqueue("test.crash");
    await t.asService.query(`select public.claim_jobs(10, 300)`);
    await t.asService.query(`update public.jobs set locked_at = now() - interval '10 minutes' where id = $1`, [id]);
    const again = await t.asService.query<{ id: string }>(`select id from public.claim_jobs(10, 300)`);
    expect(again.map((j) => j.id)).toContain(id);
    expect(await status(id)).toEqual({ status: "running", attempts: 2 });
  });
});

describe("feature flags", () => {
  it("signed-in users read them; only the server writes; visitors have no access", async () => {
    await t.asService.query(`insert into public.feature_flags (key, enabled) values ('novo_painel', true)`);
    expect(await t.as(A).query(`select key, enabled from public.feature_flags`)).toEqual([
      { key: "novo_painel", enabled: true },
    ]);
    await expect(t.as(A).query(`update public.feature_flags set enabled = false`)).rejects.toThrow(/permission denied/);
    await expect(t.anon.query(`select * from public.feature_flags`)).rejects.toThrow(/permission denied/);
  });
});

describe("account deletion", () => {
  it("cascades from auth.users to profile, personal organization, notifications and subscriptions", async () => {
    const [org] = await t.asService.query<{ id: string }>(
      `select id from public.organizations where personal_owner_id = $1`,
      [B],
    );
    await t.asService.query(`insert into public.subscriptions (id, org_id, status) values ('sub_1', $1, 'active')`, [
      org?.id,
    ]);
    await t.root.query(`delete from auth.users where id = $1`, [B]);
    for (const table of ["profiles", "notifications", "memberships"]) {
      const column = table === "profiles" ? "id" : "user_id";
      expect(await t.asService.query(`select 1 from public.${table} where ${column} = $1`, [B])).toEqual([]);
    }
    expect(await t.asService.query(`select 1 from public.organizations where personal_owner_id = $1`, [B])).toEqual([]);
    expect(await t.asService.query(`select 1 from public.subscriptions where id = 'sub_1'`)).toEqual([]);
  });
});

describe("retention", () => {
  it("cleanup_old_records() removes old events and old read notifications", async () => {
    await t.asService.query(
      `insert into public.webhook_events (source, id, type, created_at) values ('stripe', 'old', 't', now() - interval '100 days')`,
    );
    await t.asService.query(
      `insert into public.notifications (user_id, title, read_at, created_at) values ($1, 'velha', now(), now() - interval '200 days')`,
      [A],
    );
    const [result] = await t.asService.query<{ cleanup_old_records: Record<string, number> }>(
      `select public.cleanup_old_records()`,
    );
    expect(result?.cleanup_old_records).toMatchObject({ webhook_events: 1, notifications: 1 });
  });

  it("erases client IPs from audit logs older than 180 days (LGPD) and keeps recent ones", async () => {
    await t.asService.query(
      `insert into public.audit_logs (action, entity, ip, created_at) values
        ('old', 'user', '1.1.1.1', now() - interval '181 days'), ('new', 'user', '2.2.2.2', now())`,
    );
    const [result] = await t.asService.query<{ cleanup_old_records: Record<string, number> }>(
      `select public.cleanup_old_records()`,
    );
    expect(result?.cleanup_old_records).toMatchObject({ audit_ips: 1 });
    const rows = await t.asService.query<{ action: string; ip: string | null }>(
      `select action, ip from public.audit_logs where action in ('old', 'new') order by action`,
    );
    expect(rows).toEqual([
      { action: "new", ip: "2.2.2.2" },
      { action: "old", ip: null },
    ]);
  });
});

describe("handle_new_user", () => {
  it("truncates an oversized name from the sign-up metadata instead of failing the sign-up", async () => {
    const E = "55555555-5555-5555-5555-555555555555";
    await t.createUser(E, "e@x.com", "N".repeat(500));
    const [row] = await t.asService.query<{ full_name: string }>(
      `select full_name from public.profiles where id = $1`,
      [E],
    );
    expect(row?.full_name).toHaveLength(120);
  });
});

describe("storage quota on overwrite (upsert runs as UPDATE)", () => {
  const H = "77777777-7777-7777-7777-777777777777";
  const overwrite = (name: string, size: number) =>
    t
      .as(H)
      .query(`update storage.objects set metadata = $2 where bucket_id = 'user-files' and name = $1 returning name`, [
        name,
        JSON.stringify({ size }),
      ]);

  beforeAll(async () => {
    await t.createUser(H);
    await t.asService.query(
      `insert into storage.objects (bucket_id, name, metadata) values
        ('user-files', $1, '{"size": 1}'), ('user-files', $2, '{"size": 1073000000}')`,
      [`${H}/small.txt`, `${H}/big.bin`],
    );
  });

  it("refuses to grow a small file past the quota by overwriting it", async () => {
    await expect(overwrite(`${H}/small.txt`, 26214400)).rejects.toThrow(/row-level security/);
  });

  it("allows overwriting a file when the total stays under the quota (old bytes are discounted)", async () => {
    await expect(overwrite(`${H}/big.bin`, 1073000000)).resolves.toEqual([{ name: `${H}/big.bin` }]);
  });

  it("caps the number of files (empty files add no bytes)", async () => {
    const I = "88888888-8888-8888-8888-888888888888";
    await t.createUser(I);
    await t.asService.query(
      `insert into storage.objects (bucket_id, name, metadata)
       select 'user-files', $1 || '/f' || g, '{"size": 0}' from generate_series(1, 10000) g`,
      [I],
    );
    await expect(
      t
        .as(I)
        .query(`insert into storage.objects (bucket_id, name, metadata) values ('user-files', $1, '{"size": 0}')`, [
          `${I}/one-more.txt`,
        ]),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("two-step verification enforced by RLS", () => {
  const M = "99999999-aaaa-4aaa-8aaa-999999999999";

  beforeAll(async () => {
    await t.createUser(M, "m@x.com", "Mari");
    await t.root.query(
      `insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'totp', 'verified', now(), now())`,
      [M],
    );
  });

  it("a user with a verified factor sees nothing with a password-only (aal1) session", async () => {
    expect(await t.as(M).query(`select id from public.profiles`)).toEqual([]);
    expect(await t.as(M).query(`select id from public.notifications`)).toEqual([]);
    expect(await t.as(M).query(`select id from public.organizations`)).toEqual([]);
    expect(await t.as(M).query(`update public.profiles set full_name = 'x' where id = $1 returning id`, [M])).toEqual(
      [],
    );
    await expect(
      t.as(M).query(`insert into storage.objects (bucket_id, name) values ('user-files', $1)`, [`${M}/a.pdf`]),
    ).rejects.toThrow(/row-level security/);
  });

  it("the same user sees their data after the second factor (aal2)", async () => {
    const rows = await t.as(M, { claims: { aal: "aal2" } }).query<{ id: string }>(`select id from public.profiles`);
    expect(rows).toEqual([{ id: M }]);
  });

  it("users without a factor are not affected, and the helpers answer per user", async () => {
    const state = (user: string) =>
      t
        .as(user)
        .query<{
          enrolled: boolean;
          ok: boolean;
        }>(`select public.has_verified_mfa() as enrolled, public.mfa_satisfied() as ok`)
        .then((r) => r[0]);
    expect(await state(A)).toEqual({ enrolled: false, ok: true });
    expect(await state(M)).toEqual({ enrolled: true, ok: false });
    await expect(t.as(A).query(`select public.user_has_verified_mfa($1)`, [M])).rejects.toThrow(/permission denied/);
    expect(await t.asService.query(`select public.user_has_verified_mfa($1) as ok`, [M])).toEqual([{ ok: true }]);
  });

  it("private realtime topics also require aal2 for enrolled users", async () => {
    await t.asService.query(`insert into public.notifications (user_id, title) values ($1, 'mfa')`, [M]);
    const topic = { "realtime.topic": `user:${M}:notifications` };
    expect(await t.as(M, { settings: topic }).query(`select 1 from realtime.messages`)).toEqual([]);
    const withAal2 = await t
      .as(M, { settings: topic, claims: { aal: "aal2" } })
      .query(`select 1 from realtime.messages`);
    expect(withAal2.length).toBeGreaterThan(0);
  });
});

describe("rate_limit_peek()", () => {
  it("reads a counter without consuming it, and only the server can call it", async () => {
    const peek = (key: string) =>
      t.asService.query<{ ok: boolean }>(`select public.rate_limit_peek($1, 2) as ok`, [key]).then((r) => r[0]?.ok);
    expect(await peek("peek:new")).toBe(true);
    expect(await peek("peek:new")).toBe(true);
    await t.asService.query(`select public.rate_limit('peek:k', 2, 60)`);
    expect(await peek("peek:k")).toBe(true);
    await t.asService.query(`select public.rate_limit('peek:k', 2, 60)`);
    expect(await peek("peek:k")).toBe(false);
    await expect(t.as(A).query(`select public.rate_limit_peek('x', 1)`)).rejects.toThrow(/permission denied/);
  });
});

describe("notifications idempotency", () => {
  it("the same idempotency key cannot create a second notification", async () => {
    const insert = () =>
      t.asService.query(
        `insert into public.notifications (user_id, title, idempotency_key) values ($1, 'x', 'evt_1:a')`,
        [A],
      );
    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key|unique/);
  });
});

describe("invitation retention", () => {
  it("cleanup_old_records() deletes expired and long-accepted invitations, keeps pending ones", async () => {
    const org = (
      await t.asService.query<{ id: string }>(`select id from public.organizations where personal_owner_id = $1`, [A])
    )[0]!.id;
    await t.asService.query(
      `insert into public.invitations (org_id, email, token_hash, expires_at, accepted_at) values
        ($1, 'expirado@x.com', 'h1', now() - interval '1 day', null),
        ($1, 'aceito@x.com', 'h2', now() + interval '1 day', now() - interval '40 days'),
        ($1, 'pendente@x.com', 'h3', now() + interval '1 day', null)`,
      [org],
    );
    const [result] = await t.asService.query<{ cleanup_old_records: Record<string, number> }>(
      `select public.cleanup_old_records()`,
    );
    expect(result?.cleanup_old_records).toMatchObject({ invitations: 2 });
    const left = await t.asService.query<{ email: string }>(
      `select email from public.invitations where token_hash in ('h1', 'h2', 'h3')`,
    );
    expect(left).toEqual([{ email: "pendente@x.com" }]);
  });
});

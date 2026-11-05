import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal stand-in for what Supabase provides (auth/storage/realtime schemas, roles, realtime publication). */
const SUPABASE_SHIM = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
-- No default privileges on purpose: like new Supabase projects, every grant must come from the migrations.

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;
create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}'::jsonb);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create table auth.mfa_factors (
  id uuid primary key, user_id uuid not null references auth.users (id) on delete cascade, friendly_name text,
  factor_type text not null, status text not null, created_at timestamptz not null, updated_at timestamptz not null
);

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text, name text collate "C", owner uuid, metadata jsonb
);
create unique index bucketid_objname on storage.objects (bucket_id, name);
alter table storage.objects enable row level security;
grant all on storage.objects to anon, authenticated, service_role;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;

-- Realtime Authorization: Realtime runs a select on realtime.messages with realtime.topic set to the channel.
create schema realtime;
grant usage on schema realtime to anon, authenticated, service_role;
create table realtime.messages (
  id uuid primary key default gen_random_uuid(), topic text not null, extension text not null,
  payload jsonb, event text, private boolean default false, inserted_at timestamptz not null default now()
);
alter table realtime.messages enable row level security;
grant select, insert on realtime.messages to anon, authenticated, service_role;
create function realtime.topic() returns text language sql stable as $$
  select nullif(current_setting('realtime.topic', true), '')
$$;
create function realtime.send(payload jsonb, event text, topic text, private boolean default true) returns void
language sql as $$
  insert into realtime.messages (payload, event, topic, private, extension) values (payload, event, topic, private, 'broadcast')
$$;

create publication supabase_realtime;
`;

type Rows = <T>(sql: string, params?: unknown[]) => Promise<T[]>;
type SessionOptions = {
  /** Extra JWT claims (`auth.jwt()`), e.g. `{ aal: "aal2" }`. */
  claims?: Record<string, unknown>;
  /** Extra transaction-local settings, e.g. `{ "realtime.topic": "user:<id>:notifications" }`. */
  settings?: Record<string, string>;
};
export type TestDb = {
  /** Superuser/owner: bypasses RLS and grants, like the SQL editor. */
  root: { query: Rows };
  /** Signed-in user (role `authenticated`, RLS enforced). */
  as: (userId: string, options?: SessionOptions) => { query: Rows };
  anon: { query: Rows };
  /** Service role (bypasses RLS, needs grants like the real one). */
  asService: { query: Rows };
  createUser: (id: string, email?: string, fullName?: string) => Promise<void>;
  close: () => Promise<void>;
};

type Tx = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

/** Runs `sql` in a transaction as `role`, with the JWT claims PostgREST would set for that request. */
async function inSession<T>(
  tx: Tx,
  role: string,
  sub: string | null,
  sql: string,
  params: unknown[],
  options: SessionOptions,
) {
  const claims = JSON.stringify({ sub: sub ?? undefined, role, aal: "aal1", ...options.claims });
  await tx.query(`select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)`, [
    sub ?? "",
    claims,
  ]);
  for (const [name, value] of Object.entries(options.settings ?? {})) {
    await tx.query(`select set_config($1, $2, true)`, [name, value]);
  }
  await tx.query(`set local role ${role}`);
  return (await tx.query(sql, params)).rows as T[];
}

function api(
  runAs: <T>(role: string, sub: string | null, sql: string, params: unknown[], o: SessionOptions) => Promise<T[]>,
  root: Rows,
  close: () => Promise<void>,
): TestDb {
  return {
    root: { query: root },
    as: (userId, options = {}) => ({
      query: (sql, params = []) => runAs("authenticated", userId, sql, params, options),
    }),
    anon: { query: (sql, params = []) => runAs("anon", null, sql, params, {}) },
    asService: { query: (sql, params = []) => runAs("service_role", null, sql, params, {}) },
    createUser: async (id, email = `${id.slice(0, 8)}@x.com`, fullName = "Teste") => {
      await root(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3)`, [
        id,
        email,
        JSON.stringify({ full_name: fullName }),
      ]);
    },
    close,
  };
}

/** PGlite (Postgres compiled to WASM, in memory) + the shim above + every migration. Fully offline. */
async function createPgliteDb(): Promise<TestDb> {
  const db = new PGlite();
  await db.exec(SUPABASE_SHIM);
  const root: Rows = async (sql, params) => (await db.query(sql, params)).rows as never;
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    await db.exec(readFileSync(join(dir, file), "utf8"));
  }
  return api(
    (role, sub, sql, params, options) => db.transaction((tx) => inSession(tx, role, sub, sql, params, options)),
    root,
    () => db.close(),
  );
}

/**
 * A real Supabase Postgres (CI: `supabase start` + `supabase db reset`, which already applied the migrations and
 * the seed). Expects a freshly reset database: the tests use fixed user ids.
 */
async function createRealDb(url: string): Promise<TestDb> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let queue = Promise.resolve();
  // One connection, one transaction at a time (tests in a file run sequentially, this only guards misuse).
  const serial = <T>(work: () => Promise<T>) => {
    const result = queue.then(work);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return api(
    (role, sub, sql, params, options) =>
      serial(async () => {
        await client.query("begin");
        try {
          const rows = await inSession(client, role, sub, sql, params, options);
          await client.query("commit");
          return rows as never;
        } catch (error) {
          await client.query("rollback");
          throw error;
        }
      }),
    (sql, params) => serial(async () => (await client.query(sql, params)).rows as never),
    () => client.end(),
  );
}

/**
 * Postgres with every migration in supabase/migrations applied. Default: PGlite in memory (offline, fast).
 * With RLS_TEST_DB_URL (e.g. postgresql://postgres:postgres@127.0.0.1:54322/postgres from `supabase start`)
 * the same tests run against the real local Supabase stack (CI job "Banco real").
 */
export async function createSupabaseTestDb(): Promise<TestDb> {
  const url = process.env.RLS_TEST_DB_URL;
  return url ? createRealDb(url) : createPgliteDb();
}

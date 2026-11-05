import { vi } from "vitest";

export type Result = { data?: unknown; error?: { code?: string; message: string } | null; count?: number };
export type Call = { table: string; method: string; args: unknown[] };

const BUILDER_METHODS = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "contains",
  "or",
  "not",
  "filter",
  "match",
  "order",
  "limit",
  "range",
  "single",
  "maybeSingle",
  "abortSignal",
  "returns",
];

type FakeOptions = {
  /** Queued results per table: each awaited query on that table takes the next one. */
  results?: Record<string, Result[]>;
  /** Result per RPC name (a list is consumed in order). */
  rpc?: Record<string, Result | Result[]>;
  /** Overrides for `client.auth` / `client.auth.admin` methods. */
  auth?: Record<string, unknown>;
  storage?: { list?: Result[]; remove?: Result[] };
};

/**
 * Chainable stand-in for a Supabase client: every builder method returns itself and awaiting it resolves to the
 * next queued result for that table (or `{ data: null, error: null }`). Calls are recorded in `calls`.
 */
export function fakeSupabase({ results = {}, rpc = {}, auth = {}, storage = {} }: FakeOptions = {}) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const method of BUILDER_METHODS) {
      builder[method] = (...args: unknown[]) => {
        calls.push({ table, method, args });
        return builder;
      };
    }
    builder.then = (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(results[table]?.shift() ?? { data: null, error: null }).then(resolve, reject);
    return builder;
  };
  const rpcFn = vi.fn(async (name: string, args?: unknown) => {
    calls.push({ table: `rpc:${name}`, method: "rpc", args: [args] });
    const value = rpc[name];
    if (Array.isArray(value)) return value.shift() ?? { data: null, error: null };
    return value ?? { data: null, error: { message: "not mocked" } };
  });
  const storageList = storage.list ?? [];
  const storageRemove = storage.remove ?? [];
  const client = {
    from: vi.fn(from),
    rpc: rpcFn,
    auth: {
      getClaims: vi.fn(async () => ({ data: null, error: null })),
      signInWithPassword: vi.fn(async () => ({ data: { session: {} }, error: null })),
      signUp: vi.fn(async () => ({ data: {}, error: null })),
      resetPasswordForEmail: vi.fn(async () => ({ data: {}, error: null })),
      updateUser: vi.fn(async () => ({ data: {}, error: null })),
      signOut: vi.fn(async () => ({ error: null })),
      verifyOtp: vi.fn(async () => ({ data: {}, error: null })),
      exchangeCodeForSession: vi.fn(async () => ({ data: {}, error: null })),
      admin: {
        deleteUser: vi.fn(async () => ({ data: {}, error: null })),
        ...((auth.admin as Record<string, unknown> | undefined) ?? {}),
      },
      ...Object.fromEntries(Object.entries(auth).filter(([key]) => key !== "admin")),
    },
    storage: {
      from: vi.fn((bucket: string) => ({
        list: vi.fn(async (...args: unknown[]) => {
          calls.push({ table: `storage:${bucket}`, method: "list", args });
          return storageList.shift() ?? { data: [], error: null };
        }),
        remove: vi.fn(async (...args: unknown[]) => {
          calls.push({ table: `storage:${bucket}`, method: "remove", args });
          return storageRemove.shift() ?? { data: [], error: null };
        }),
      })),
    },
  };
  return { client, calls };
}

/** Service-role client (`@/lib/supabase/admin`). Keeps the original (results, rpc) signature. */
export function mockAdmin(
  results: Record<string, Result[]> = {},
  rpc: Record<string, Result | Result[]> = {},
  extra: Omit<FakeOptions, "results" | "rpc"> = {},
) {
  const fake = fakeSupabase({ results, rpc, ...extra });
  vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => fake.client }));
  return fake;
}

/**
 * Request-scoped user client (`@/lib/supabase/server`). `claims` is what getClaims() returns (null = signed out).
 * Two-step verification RPCs default to "no factor, satisfied, trusted": override them in `rpc` to test MFA.
 */
export function mockServerClient(options: FakeOptions & { claims?: Record<string, unknown> | null } = {}) {
  const { claims = null, ...rest } = options;
  const fake = fakeSupabase({
    ...rest,
    rpc: {
      mfa_satisfied: { data: true, error: null },
      has_verified_mfa: { data: false, error: null },
      admin_mfa_trusted: { data: true, error: null },
      ...rest.rpc,
    },
  });
  fake.client.auth.getClaims = vi.fn(async () =>
    claims ? { data: { claims }, error: null } : { data: null, error: null },
  ) as never;
  if (options.auth?.getClaims) fake.client.auth.getClaims = options.auth.getClaims as never;
  vi.doMock("@/lib/supabase/server", () => ({ createClient: async () => fake.client }));
  return fake;
}

/** JWT claims of a signed-in user for mockServerClient(). */
export const claimsFor = (id: string, extra: Record<string, unknown> = {}) => ({
  sub: id,
  email: `${id}@x.com`,
  aal: "aal1",
  session_id: "s1",
  amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) }],
  ...extra,
});

/** `redirect()` from next/navigation throws; returns the target path of that error (or null). */
export function redirectTarget(error: unknown): string | null {
  const digest = (error as { digest?: string } | null)?.digest;
  if (!digest?.startsWith("NEXT_REDIRECT")) return null;
  return digest.split(";")[2] ?? null;
}

export async function expectRedirect(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const target = redirectTarget(error);
    if (target) return target;
    throw error;
  }
  throw new Error("expected a redirect");
}

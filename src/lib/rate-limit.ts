import "server-only";
import { createHash } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: Date };

export type RateLimitOptions = {
  /**
   * Allow the request when the database is unavailable. Default false (fail closed): auth, e-mail, export and
   * account deletion must never become unlimited because Postgres hiccupped. Use `true` only where the limit
   * protects nothing sensitive and another layer exists (e.g. billing: Stripe has its own limits).
   */
  failOpen?: boolean;
};

/**
 * Fixed-window limit stored in Postgres (`public.rate_limit`), no Redis needed.
 * Key examples: `contact:ip:<ip>`, `checkout:<userId>`, `signin:email:<hashKey(email)>`.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  { failOpen = false }: RateLimitOptions = {},
): Promise<RateLimitResult> {
  const { data, error } = await createAdminClient().rpc("rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });
  const row = data?.[0];
  if (error || !row) {
    const scope = key.split(":")[0];
    console.error(`rate-limit(${scope}): unavailable, ${failOpen ? "allowing" : "blocking"} request`, error?.message);
    return { allowed: failOpen, remaining: failOpen ? limit : 0, resetAt: new Date(Date.now() + windowSeconds * 1000) };
  }
  return { allowed: row.allowed, remaining: row.remaining, resetAt: new Date(row.reset_at) };
}

/** Checks every limit in order and stops at the first one exceeded (later counters are not consumed). */
export async function rateLimitAll(
  checks: ReadonlyArray<readonly [key: string, limit: number, windowSeconds: number]>,
  options?: RateLimitOptions,
): Promise<boolean> {
  for (const [key, limit, windowSeconds] of checks) {
    if (!(await rateLimit(key, limit, windowSeconds, options)).allowed) return false;
  }
  return true;
}

/**
 * Is the key still under `limit`? Reads the counter WITHOUT consuming it (`public.rate_limit_peek`). Use with
 * `rateLimit()` afterwards to charge only attempts that matter, e.g. per-e-mail auth limits that must not be spent
 * by requests without a valid captcha (otherwise anyone could lock a victim out). Fails closed by default.
 */
export async function rateLimitPeek(key: string, limit: number, { failOpen = false }: RateLimitOptions = {}) {
  const { data, error } = await createAdminClient().rpc("rate_limit_peek", { p_key: key, p_limit: limit });
  if (error || typeof data !== "boolean") {
    console.error(
      `rate-limit-peek(${key.split(":")[0]}): unavailable, ${failOpen ? "allowing" : "blocking"}`,
      error?.message,
    );
    return failOpen;
  }
  return data;
}

/** Stable, non-reversible key part for personal data (e-mails): no PII stored in public.rate_limits. */
export const hashKey = (value: string) =>
  createHash("sha256").update(value.trim().toLowerCase()).digest("hex").slice(0, 32);

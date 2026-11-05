import { NextResponse } from "next/server";
import { hasCronSecret } from "@/lib/cron";
import { features } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const DB_TIMEOUT_MS = 3000;

/** Cheapest round trip through PostgREST to Postgres (HEAD, no rows), with a timeout. */
async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number }> {
  const started = Date.now();
  try {
    const { error } = await createAdminClient()
      .from("profiles")
      .select("id", { head: true })
      .limit(1)
      .abortSignal(AbortSignal.timeout(DB_TIMEOUT_MS));
    return { ok: !error, latencyMs: Date.now() - started };
  } catch {
    return { ok: false, latencyMs: Date.now() - started };
  }
}

/**
 * Uptime check (Sentry/monitor): `{status}` only, 200 when the database answers and 503 when it does not.
 * Details (database latency, enabled modules, deployed commit) only with `Authorization: Bearer <CRON_SECRET>`.
 */
export async function GET(request: Request) {
  const db = await checkDatabase();
  const status = db.ok ? "ok" : "error";
  const body = hasCronSecret(request)
    ? { status, db, features, commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null, env: process.env.VERCEL_ENV ?? null }
    : { status };
  return NextResponse.json(body, { status: db.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}

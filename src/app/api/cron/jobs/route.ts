import { NextResponse, type NextRequest } from "next/server";
import { hasCronSecret } from "@/lib/cron";
import { runJobs } from "@/lib/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Retries pending jobs (public.jobs). Vercel Cron on Hobby runs at most once a day (vercel.json); for retries
 * every minute use pg_cron + pg_net (supabase/snippets/agendar-jobs-pg-cron.sql) or a Pro cron schedule.
 * Requires `Authorization: Bearer <CRON_SECRET>`.
 */
export async function GET(request: NextRequest) {
  if (!hasCronSecret(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const summary = await runJobs({ limit: 100, budgetMs: 50_000 });
  return NextResponse.json({ ok: true, ...summary });
}

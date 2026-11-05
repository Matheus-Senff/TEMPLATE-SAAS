import { NextResponse, type NextRequest } from "next/server";
import { hasCronSecret } from "@/lib/cron";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Daily retention (vercel.json "crons"). Vercel sends `Authorization: Bearer <CRON_SECRET>`. */
export async function GET(request: NextRequest) {
  if (!hasCronSecret(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { data, error } = await createAdminClient().rpc("cleanup_old_records");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, removed: data });
}

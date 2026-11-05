import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { Database } from "./database.types";

let client: ReturnType<typeof createClient<Database>> | null = null;

/**
 * Service role: BYPASSES RLS. Only for webhooks, cron, notifications, audit and account deletion.
 * Never use it to read data on behalf of a user (use createClient() so RLS applies).
 */
export function createAdminClient() {
  client ??= createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

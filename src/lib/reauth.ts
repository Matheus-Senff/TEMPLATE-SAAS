import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import type { Database } from "@/lib/supabase/database.types";

export type PasswordCheck =
  | {
      ok: true;
      /** Fresh session that is NOT stored in cookies; revoke it when done. */ client: SupabaseClient<Database>;
    }
  | { ok: false; code: string | undefined; status: number | undefined };

/**
 * Re-authentication for sensitive actions (password change, account deletion): signs in with the current
 * password on a throwaway client that never persists its session (no cookies, no storage). Supabase Auth
 * verifies the Turnstile token itself when captcha is on, so pass the token from the form (single use).
 * Callers revoke the extra session afterwards: `signOut({ scope: "others" })` from the user's own client
 * (password change) or deleting the user (account deletion).
 */
export async function verifyPassword(email: string, password: string, captchaToken?: string): Promise<PasswordCheck> {
  const client = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password, options: { captchaToken } });
  if (error || !data.session) return { ok: false, code: error?.code, status: error?.status };
  return { ok: true, client };
}

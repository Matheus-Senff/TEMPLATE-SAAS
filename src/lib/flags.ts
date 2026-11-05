import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Feature flags. Resolution order (first that answers wins):
 *   1. row in public.feature_flags (switch at runtime in Studio/SQL, no deploy)
 *   2. env FLAG_<KEY>=true|false (default per environment: Production, Preview, local)
 *   3. the default below (code)
 *
 * Usage (server):   if (await isEnabled("novo_painel")) { ... }
 * Client component: read in the Server Component and pass as a prop (`<Painel novo={await isEnabled(...)} />`);
 * signed-in clients may also read public.feature_flags directly (RLS allows select for authenticated).
 * Flags are product switches, never authorization: the server still checks permissions.
 */
export const FLAG_DEFAULTS = {
  /** Example flag: replace with your own. */
  novo_painel: false,
} as const satisfies Record<string, boolean>;

export type FlagKey = keyof typeof FLAG_DEFAULTS;

function fromEnv(key: FlagKey): boolean | undefined {
  const value = process.env[`FLAG_${key.toUpperCase()}`];
  return value === "true" ? true : value === "false" ? false : undefined;
}

/** All rows at once, once per request (React cache): one query no matter how many flags the page checks. */
const loadRows = cache(async (): Promise<Map<string, boolean>> => {
  const { data, error } = await createAdminClient().from("feature_flags").select("key, enabled");
  if (error) {
    console.warn("flags: table unavailable, using env/defaults", error.message);
    return new Map();
  }
  return new Map((data ?? []).map((row) => [row.key, row.enabled]));
});

export async function isEnabled(key: FlagKey): Promise<boolean> {
  const rows = await loadRows();
  return rows.get(key) ?? fromEnv(key) ?? FLAG_DEFAULTS[key];
}

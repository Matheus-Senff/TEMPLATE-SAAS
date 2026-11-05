import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export const ADMIN_PAGE_SIZE = 20;

/** All users (service role). Call only after requireAdmin(). */
export async function listUsers(page: number, search?: string) {
  const from = Math.max(0, page) * ADMIN_PAGE_SIZE;
  let query = createAdminClient()
    .from("profiles")
    .select("id, email, full_name, role, created_at", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(from, from + ADMIN_PAGE_SIZE - 1);
  const term = search?.trim().replace(/[%_,()]/g, "");
  if (term) query = query.or(`email.ilike.%${term}%,full_name.ilike.%${term}%`);
  const { data, count, error } = await query;
  if (error) throw new Error(`listUsers: ${error.message}`);
  return { users: data, total: count ?? 0 };
}

/** Background jobs that exhausted their attempts (public.jobs, status "dead"). Call only after requireAdmin(). */
export async function listDeadJobs(limit = 20) {
  const { data, error } = await createAdminClient()
    .from("jobs")
    .select("id, type, attempts, last_error, updated_at")
    .eq("status", "dead")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listDeadJobs: ${error.message}`);
  return data;
}

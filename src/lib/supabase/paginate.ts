type Page<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/**
 * Reads every row of a query page by page with `.range(from, to)`. PostgREST caps each response at
 * `max_rows` (1000 in supabase/config.toml), so a plain select silently truncates large results.
 * The query must have a deterministic order (e.g. `.order("created_at").order("id")`).
 */
export async function fetchAllRows<T>(page: (from: number, to: number) => Page<T>, pageSize = 1000): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) return rows;
  }
}

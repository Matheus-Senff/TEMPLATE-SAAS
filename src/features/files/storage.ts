import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export type StoredFile = { path: string; size: number | null; createdAt: string | null };

/**
 * Every file under `prefix` in `bucket`, including subfolders (Storage `list()` returns folders as entries
 * with `id: null` and is paginated). Works with the user client (RLS) or the admin client.
 */
export async function listAllFiles(client: SupabaseClient, bucket: string, prefix: string): Promise<StoredFile[]> {
  const files: StoredFile[] = [];
  const folders = [prefix];
  while (folders.length > 0) {
    const folder = folders.pop()!;
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await client.storage.from(bucket).list(folder, { limit: 100, offset });
      if (error) throw new Error(`list ${folder}: ${error.message}`);
      for (const entry of data ?? []) {
        const path = `${folder}/${entry.name}`;
        if (entry.id === null) folders.push(path);
        else
          files.push({ path, size: (entry.metadata?.size as number | undefined) ?? null, createdAt: entry.created_at });
      }
      if (!data || data.length < 100) break;
    }
  }
  return files;
}

/** Removes the given paths in batches of 100. */
export async function removeFiles(client: SupabaseClient, bucket: string, paths: string[]): Promise<void> {
  for (let i = 0; i < paths.length; i += 100) {
    const { error } = await client.storage.from(bucket).remove(paths.slice(i, i + 100));
    if (error) throw new Error(`remove files: ${error.message}`);
  }
}

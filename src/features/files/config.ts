/** Mirrors the bucket limits in supabase/migrations (file_size_limit / allowed_mime_types). Keep both in sync. */
export const FILES_BUCKET = "user-files";
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** Total per user, enforced by the upload policy (public.storage_quota_bytes()). Keep both in sync. */
export const USER_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;
export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

/** Storage key: "<userId>/<uuid>-<sanitized name>" (RLS only allows the user's own folder). */
export function buildObjectPath(userId: string, fileName: string): string {
  const safe = fileName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .slice(-120);
  return `${userId}/${crypto.randomUUID()}-${safe}`;
}

export function validateFile(file: { size: number; type: string }): string | null {
  if (file.size > MAX_FILE_BYTES) return "Arquivo maior que 25 MB.";
  if (!(ALLOWED_MIME_TYPES as readonly string[]).includes(file.type)) return "Tipo de arquivo não permitido.";
  return null;
}

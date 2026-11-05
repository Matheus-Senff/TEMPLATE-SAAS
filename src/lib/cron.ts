import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * True when the request carries `Authorization: Bearer <CRON_SECRET>` (sent by Vercel Cron, pg_cron or an
 * uptime monitor). Compared in constant time over SHA-256 digests, so neither the content nor the length of the
 * secret leaks through response timing. Always false while CRON_SECRET is unset (production requires it).
 */
export function hasCronSecret(request: Pick<Request, "headers">): boolean {
  const secret = env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (!secret || !header) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

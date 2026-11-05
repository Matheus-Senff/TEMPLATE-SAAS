import "server-only";
import { headers } from "next/headers";

/**
 * Client IP from request headers. Only trusted on Vercel, whose edge overwrites `x-real-ip`/`x-forwarded-for`
 * with the real client address (a client cannot spoof them there). Anywhere else those headers are whatever the
 * client sent, so the IP is "unknown" (rate limits then fall back to the per-account/per-email keys).
 *
 * Cloudflare must stay DNS-only (grey cloud) in front of Vercel: with the proxy on, every request reaches Vercel
 * from a Cloudflare IP and all visitors would share one rate-limit bucket.
 */
export function ipFromHeaders(h: Pick<Headers, "get">, onVercel = Boolean(process.env.VERCEL)): string {
  if (!onVercel) return "unknown";
  return h.get("x-real-ip")?.trim() || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** Client IP for rate limits and audit only (never for authorization). */
export async function clientIp(): Promise<string> {
  return ipFromHeaders(await headers());
}

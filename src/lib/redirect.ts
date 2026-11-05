const BASE = "http://local.invalid";

/** Path, query and hash of `value` resolved against a fixed fake origin, or null when it leaves that origin. */
function normalize(value: string): string | null {
  try {
    const url = new URL(value, BASE);
    return url.origin === BASE ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}

/** Paths that browsers would still read as another host (`//evil.com`, `/\evil.com`: `\` is treated as `/`). */
const leavesSite = (path: string) => path.startsWith("//") || path.includes("\\");

/**
 * Internal path to redirect to after login/links, or `fallback`. Rejects anything that leaves the site:
 * absolute URLs, protocol-relative `//x`, backslash tricks like `/\evil.com`, control characters, and dot
 * segments or encodings that only *become* `//evil.com` after normalization (`/.//evil.com`, `/..//evil.com`,
 * `/%2e//evil.com`). The normalized result is parsed again and must not change (safe re-parse).
 */
export function safePath(value: unknown, fallback = "/painel"): string {
  if (typeof value !== "string" || !value.startsWith("/") || leavesSite(value)) return fallback;
  // URL parsers drop tabs/newlines (`/\t/evil.com` -> `//evil.com`); no control character is ever valid here.
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  const path = normalize(value);
  if (!path || leavesSite(path)) return fallback;
  return normalize(path) === path ? path : fallback;
}

export const isSafePath = (value: unknown): value is string =>
  typeof value === "string" && safePath(value, "") === value;

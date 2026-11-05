import "server-only";
import { env, isTurnstileTestKey } from "@/lib/env";

type SiteverifyResponse = { success?: boolean; hostname?: string; "error-codes"?: string[] };

const hostOf = (value: string | undefined) => {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return null;
  }
};

/**
 * Hostnames where our widget may legitimately be solved: the site URL plus the Vercel deployment URLs
 * (preview/branch URLs differ from NEXT_PUBLIC_SITE_URL). A token solved on another site is rejected.
 */
export function allowedTurnstileHostnames(): Set<string> {
  return new Set(
    [
      env.NEXT_PUBLIC_SITE_URL,
      process.env.VERCEL_URL,
      process.env.VERCEL_BRANCH_URL,
      process.env.VERCEL_PROJECT_PRODUCTION_URL,
    ]
      .map(hostOf)
      .filter((host): host is string => Boolean(host)),
  );
}

/**
 * Verifies a Cloudflare Turnstile token on the server (public forms such as contact). Tokens are single-use:
 * never verify here a token that is also sent to Supabase Auth (`options.captchaToken`), which verifies it itself.
 * Disabled (always true) without TURNSTILE_SECRET_KEY; production refuses to start without it (see env.ts).
 */
export async function verifyTurnstile(token: string | undefined, ip?: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        ...(ip && ip !== "unknown" && { remoteip: ip }),
      }),
      signal: AbortSignal.timeout(5000),
    });
    const data = (await res.json()) as SiteverifyResponse;
    if (data.success !== true) return false;
    // Test keys answer with a fixed placeholder hostname, so the check only makes sense with real keys.
    if (isTurnstileTestKey(env.TURNSTILE_SECRET_KEY)) return true;
    return Boolean(data.hostname && allowedTurnstileHostnames().has(data.hostname));
  } catch {
    return false;
  }
}

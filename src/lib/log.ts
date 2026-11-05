import "server-only";
import * as Sentry from "@sentry/nextjs";

type Context = Record<string, string | number | boolean | null | undefined>;

/**
 * Operational error: console (Vercel logs) + Sentry (no-op without DSN). Never pass personal data (e-mail,
 * name, IP, tokens) in `context`: ids, codes and statuses only.
 */
export function reportError(scope: string, error: unknown, context: Context = {}): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[${scope}] ${message}`, context);
  Sentry.captureException(error instanceof Error ? error : new Error(`${scope}: ${message}`), {
    tags: { scope },
    extra: context,
  });
}

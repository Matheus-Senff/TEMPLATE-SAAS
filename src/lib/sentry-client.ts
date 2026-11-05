import type * as SentryModule from "@sentry/nextjs";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
/** Vercel environment (production | preview | development), exposed at build time by next.config.ts. */
const environment = process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV;

let loading: Promise<typeof SentryModule> | null = null;

/**
 * Sentry in the browser, loaded on demand and only when NEXT_PUBLIC_SENTRY_DSN is set at build time: without a
 * DSN the SDK never reaches the bundle a visitor downloads (it is ~80 KB gzip).
 */
export function loadSentry(): Promise<typeof SentryModule> | null {
  if (!dsn) return null;
  loading ??= import("@sentry/nextjs").then((Sentry) => {
    Sentry.init({ dsn, environment, tracesSampleRate: environment === "production" ? 0.1 : 1 });
    return Sentry;
  });
  return loading;
}

/** Reports a client-side error (error boundaries). No-op without DSN. */
export function captureClientError(error: unknown): void {
  void loadSentry()?.then((Sentry) => Sentry.captureException(error));
}

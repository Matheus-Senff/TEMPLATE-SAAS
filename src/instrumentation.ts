import * as Sentry from "@sentry/nextjs";

export async function register() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return;
  // VERCEL_ENV, not NODE_ENV: preview deployments are production builds but must not be tagged "production".
  const environment = process.env.VERCEL_ENV || process.env.NODE_ENV;
  Sentry.init({
    dsn,
    environment,
    tracesSampleRate: environment === "production" ? 0.1 : 1,
  });
}

/** Reports errors from Server Components, Server Actions, Route Handlers and proxy.ts. */
export const onRequestError = Sentry.captureRequestError;

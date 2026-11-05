import type * as SentryModule from "@sentry/nextjs";
import { loadSentry } from "@/lib/sentry-client";

// Starts Sentry right after hydration when a DSN exists (separate chunk); does nothing otherwise.
const sentry = loadSentry();

type TransitionArgs = Parameters<typeof SentryModule.captureRouterTransitionStart>;

/** Navigation tracing; a no-op until (and unless) Sentry has loaded. */
export function onRouterTransitionStart(...args: TransitionArgs) {
  void sentry?.then((Sentry) => Sentry.captureRouterTransitionStart(...args));
}

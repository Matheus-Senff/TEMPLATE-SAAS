import { withSentryConfig } from "@sentry/nextjs/config";
import type { NextConfig } from "next";
import { buildCsp } from "./src/lib/csp";

/**
 * Security headers for every response. The CSP is an origin allowlist computed at build time from the env
 * (Supabase URL, Sentry DSN, Vercel preview toolbar), without nonces so public pages stay static: see
 * src/lib/csp.ts for what it blocks and the tradeoff. A new third-party script/iframe/API must be added there.
 */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
  {
    key: "Content-Security-Policy",
    value: buildCsp({
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      siteUrl: process.env.NEXT_PUBLIC_SITE_URL,
      vercelEnv: process.env.VERCEL_ENV,
      dev: process.env.NODE_ENV === "development",
    }),
  },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  env: {
    // Sentry "environment" in the browser: previews are production builds, so NODE_ENV cannot tell them apart.
    NEXT_PUBLIC_VERCEL_ENV: process.env.VERCEL_ENV ?? "",
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

/** Source maps upload only with SENTRY_AUTH_TOKEN/ORG/PROJECT (deploy). Builds fine without them. */
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
  tunnelRoute: "/monitoring",
});

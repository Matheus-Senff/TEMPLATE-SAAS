import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Offline tests: tests/rls.test.ts runs the real migrations on Postgres in memory (PGlite) with RLS.
 * Server modules read env through src/lib/env.ts; tests set what they need with vi.stubEnv + vi.resetModules.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/helpers/empty.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Tests re-import modules (vi.resetModules); the first cold import can be slow on CI runners.
    testTimeout: 20_000,
    env: {
      NODE_ENV: "test",
      VERCEL: "",
      VERCEL_ENV: "",
      ADMIN_REQUIRE_MFA: "",
      TURNSTILE_DISABLED: "",
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
      NEXT_PUBLIC_SUPABASE_URL: "https://test.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
      SUPABASE_SECRET_KEY: "sb_secret_test",
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "",
      TURNSTILE_SECRET_KEY: "",
      RESEND_API_KEY: "",
      CONTACT_EMAIL: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "",
      STRIPE_PRICE_IDS: "",
      NEXT_PUBLIC_SENTRY_DSN: "",
      CRON_SECRET: "",
    },
  },
});

import "server-only";
import { z } from "zod";

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
const list = z.string().transform((value) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
const flag = optional(z.enum(["true", "false"]).transform((value) => value === "true"));

/** Cloudflare's documented Turnstile test keys (always pass/fail): fine locally and in CI, never in production. */
export const isTurnstileTestKey = (key: string | undefined) => Boolean(key && /^[123]x0{10,}[A-F]{2}$/.test(key));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Falls back to the Vercel production domain, then localhost (dev). Set it explicitly in production. */
  NEXT_PUBLIC_SITE_URL: z
    .string()
    .url()
    .default(
      process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
        : "http://localhost:3000",
    ),

  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SECRET_KEY: z.string().min(1),

  NEXT_PUBLIC_TURNSTILE_SITE_KEY: optional(z.string().min(1)),
  TURNSTILE_SECRET_KEY: optional(z.string().min(1)),
  /** Explicit opt-out: production refuses to start without Turnstile unless this is "true". */
  TURNSTILE_DISABLED: flag,

  RESEND_API_KEY: optional(z.string().startsWith("re_")),
  EMAIL_FROM: z.string().default("App <onboarding@resend.dev>"),
  CONTACT_EMAIL: optional(z.string().email()),

  STRIPE_SECRET_KEY: optional(z.string().regex(/^(sk|rk)_(test|live)_/, "must start with sk_test_/sk_live_")),
  STRIPE_WEBHOOK_SECRET: optional(z.string().startsWith("whsec_")),
  STRIPE_PRICE_IDS: optional(list),

  CRON_SECRET: optional(z.string().min(16)),

  /** /admin requires a verified second factor (aal2). Default: on in production builds, off in `next dev`. */
  ADMIN_REQUIRE_MFA: flag,
});

export type Env = Omit<z.infer<typeof schema>, "ADMIN_REQUIRE_MFA" | "TURNSTILE_DISABLED"> & {
  ADMIN_REQUIRE_MFA: boolean;
  TURNSTILE_DISABLED: boolean;
};

/** Vercel production only. Previews, CI and local production builds (`next start` on localhost) are not. */
export const isProductionDeployment = () => process.env.VERCEL_ENV === "production";

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  const env: Env = {
    ...parsed.data,
    ADMIN_REQUIRE_MFA: parsed.data.ADMIN_REQUIRE_MFA ?? parsed.data.NODE_ENV === "production",
    TURNSTILE_DISABLED: parsed.data.TURNSTILE_DISABLED ?? false,
  };
  if (Boolean(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) !== Boolean(env.TURNSTILE_SECRET_KEY)) {
    throw new Error("Set both NEXT_PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY, or neither.");
  }
  if (env.NODE_ENV === "production" && env.STRIPE_SECRET_KEY && !env.STRIPE_PRICE_IDS?.length) {
    throw new Error("STRIPE_PRICE_IDS is required in production when Stripe is enabled.");
  }
  if (isProductionDeployment()) {
    if (env.NEXT_PUBLIC_SITE_URL.includes("localhost")) {
      throw new Error("NEXT_PUBLIC_SITE_URL must be the public domain in production.");
    }
    if (!env.TURNSTILE_SECRET_KEY && !env.TURNSTILE_DISABLED) {
      throw new Error(
        "Turnstile is required in production: set NEXT_PUBLIC_TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY " +
          "(same secret in Supabase Auth captcha), or TURNSTILE_DISABLED=true to run without it on purpose.",
      );
    }
    if (isTurnstileTestKey(env.TURNSTILE_SECRET_KEY) || isTurnstileTestKey(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY)) {
      throw new Error("Turnstile test keys (1x000...) accept every request: use the real keys in production.");
    }
    if (!env.CRON_SECRET) {
      throw new Error("CRON_SECRET is required in production (Vercel cron and /api/cron/* use it).");
    }
  }
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_WEBHOOK_SECRET) {
    console.warn("STRIPE_WEBHOOK_SECRET is not set: /api/stripe/webhook will reject every event.");
  }
  return env;
}

/** Validated server environment (throws on first use when something is wrong). Server code only. */
export const env = load();

export const features = {
  turnstile: Boolean(env.TURNSTILE_SECRET_KEY),
  email: Boolean(env.RESEND_API_KEY),
  stripe: Boolean(env.STRIPE_SECRET_KEY),
  cron: Boolean(env.CRON_SECRET),
  adminMfa: env.ADMIN_REQUIRE_MFA,
} as const;

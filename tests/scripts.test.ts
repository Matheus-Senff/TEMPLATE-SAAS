import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM scripts (no type declarations)
import { dbUrlRef, migrationTarget } from "../scripts/build.mjs";
// @ts-expect-error -- plain ESM scripts (no type declarations)
import { compareCounts } from "../scripts/restore-drill-check.mjs";
// @ts-expect-error -- plain ESM scripts (no type declarations)
import { remoteSettings, renderRemoteConfig } from "../scripts/supabase-config.mjs";

describe("build: migrations before next build", () => {
  const PROD = "prodprodprodprodprod";
  const STAGING = "stagingstagingstagin";
  const pooler = (ref: string) => `postgresql://postgres.${ref}:pw@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;

  it("reads the project ref from pooler and direct URIs", () => {
    expect(dbUrlRef(pooler(PROD))).toBe(PROD);
    expect(dbUrlRef(`postgresql://postgres:pw@db.${PROD}.supabase.co:5432/postgres`)).toBe(PROD);
    expect(dbUrlRef("not a url")).toBeNull();
  });

  it("migrates production with SUPABASE_DB_URL, only if it is the project the build talks to", () => {
    const env = { VERCEL_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: `https://${PROD}.supabase.co` };
    expect(migrationTarget({ ...env, SUPABASE_DB_URL: pooler(PROD) })).toMatchObject({ url: pooler(PROD) });
    expect(migrationTarget({ ...env, SUPABASE_DB_URL: pooler(STAGING) }).error).toMatch(/different projects/);
    expect(migrationTarget(env).error).toMatch(/SUPABASE_DB_URL is empty/);
  });

  it("does not migrate previews by default (shared staging + many PRs); opt-in uses the staging variable", () => {
    expect(migrationTarget({ VERCEL_ENV: "preview", SUPABASE_DB_URL: pooler(PROD) })).toEqual({ skip: true });
    const preview = {
      VERCEL_ENV: "preview",
      SUPABASE_MIGRATE_PREVIEW: "true",
      SUPABASE_PRODUCTION_REF: PROD,
      NEXT_PUBLIC_SUPABASE_URL: `https://${STAGING}.supabase.co`,
    };
    expect(migrationTarget({ ...preview, SUPABASE_STAGING_DB_URL: pooler(STAGING) })).toMatchObject({
      label: "staging",
    });
  });

  it("refuses to migrate production from a preview, or without a way to tell", () => {
    const preview = { VERCEL_ENV: "preview", SUPABASE_MIGRATE_PREVIEW: "true" };
    expect(
      migrationTarget({ ...preview, SUPABASE_PRODUCTION_REF: PROD, SUPABASE_STAGING_DB_URL: pooler(PROD) }).error,
    ).toMatch(/PRODUCTION/);
    expect(migrationTarget({ ...preview, SUPABASE_STAGING_DB_URL: pooler(STAGING) }).error).toMatch(
      /SUPABASE_PRODUCTION_REF/,
    );
    expect(migrationTarget({ ...preview, SUPABASE_PRODUCTION_REF: PROD }).error).toMatch(/SUPABASE_STAGING_DB_URL/);
  });

  it("does nothing outside Vercel (local, CI)", () => {
    expect(migrationTarget({ SUPABASE_DB_URL: pooler(PROD) })).toEqual({ skip: true });
  });
});

describe("supabase:config:push", () => {
  const env = {
    SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
    SUPABASE_AUTH_SITE_URL: "https://app.com.br/",
    SUPABASE_AUTH_CAPTCHA_SECRET: "0x4AAAAAAAreal",
    RESEND_API_KEY: "re_123",
    SMTP_SENDER_EMAIL: "no-reply@app.com.br",
  };

  it("refuses localhost, missing SMTP and Turnstile test keys", () => {
    expect(remoteSettings(env).problems).toEqual([]);
    expect(remoteSettings({ ...env, SUPABASE_AUTH_SITE_URL: "http://localhost:3000" }).problems).toHaveLength(1);
    expect(remoteSettings({ ...env, RESEND_API_KEY: "" }).problems).toHaveLength(1);
    expect(
      remoteSettings({ ...env, SUPABASE_AUTH_CAPTCHA_SECRET: "1x0000000000000000000000000000000AA" }).problems,
    ).toHaveLength(1);
  });

  it("renders the remote site URL, redirects, e-mail rate and Resend SMTP into config.toml", () => {
    const toml = renderRemoteConfig(
      readFileSync("supabase/config.toml", "utf8"),
      remoteSettings({ ...env, SUPABASE_AUTH_REDIRECT_URLS: "https://app.com.br/**" }).settings,
    );
    expect(toml).toMatch(/^site_url = "https:\/\/app\.com\.br"$/m);
    expect(toml).toMatch(/^additional_redirect_urls = \["https:\/\/app\.com\.br\/\*\*"\]$/m);
    expect(toml).toMatch(/^email_sent = 30$/m);
    expect(toml).toContain('[auth.email.smtp]\nenabled = true\nhost = "smtp.resend.com"');
    expect(toml).toContain('pass = "env(RESEND_API_KEY)"');
    expect(toml).not.toContain("localhost:3000/auth");
    expect(toml).toMatch(/^\[auth\.captcha\]\nenabled = true/m);
  });
});

describe("restore drill", () => {
  it("accepts small drift from writes after the dump and flags missing or emptied tables", () => {
    expect(compareCounts({ "public.profiles": 1000 }, { "public.profiles": 1004 })).toEqual([]);
    expect(compareCounts({ "public.profiles": 10 }, { "public.profiles": 0 })).toHaveLength(1);
    expect(compareCounts({ "public.jobs": 3 }, {})).toEqual(["public.jobs: missing after restore"]);
    expect(compareCounts({ "auth.users": 5000 }, { "auth.users": 4000 })).toHaveLength(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { mockAdmin } from "./helpers/admin-mock";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/supabase/admin");
  vi.doUnmock("@/lib/webhooks");
  vi.doUnmock("@/features/billing/service");
});

const SITE = "https://app.test";
/** Where a browser would actually go if it followed `path` on our site. */
const landsOn = (path: string) => new URL(path, SITE).origin;

describe("safePath (open redirect)", () => {
  it.each([
    ["/painel", "/painel"],
    ["/painel?x=1#a", "/painel?x=1#a"],
    ["/painel/../admin", "/admin"],
    ["//evil.com", "/painel"],
    ["/\\evil.com", "/painel"],
    ["\\/evil.com", "/painel"],
    ["/\\/evil.com", "/painel"],
    ["https://evil.com", "/painel"],
    ["painel", "/painel"],
    [undefined, "/painel"],
    // Dot segments and encodings that only become "//evil.com" after URL normalization.
    ["/.//evil.com", "/painel"],
    ["/..//evil.com", "/painel"],
    ["/%2e//evil.com", "/painel"],
    ["/%2E%2E//evil.com", "/painel"],
    ["/a/../..//evil.com", "/painel"],
    ["/./%2e/.//evil.com", "/painel"],
    // Tabs/newlines are stripped by URL parsers; control characters are never accepted.
    ["/\t/evil.com", "/painel"],
    ["/\n/evil.com", "/painel"],
    ["/\u0000/evil.com", "/painel"],
  ])("%j -> %j", async (input, expected) => {
    const { safePath } = await import("@/lib/redirect");
    expect(safePath(input)).toBe(expected);
  });

  it.each(["/%5cevil.com", "/%5C%5Cevil.com", "/%2f%2fevil.com", "/%09/evil.com", "/ /evil.com", "/;//evil.com"])(
    "%j stays on the site",
    async (input) => {
      const { safePath } = await import("@/lib/redirect");
      const result = safePath(input);
      expect(result.startsWith("//")).toBe(false);
      expect(landsOn(result)).toBe(SITE);
    },
  );

  it("isSafePath only accepts already-normalized internal paths", async () => {
    const { isSafePath } = await import("@/lib/redirect");
    expect(isSafePath("/painel")).toBe(true);
    expect(isSafePath("/.//evil.com")).toBe(false);
    expect(isSafePath("//evil.com")).toBe(false);
  });
});

describe("hardNavigate", () => {
  const setup = async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { origin: SITE, assign } });
    const { hardNavigate } = await import("@/lib/navigation");
    return { hardNavigate, assign };
  };

  it("navigates to internal paths", async () => {
    const { hardNavigate, assign } = await setup();
    hardNavigate("/painel?x=1");
    expect(assign).toHaveBeenCalledWith(`${SITE}/painel?x=1`);
  });

  it.each(["//evil.com", "https://evil.com/x", "/\\evil.com", "\\\\evil.com"])(
    "refuses %j (other origin) and goes home",
    async (target) => {
      const { hardNavigate, assign } = await setup();
      hardNavigate(target);
      expect(assign).toHaveBeenCalledWith(`${SITE}/`);
    },
  );

  it("keeps a normalized same-origin URL absolute, so the host cannot change", async () => {
    const { hardNavigate, assign } = await setup();
    hardNavigate("/.//evil.com");
    const target = assign.mock.calls[0]?.[0] as string;
    expect(new URL(target).origin).toBe(SITE);
  });
});

describe("CSP", () => {
  it("allowlists Supabase (https + wss), Turnstile, Sentry ingest and Stripe frames", async () => {
    const { buildCsp } = await import("@/lib/csp");
    const csp = buildCsp({
      supabaseUrl: "https://abc.supabase.co",
      sentryDsn: "https://key@o1.ingest.sentry.io/2",
      siteUrl: "https://app.com.br",
    });
    const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("script-src")).toContain("https://challenges.cloudflare.com");
    expect(directive("script-src")).not.toContain("unsafe-eval");
    expect(directive("connect-src")).toContain("https://abc.supabase.co");
    expect(directive("connect-src")).toContain("wss://abc.supabase.co");
    expect(directive("connect-src")).toContain("https://o1.ingest.sentry.io");
    expect(directive("connect-src")).not.toContain("key@");
    expect(directive("frame-src")).toContain("https://challenges.cloudflare.com");
    expect(directive("frame-src")).toContain("https://js.stripe.com");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("vercel.live");
  });

  it("adds eval and the HMR websocket only in development, and the Vercel toolbar only on previews", async () => {
    const { buildCsp } = await import("@/lib/csp");
    const dev = buildCsp({ supabaseUrl: "http://127.0.0.1:54321", dev: true, siteUrl: "http://localhost:3000" });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("ws://127.0.0.1:54321");
    expect(dev).not.toContain("upgrade-insecure-requests");
    expect(buildCsp({ vercelEnv: "preview" })).toContain("https://vercel.live");
  });
});

describe("cron secret", () => {
  const request = (authorization?: string) =>
    new Request("http://x/api/cron/cleanup", { headers: authorization ? { authorization } : {} });

  it("accepts only the exact bearer secret (constant-time compare)", async () => {
    vi.stubEnv("CRON_SECRET", "a-long-random-secret-123");
    mockAdmin();
    const { hasCronSecret } = await import("@/lib/cron");
    expect(hasCronSecret(request("Bearer a-long-random-secret-123"))).toBe(true);
    expect(hasCronSecret(request("Bearer a-long-random-secret-124"))).toBe(false);
    expect(hasCronSecret(request("Bearer short"))).toBe(false);
    expect(hasCronSecret(request())).toBe(false);
  });

  it("rejects everything while CRON_SECRET is unset", async () => {
    mockAdmin();
    const { hasCronSecret } = await import("@/lib/cron");
    expect(hasCronSecret(request("Bearer "))).toBe(false);
  });
});

describe("health", () => {
  const call = async (results: Parameters<typeof mockAdmin>[0], authorization?: string) => {
    vi.stubEnv("CRON_SECRET", "a-long-random-secret-123");
    mockAdmin(results);
    const { GET } = await import("@/app/api/health/route");
    const res = await GET(new Request("http://x/api/health", { headers: authorization ? { authorization } : {} }));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("answers only {status} publicly", async () => {
    const { status, body } = await call({ profiles: [{ data: null, error: null }] });
    expect(status).toBe(200);
    expect(body).toEqual({ status: "ok" });
  });

  it("answers 503 when the database is down", async () => {
    const { status, body } = await call({ profiles: [{ data: null, error: { message: "connection refused" } }] });
    expect(status).toBe(503);
    expect(body).toEqual({ status: "error" });
  });

  it("shows module details with the cron secret", async () => {
    const { body } = await call({ profiles: [{ data: null, error: null }] }, "Bearer a-long-random-secret-123");
    expect(body).toMatchObject({ status: "ok", db: { ok: true }, features: expect.any(Object) });
  });
});

describe("client IP", () => {
  const headers = new Headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "198.51.100.1, 10.0.0.1" });

  it("trusts x-real-ip only on Vercel", async () => {
    mockAdmin();
    const { ipFromHeaders } = await import("@/lib/request");
    expect(ipFromHeaders(headers, true)).toBe("203.0.113.7");
    expect(ipFromHeaders(new Headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.1" }), true)).toBe("198.51.100.1");
    expect(ipFromHeaders(headers, false)).toBe("unknown");
  });
});

describe("Turnstile", () => {
  const verify = async (
    response: Record<string, unknown>,
    keys = { site: "0x4AAAAAAAreal", secret: "0x4AAAAAAAsecret" },
  ) => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.com.br");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", keys.site);
    vi.stubEnv("TURNSTILE_SECRET_KEY", keys.secret);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(response))),
    );
    const { verifyTurnstile } = await import("@/lib/turnstile");
    return verifyTurnstile("token", "1.2.3.4");
  };

  it("accepts a token solved on our own site", async () => {
    expect(await verify({ success: true, hostname: "app.com.br" })).toBe(true);
  });

  it("rejects a valid token solved on another site (hostname mismatch)", async () => {
    expect(await verify({ success: true, hostname: "evil.example" })).toBe(false);
  });

  it("rejects failed verifications", async () => {
    expect(await verify({ success: false, hostname: "app.com.br" })).toBe(false);
  });

  it("skips the hostname check for Cloudflare test keys (local/CI)", async () => {
    const keys = { site: "1x00000000000000000000AA", secret: "1x0000000000000000000000000000000AA" };
    expect(await verify({ success: true, hostname: "example.com" }, keys)).toBe(true);
  });
});

describe("env in production (Vercel)", () => {
  const production = () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://app.com.br");
    vi.stubEnv("CRON_SECRET", "a-long-random-secret-123");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "0x4AAAAAAAreal");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "0x4AAAAAAAsecret");
  };

  it("starts with Turnstile and CRON_SECRET set, MFA for admins on by default", async () => {
    production();
    const { env } = await import("@/lib/env");
    expect(env.ADMIN_REQUIRE_MFA).toBe(true);
  });

  it("refuses to start without Turnstile keys", async () => {
    production();
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    await expect(import("@/lib/env")).rejects.toThrow("Turnstile is required");
  });

  it("allows running without Turnstile only with TURNSTILE_DISABLED=true", async () => {
    production();
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    vi.stubEnv("TURNSTILE_DISABLED", "true");
    await expect(import("@/lib/env")).resolves.toBeTruthy();
  });

  it("refuses Turnstile test keys", async () => {
    production();
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA");
    await expect(import("@/lib/env")).rejects.toThrow("test keys");
  });

  it("refuses to start without CRON_SECRET", async () => {
    production();
    vi.stubEnv("CRON_SECRET", "");
    await expect(import("@/lib/env")).rejects.toThrow("CRON_SECRET is required");
  });

  it("does not apply production checks to previews and keeps MFA overridable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("ADMIN_REQUIRE_MFA", "false");
    const { env } = await import("@/lib/env");
    expect(env.ADMIN_REQUIRE_MFA).toBe(false);
  });

  it("keeps MFA for admins off by default in development/tests", async () => {
    const { env } = await import("@/lib/env");
    expect(env.ADMIN_REQUIRE_MFA).toBe(false);
  });
});

describe("Stripe webhook route", () => {
  const post = async (outcome: "processed" | "duplicate" | "in_progress") => {
    vi.doMock("@/features/billing/service", () => ({
      BillingError: class extends Error {},
      constructWebhookEvent: vi.fn(async () => ({ id: "evt_1", type: "invoice.paid" })),
      handleStripeEvent: vi.fn(),
    }));
    vi.doMock("@/lib/webhooks", () => ({ processOnce: vi.fn(async () => ({ outcome })) }));
    const { POST } = await import("@/app/api/stripe/webhook/route");
    return POST(new Request("http://x/api/stripe/webhook", { method: "POST", body: "{}" }));
  };

  it("answers 409 while another delivery of the same event is still running (Stripe retries)", async () => {
    expect((await post("in_progress")).status).toBe(409);
  });

  it("answers 200 for processed and already-finished events", async () => {
    expect((await post("processed")).status).toBe(200);
    vi.resetModules();
    const duplicate = await post("duplicate");
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
  });
});

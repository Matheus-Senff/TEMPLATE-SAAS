import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@supabase/ssr");
});

type SetAll = (cookies: Array<{ name: string; value: string; options: object }>, headers: object) => void;

/** Fake @supabase/ssr: getClaims returns `sub` (or no user) and optionally rotates the session cookie first. */
async function setup({ sub, refresh = false }: { sub: string | null; refresh?: boolean }) {
  const createServerClient = vi.fn((_url: string, _key: string, { cookies }: { cookies: { setAll: SetAll } }) => ({
    auth: {
      getClaims: vi.fn(async () => {
        if (refresh) {
          cookies.setAll([{ name: "sb-abc-auth-token", value: "rotated", options: { path: "/", httpOnly: false } }], {
            "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
          });
        }
        return { data: sub ? { claims: { sub } } : null, error: null };
      }),
    },
  }));
  vi.doMock("@supabase/ssr", () => ({ createServerClient }));
  const mod = await import("@/proxy");
  return { ...mod, createServerClient };
}

const request = (path: string, cookie?: string) =>
  new NextRequest(`https://app.test${path}`, { headers: cookie ? { cookie } : {} });

describe("proxy", () => {
  it("does not run on public pages (static pages stay static)", async () => {
    const { config } = await setup({ sub: null });
    // Exact list: "/", "/contato", "/privacidade" and the API routes are not matched.
    expect(config.matcher).toEqual([
      "/painel/:path*",
      "/admin/:path*",
      "/redefinir-senha",
      "/convite",
      "/dois-fatores",
      "/entrar",
      "/cadastro",
    ]);
  });

  it("redirects private pages to the login without touching Auth when there is no session cookie", async () => {
    const { proxy, createServerClient } = await setup({ sub: null });
    const res = await proxy(request("/painel/seguranca"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.test/entrar?next=%2Fpainel%2Fseguranca");
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("keeps the query of the private link (e.g. invitation token) in `next`", async () => {
    const { proxy } = await setup({ sub: null });
    const res = await proxy(request("/convite?token=abc"));
    expect(res.headers.get("location")).toBe("https://app.test/entrar?next=%2Fconvite%3Ftoken%3Dabc");
  });

  it("lets visitors without a cookie see the login page with no Auth work", async () => {
    const { proxy, createServerClient } = await setup({ sub: null });
    const res = await proxy(request("/entrar"));
    expect(res.headers.get("location")).toBeNull();
    expect(createServerClient).not.toHaveBeenCalled();
  });

  it("refreshes the session on private pages and returns the new cookie with no-cache headers", async () => {
    const { proxy } = await setup({ sub: "u1", refresh: true });
    const res = await proxy(request("/painel", "sb-abc-auth-token=old"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get("sb-abc-auth-token")?.value).toBe("rotated");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps the refreshed cookies on the redirect away from the login page", async () => {
    const { proxy } = await setup({ sub: "u1", refresh: true });
    const res = await proxy(request("/entrar", "sb-abc-auth-token=old"));
    expect(res.headers.get("location")).toBe("https://app.test/painel");
    expect(res.cookies.get("sb-abc-auth-token")?.value).toBe("rotated");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("keeps the cookie changes when an expired session is sent to the login", async () => {
    const { proxy } = await setup({ sub: null, refresh: true });
    const res = await proxy(request("/admin", "sb-abc-auth-token.0=old"));
    expect(res.headers.get("location")).toBe("https://app.test/entrar?next=%2Fadmin");
    expect(res.cookies.get("sb-abc-auth-token")?.value).toBe("rotated");
  });
});

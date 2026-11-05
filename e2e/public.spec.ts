import { expect, test } from "@playwright/test";

const h1 = (html: string) => html.match(/<h1[^>]*>([^<]*)/)?.[1];

test.describe("páginas públicas (HTTP)", () => {
  test("home, contato e páginas legais respondem", async ({ request }) => {
    const home = await request.get("/");
    expect(home.status()).toBe(200);
    expect(h1(await home.text())).toBeTruthy();
    expect(h1(await (await request.get("/contato")).text())).toBe("Contato");
    expect(h1(await (await request.get("/privacidade")).text())).toBe("Política de Privacidade");
    expect(h1(await (await request.get("/termos")).text())).toBe("Termos de Uso");
  });

  test("login e cadastro respondem", async ({ request }) => {
    expect(h1(await (await request.get("/entrar")).text())).toBe("Entrar");
    expect(h1(await (await request.get("/cadastro")).text())).toBe("Criar conta");
  });

  test("painel e administração exigem login", async ({ request }) => {
    for (const path of ["/painel", "/admin"]) {
      const res = await request.get(path, { maxRedirects: 0 });
      expect(res.status()).toBe(307);
      expect(res.headers()["location"]).toContain(`/entrar?next=${encodeURIComponent(path)}`);
    }
  });

  test("imagem de compartilhamento, ícone e manifest", async ({ request }) => {
    const og = await request.get("/opengraph-image");
    expect(og.status()).toBe(200);
    expect(og.headers()["content-type"]).toContain("image/png");
    expect((await request.get("/icon.svg")).status()).toBe(200);
    expect(await (await request.get("/manifest.webmanifest")).json()).toMatchObject({ display: "standalone" });
  });

  test("rota inexistente responde 404", async ({ request }) => {
    const res = await request.get("/rota-que-nao-existe");
    expect(res.status()).toBe(404);
    expect(h1(await res.text())).toBe("Página não encontrada");
  });

  test("headers de segurança, robots e sitemap", async ({ request }) => {
    const headers = (await request.get("/")).headers();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-powered-by"]).toBeUndefined();
    const csp = headers["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("https://challenges.cloudflare.com");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(await (await request.get("/robots.txt")).text()).toContain("Disallow: /painel");
    expect(await (await request.get("/sitemap.xml")).text()).toContain("/contato");
  });

  test("webhook e cron recusam chamadas sem credencial", async ({ request }) => {
    expect((await request.post("/api/stripe/webhook", { data: "{}" })).status()).toBe(503);
    expect((await request.get("/api/cron/cleanup")).status()).toBe(401);
    expect((await request.get("/api/cron/cleanup", { headers: { authorization: "Bearer errado" } })).status()).toBe(
      401,
    );
  });

  test("health público mostra só o status", async ({ request }) => {
    const res = await request.get("/api/health");
    expect([200, 503]).toContain(res.status());
    expect(Object.keys(await res.json())).toEqual(["status"]);
  });

  test("link de e-mail não é consumido ao abrir (só no botão)", async ({ request }) => {
    const res = await request.get("/auth/confirm?token_hash=abc&type=email&next=/painel");
    expect(res.status()).toBe(200);
    const html = await res.text();
    expect(h1(html)).toBe("Confirme seu e-mail");
    expect(html).toContain('name="token_hash"');
  });
});

/** Real browser against a real Supabase (CI job "Banco real" sets E2E_SUPABASE_URL to the local stack). */
test.describe("navegador", () => {
  test.skip(!process.env.E2E_SUPABASE_URL, "requer o Supabase local (E2E_SUPABASE_URL)");

  test("home sem erros e navegação pelo rodapé", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    await page.getByRole("link", { name: "Contato" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Contato" })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

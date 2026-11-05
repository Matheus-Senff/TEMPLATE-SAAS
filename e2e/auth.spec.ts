import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

/**
 * Full account journey against the LOCAL Supabase stack (CI job "Banco real": `supabase start`, no secrets):
 * sign up -> confirm through the e-mail caught by Mailpit -> sign in -> dashboard -> upload -> another user cannot
 * see the file -> delete the account. Turnstile uses Cloudflare's test keys (always pass).
 *
 * Env: E2E_MAILPIT_URL (http://127.0.0.1:54324), NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 * of the local stack. Without E2E_MAILPIT_URL the suite is skipped.
 */
const MAILPIT = process.env.E2E_MAILPIT_URL;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
/** Token produced by Turnstile's test site keys and accepted by its test secret. */
const TURNSTILE_DUMMY_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

const run = Date.now().toString(36);
const userA = { name: "Ana Teste", email: `ana-${run}@example.com`, password: `Senha-${run}-A1` };
const userB = { name: "Bruno Teste", email: `bruno-${run}@example.com`, password: `Senha-${run}-B1` };

test.describe("conta completa (Supabase local)", () => {
  // Supabase local sends at most a few e-mails per hour: no retries, one browser, in order.
  test.describe.configure({ mode: "serial", retries: 0 });
  test.skip(!MAILPIT, "requer o Supabase local (E2E_MAILPIT_URL)");

  async function waitForCaptcha(page: Page) {
    await expect
      .poll(
        () =>
          page.evaluate(
            () => (document.querySelector('input[name="cf-turnstile-response"]') as HTMLInputElement | null)?.value,
          ),
        { timeout: 30_000 },
      )
      .toBeTruthy();
  }

  async function confirmationLink(email: string): Promise<string> {
    let id: string | undefined;
    await expect
      .poll(
        async () => {
          const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`);
          const body = (await res.json()) as { messages?: Array<{ ID: string }> };
          id = body.messages?.[0]?.ID;
          return id;
        },
        { timeout: 30_000 },
      )
      .toBeTruthy();
    const message = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { HTML: string };
    const href = /href="([^"]*\/auth\/confirm\?[^"]+)"/.exec(message.HTML)?.[1];
    expect(href).toBeTruthy();
    return href!.replaceAll("&amp;", "&");
  }

  async function signUpAndConfirm(page: Page, user: typeof userA) {
    await page.goto("/cadastro");
    await page.getByLabel("Nome").fill(user.name);
    await page.getByLabel("E-mail").fill(user.email);
    await page.getByLabel("Senha").fill(user.password);
    await waitForCaptcha(page);
    await page.getByRole("button", { name: "Criar conta" }).click();
    await expect(page.getByText("Enviamos um link de confirmação")).toBeVisible();

    // Opening the link does not spend the token (link scanners); the button does.
    await page.goto(await confirmationLink(user.email));
    await page.getByRole("button", { name: "Confirmar e-mail" }).click();
    await expect(page).toHaveURL(/\/painel/);
  }

  async function signIn(page: Page, user: typeof userA) {
    await page.goto("/entrar");
    await page.getByLabel("E-mail").fill(user.email);
    await page.getByLabel("Senha").fill(user.password);
    await waitForCaptcha(page);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
  }

  const apiAs = async (user: typeof userA) => {
    const client = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
    const { data, error } = await client.auth.signInWithPassword({
      email: user.email,
      password: user.password,
      options: { captchaToken: TURNSTILE_DUMMY_TOKEN },
    });
    expect(error).toBeNull();
    return { client, id: data.user!.id };
  };

  test("cadastro, confirmação por e-mail, login, upload, isolamento entre usuários e exclusão", async ({ browser }) => {
    const errors: string[] = [];
    const pageA = await browser.newPage();
    pageA.on("pageerror", (error) => errors.push(error.message));

    await signUpAndConfirm(pageA, userA);
    await pageA.getByRole("button", { name: "Sair" }).click();
    await expect(pageA).toHaveURL(/\/$/);

    await signIn(pageA, userA);
    await expect(pageA).toHaveURL(/\/painel/);
    await expect(pageA.getByRole("heading", { level: 1 })).toContainText("Olá, Ana Teste");

    await pageA.locator('input[type="file"]').setInputFiles({
      name: "relatorio.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 teste"),
    });
    await expect(pageA.getByText("Arquivo enviado")).toBeVisible();
    await expect(pageA.getByRole("cell", { name: "relatorio.pdf" })).toBeVisible();

    // Another account: empty list in the UI, and the API refuses A's folder (RLS on storage.objects).
    const pageB = await browser.newPage();
    await signUpAndConfirm(pageB, userB);
    await expect(pageB.getByText("Nenhum arquivo ainda")).toBeVisible();

    const a = await apiAs(userA);
    const { data: filesOfA } = await a.client.storage.from("user-files").list(a.id);
    const path = `${a.id}/${filesOfA?.[0]?.name}`;
    expect(filesOfA).toHaveLength(1);
    const b = await apiAs(userB);
    expect((await b.client.storage.from("user-files").list(a.id)).data).toEqual([]);
    expect((await b.client.storage.from("user-files").download(path)).error).toBeTruthy();

    // Delete A (re-authentication with the password), then A can no longer sign in.
    await pageA.goto("/painel");
    await pageA.getByRole("button", { name: "Excluir conta" }).click();
    await pageA.getByLabel("Confirme com sua senha").fill(userA.password);
    await waitForCaptcha(pageA);
    await pageA.getByRole("button", { name: "Excluir definitivamente" }).click();
    await expect(pageA).toHaveURL(/conta=excluida/);

    await signIn(pageA, userA);
    await expect(pageA.getByText("E-mail ou senha incorretos.")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

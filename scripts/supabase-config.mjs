// `npm run supabase:config:push` (and `-- --diff`): pushes supabase/config.toml (Auth e-mail templates, captcha,
// MFA, password rules, rate limits, redirect URLs, custom SMTP) to a REMOTE project, without the local-only
// values. Never run `supabase config push` directly: it would send site_url = http://localhost:3000 and break
// every e-mail link in production.
//
// Required env (shell or a git-ignored file you source; never commit):
//   SUPABASE_ACCESS_TOKEN            personal token (supabase.com/dashboard/account/tokens)
//   SUPABASE_PROJECT_REF             target project (production or staging)
//   SUPABASE_AUTH_SITE_URL           https://your-domain (Site URL used in e-mails)
//   SUPABASE_AUTH_CAPTCHA_SECRET     Turnstile secret (same as TURNSTILE_SECRET_KEY in Vercel)
//   RESEND_API_KEY, SMTP_SENDER_EMAIL [, SMTP_SENDER_NAME]   custom SMTP (REQUIRED: Supabase's default SMTP only
//                                    delivers to members of your Supabase team)
// Optional: SUPABASE_AUTH_REDIRECT_URLS (comma list; staging: add https://*-<team>.vercel.app/**),
//           SUPABASE_AUTH_EMAIL_RATE (e-mails per hour, default 30).
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const isTestKey = (key) => /^[123]x0{10,}[A-F]{2}$/.test(key ?? "");
const tomlString = (value) => JSON.stringify(String(value));

/** Validates the env and returns the remote values, or a list of problems. */
export function remoteSettings(env) {
  const problems = [];
  const site = (env.SUPABASE_AUTH_SITE_URL ?? "").replace(/\/+$/, "");
  if (!env.SUPABASE_PROJECT_REF) problems.push("SUPABASE_PROJECT_REF vazio (projeto de destino).");
  if (!/^https:\/\//.test(site) || /localhost|127\.0\.0\.1/.test(site)) {
    problems.push("SUPABASE_AUTH_SITE_URL precisa ser o domínio público com https (nunca localhost).");
  }
  if (!env.SUPABASE_AUTH_CAPTCHA_SECRET || isTestKey(env.SUPABASE_AUTH_CAPTCHA_SECRET)) {
    problems.push("SUPABASE_AUTH_CAPTCHA_SECRET vazio ou chave de teste do Turnstile.");
  }
  if (!env.RESEND_API_KEY || !env.SMTP_SENDER_EMAIL) {
    problems.push("RESEND_API_KEY e SMTP_SENDER_EMAIL são obrigatórios (SMTP próprio via Resend).");
  }
  const redirects = (env.SUPABASE_AUTH_REDIRECT_URLS ?? `${site}/auth/callback,${site}/auth/confirm`)
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const emailRate = Number(env.SUPABASE_AUTH_EMAIL_RATE ?? 30);
  return {
    problems,
    settings: {
      ref: env.SUPABASE_PROJECT_REF,
      site,
      redirects,
      emailRate: Number.isFinite(emailRate) && emailRate > 0 ? emailRate : 30,
      senderEmail: env.SMTP_SENDER_EMAIL,
      senderName: env.SMTP_SENDER_NAME || "App",
    },
  };
}

/** config.toml with the remote values in place of the local ones (site URL, redirects, SMTP, e-mail rate). */
export function renderRemoteConfig(toml, { site, redirects, emailRate, senderEmail, senderName }) {
  const replace = (pattern, value, what) => {
    if (!pattern.test(toml)) throw new Error(`config.toml: linha de ${what} não encontrada`);
    toml = toml.replace(pattern, value);
  };
  replace(/^site_url = .*$/m, `site_url = ${tomlString(site)}`, "site_url");
  replace(
    /^additional_redirect_urls = .*$/m,
    `additional_redirect_urls = [${redirects.map(tomlString).join(", ")}]`,
    "additional_redirect_urls",
  );
  replace(/^email_sent = .*$/m, `email_sent = ${emailRate}`, "email_sent");
  if (/^\[auth\.email\.smtp\]/m.test(toml)) throw new Error("config.toml já declara [auth.email.smtp]");
  return `${toml.trimEnd()}

# Added by scripts/supabase-config.mjs (remote only): custom SMTP through Resend.
[auth.email.smtp]
enabled = true
host = "smtp.resend.com"
port = 465
user = "resend"
pass = "env(RESEND_API_KEY)"
admin_email = ${tomlString(senderEmail)}
sender_name = ${tomlString(senderName)}
`;
}

function main() {
  const args = process.argv.slice(2);
  const { problems, settings } = remoteSettings(process.env);
  if (problems.length) {
    console.error(`Configuração recusada:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  const workdir = join("supabase", ".temp", "config-push");
  rmSync(workdir, { recursive: true, force: true });
  mkdirSync(join(workdir, "supabase"), { recursive: true });
  cpSync(join("supabase", "templates"), join(workdir, "supabase", "templates"), { recursive: true });
  const toml = renderRemoteConfig(readFileSync(join("supabase", "config.toml"), "utf8"), settings);
  writeFileSync(join(workdir, "supabase", "config.toml"), toml);

  const command = args.includes("--diff") ? "diff" : "push";
  const cliArgs = ["supabase", "config", command, `--remote=${settings.ref}`, "--workdir", workdir];
  if (args.includes("--yes")) cliArgs.push("--yes");
  console.info(`supabase config ${command} -> ${settings.ref} (site_url ${settings.site})`);
  const result = spawnSync("npx", cliArgs, { stdio: "inherit", shell: process.platform === "win32" });
  rmSync(workdir, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

// `npm run db:push`: MANUAL push of migrations to a remote database. Normally not needed: production migrates in
// the Vercel build (scripts/build.mjs). Refuses to run without an explicit confirmation, so nobody pushes to
// production by accident (e.g. an AI agent "fixing" a failing migration).
//
//   SUPABASE_DB_URL=<uri of the target project> SUPABASE_DB_PUSH_CONFIRM=sim npm run db:push
import { spawnSync } from "node:child_process";

const url = process.env.SUPABASE_DB_URL;
if (process.env.SUPABASE_DB_PUSH_CONFIRM !== "sim" || !url) {
  console.error(
    [
      "db:push recusado. As migrações de produção rodam no build da Vercel (scripts/build.mjs).",
      "Para aplicar manualmente num projeto remoto (ex.: staging), confira o alvo e rode:",
      "  SUPABASE_DB_URL=<uri do projeto> SUPABASE_DB_PUSH_CONFIRM=sim npm run db:push",
      "Banco local: npm run db:reset.",
    ].join("\n"),
  );
  process.exit(1);
}

const result = spawnSync("npx", ["supabase", "db", "push", `--remote=${url}`, "--yes"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    SUPABASE_AUTH_CAPTCHA_SECRET: process.env.SUPABASE_AUTH_CAPTCHA_SECRET || "unused-by-db-push",
  },
});
process.exit(result.status ?? 1);

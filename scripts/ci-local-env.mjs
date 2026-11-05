// CI only: reads `supabase status -o env` of the local stack and exports what the app and the E2E need to
// $GITHUB_ENV (keys masked in the log). Fails loudly when something is missing.
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const status = spawnSync("npx", ["supabase", "status", "-o", "env"], { encoding: "utf8" });
if (status.status !== 0) {
  console.error(status.stderr || status.stdout);
  process.exit(1);
}
const vars = Object.fromEntries(
  status.stdout
    .split(/\r?\n/)
    .map((line) => /^([A-Z0-9_]+)=["']?(.*?)["']?$/.exec(line.trim()))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]),
);
const pick = (...names) => names.map((name) => vars[name]).find(Boolean);

const exports = {
  NEXT_PUBLIC_SUPABASE_URL: pick("API_URL") ?? "http://127.0.0.1:54321",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: pick("PUBLISHABLE_KEY", "ANON_KEY"),
  SUPABASE_SECRET_KEY: pick("SECRET_KEY", "SERVICE_ROLE_KEY"),
  E2E_MAILPIT_URL: pick("MAILPIT_URL", "INBUCKET_URL") ?? "http://127.0.0.1:54324",
  RLS_TEST_DB_URL: pick("DB_URL") ?? "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
};
const missing = Object.entries(exports).filter(([, value]) => !value);
if (missing.length) {
  console.error(`supabase status sem: ${missing.map(([key]) => key).join(", ")}\n${status.stdout}`);
  process.exit(1);
}
for (const key of ["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"]) {
  console.info(`::add-mask::${exports[key]}`);
}
const lines = Object.entries(exports).map(([key, value]) => `${key}=${value}`);
if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${lines.join("\n")}\n`);
console.info(`Exported: ${Object.keys(exports).join(", ")}`);

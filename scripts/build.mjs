// `npm run build`: applies the Supabase migrations BEFORE `next build` on Vercel production deploys (and, opt-in,
// on preview deploys pointed at a staging project). If the migration fails the build fails, Vercel keeps serving
// the previous deployment, and the new code never runs against an old schema.
//
// Env (Vercel > Settings > Environment Variables):
//   SUPABASE_DB_URL           Production environment only. Session pooler URI (port 5432; Vercel has no IPv6, so the
//                             direct db.<ref>.supabase.co host does not work there). Must be the same project as
//                             NEXT_PUBLIC_SUPABASE_URL, or the build stops.
//   SUPABASE_PRODUCTION_REF   Project ref of production, set in Production AND Preview: a preview refuses to migrate
//                             a database with this ref.
//   SUPABASE_MIGRATE_PREVIEW  "true" (Preview only) to migrate the staging project on preview deploys. Off by default:
//                             with several open PRs a shared staging database gets migrations from every branch and
//                             `db push` then fails on the others (Supabase Branching is the per-PR alternative).
//   SUPABASE_STAGING_DB_URL   Preview only, with SUPABASE_MIGRATE_PREVIEW: Session pooler URI of the STAGING project.
// Vercel exposes these variables to the running functions too (there are no build-only variables): the app never
// reads them, but treat the database password like the service-role key (strong, rotated, never in NEXT_PUBLIC_*).
// Anywhere else (local, CI) this is just `next build`.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Supabase project ref of a database URI (pooler user `postgres.<ref>` or host `db.<ref>.supabase.co`). */
export function dbUrlRef(url) {
  try {
    const parsed = new URL(url);
    return (
      /^postgres\.([a-z0-9]{20})$/.exec(decodeURIComponent(parsed.username))?.[1] ??
      /^db\.([a-z0-9]{20})\.supabase\.co$/.exec(parsed.hostname)?.[1] ??
      null
    );
  } catch {
    return null;
  }
}

/** Project ref of the Supabase API URL (https://<ref>.supabase.co). */
export function apiUrlRef(url) {
  try {
    return /^([a-z0-9]{20})\.supabase\.co$/.exec(new URL(url).hostname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Which database this build migrates: `{ url }`, `{ skip }` (nothing to do) or `{ error }` (stop the build).
 * The database must belong to the project the build talks to (NEXT_PUBLIC_SUPABASE_URL) and a preview can never
 * migrate production.
 */
export function migrationTarget(env) {
  const apiRef = apiUrlRef(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  if (env.VERCEL_ENV === "production") {
    const url = env.SUPABASE_DB_URL;
    if (!url) return { error: "SUPABASE_DB_URL is empty: refusing to deploy code without its migrations." };
    const ref = dbUrlRef(url);
    if (env.SUPABASE_PRODUCTION_REF && ref && ref !== env.SUPABASE_PRODUCTION_REF) {
      return { error: `SUPABASE_DB_URL points to project ${ref}, not SUPABASE_PRODUCTION_REF.` };
    }
    if (ref && apiRef && ref !== apiRef) {
      return { error: `SUPABASE_DB_URL (${ref}) and NEXT_PUBLIC_SUPABASE_URL (${apiRef}) are different projects.` };
    }
    return { url, label: "production" };
  }
  if (env.VERCEL_ENV === "preview" && env.SUPABASE_MIGRATE_PREVIEW === "true") {
    const url = env.SUPABASE_STAGING_DB_URL;
    if (!url) return { error: "SUPABASE_MIGRATE_PREVIEW=true but SUPABASE_STAGING_DB_URL is empty." };
    const ref = dbUrlRef(url);
    if (!ref) return { error: "Cannot read the project ref from SUPABASE_STAGING_DB_URL (use the Supabase URI)." };
    if (!env.SUPABASE_PRODUCTION_REF) {
      return { error: "Set SUPABASE_PRODUCTION_REF in Preview too: it is how a preview proves it is not production." };
    }
    if (ref === env.SUPABASE_PRODUCTION_REF) return { error: "SUPABASE_STAGING_DB_URL points to PRODUCTION." };
    if (apiRef && ref !== apiRef) {
      return {
        error: `SUPABASE_STAGING_DB_URL (${ref}) and NEXT_PUBLIC_SUPABASE_URL (${apiRef}) are different projects.`,
      };
    }
    return { url, label: "staging" };
  }
  return { skip: true };
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: "inherit", env, shell: process.platform === "win32" });
  if (result.status !== 0) {
    console.error(`[build] "${command} ${args[0] ?? ""} ${args[1] ?? ""}" failed (exit ${result.status ?? "signal"}).`);
    process.exit(result.status ?? 1);
  }
}

function main() {
  const target = migrationTarget(process.env);
  if (target.error) {
    console.error(`[build] ${target.error}`);
    process.exit(1);
  }
  if (target.url) {
    console.info(`[build] Applying Supabase migrations (${target.label}) before next build...`);
    run("npx", ["supabase", "db", "push", `--remote=${target.url}`, "--yes"], {
      ...process.env,
      // config.toml is parsed by the CLI; this value is not pushed by `db push`.
      SUPABASE_AUTH_CAPTCHA_SECRET: process.env.SUPABASE_AUTH_CAPTCHA_SECRET || "unused-by-db-push",
    });
  } else {
    console.info(`[build] VERCEL_ENV=${process.env.VERCEL_ENV ?? "(none)"}: no migrations here, only next build.`);
  }
  run("npx", ["next", "build"]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

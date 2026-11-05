// Restore drill (.github/workflows/restore-drill.yml): compares the restored database with the row counts recorded
// at backup time and, when the Storage archive exists, the number of files with storage.objects.
// Usage: RESTORE_DB_URL=... node scripts/restore-drill-check.mjs <counts.json> [<storage dir>]
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/** Rows may be written between the dump snapshot and the count: allow max(5 rows, 1%). */
export const withinTolerance = (expected, actual) => Math.abs(expected - actual) <= Math.max(5, expected * 0.01);

export function compareCounts(expected, actual) {
  const problems = [];
  for (const [table, count] of Object.entries(expected)) {
    if (!(table in actual)) problems.push(`${table}: missing after restore`);
    else if (count > 0 && actual[table] === 0) problems.push(`${table}: ${count} rows at backup, 0 restored`);
    else if (!withinTolerance(count, actual[table]))
      problems.push(`${table}: ${count} at backup, ${actual[table]} restored`);
  }
  return problems;
}

const countFiles = (dir) =>
  readdirSync(dir).reduce((total, name) => {
    const path = join(dir, name);
    return total + (statSync(path).isDirectory() ? countFiles(path) : 1);
  }, 0);

async function main() {
  const [countsPath, storageDir] = process.argv.slice(2);
  const expected = JSON.parse(readFileSync(countsPath, "utf8"));
  const client = new pg.Client({ connectionString: process.env.RESTORE_DB_URL });
  await client.connect();
  const actual = {};
  for (const table of Object.keys(expected)) {
    const [schema, name] = table.split(".");
    try {
      const { rows } = await client.query(
        `select count(*)::bigint as c from ${client.escapeIdentifier(schema)}.${client.escapeIdentifier(name)}`,
      );
      actual[table] = Number(rows[0].c);
    } catch {
      // Missing table: reported by compareCounts.
    }
  }
  const problems = compareCounts(expected, actual);
  for (const table of Object.keys(expected)) {
    console.info(
      `${table.padEnd(32)} backup ${String(expected[table]).padStart(9)}  restored ${String(actual[table] ?? "-").padStart(9)}`,
    );
  }

  if (storageDir && existsSync(storageDir)) {
    const files = countFiles(storageDir);
    const { rows } = await client.query(`select count(*)::bigint as c from storage.objects`);
    const objects = Number(rows[0].c);
    console.info(`Storage: ${files} files in the archive, ${objects} rows in storage.objects`);
    if (!withinTolerance(objects, files))
      problems.push(`storage: ${objects} objects in the database, ${files} files backed up`);
  }
  await client.end();

  if (problems.length) {
    console.error(`Restore drill FAILED:\n- ${problems.join("\n- ")}`);
    process.exit(1);
  }
  console.info("Restore drill OK.");
}

if (process.argv[1]?.endsWith("restore-drill-check.mjs")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

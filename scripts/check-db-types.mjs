// `npm run db:types:check` (CI job "Banco real", needs the local stack: `supabase start`): generates the types from
// the real database and fails if src/lib/supabase/database.types.ts describes a different schema. The comparison
// is by TYPE (tables: Row/Insert/Update + foreign keys; functions: Args/Returns), so formatting, comments and the
// helper types do not matter. Fix a failure with `npm run db:types` (or edit the file to match the migration).
//
// Usage: node scripts/check-db-types.mjs [path/to/generated.ts]   (without a path it runs `supabase gen types`)
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const dir = join("supabase", ".temp", "types-check");
mkdirSync(dir, { recursive: true });
const shell = process.platform === "win32";

let generatedPath = process.argv[2];
if (!generatedPath) {
  generatedPath = join(dir, "generated.ts");
  const gen = spawnSync("npx", ["supabase", "gen", "types", "typescript", "--schema", "public"], {
    encoding: "utf8",
    shell,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (gen.status !== 0) {
    console.error(gen.stderr || gen.stdout);
    console.error("Não foi possível gerar os tipos: o Supabase local está rodando (npm run db:start)?");
    process.exit(1);
  }
  writeFileSync(generatedPath, gen.stdout);
}

const importPath = (path) => `./${relative(dir, path).split("\\").join("/").replace(/\.ts$/, "")}`;
const checkFile = join(dir, "check.ts");
writeFileSync(
  checkFile,
  `import type { Database as Generated } from "${importPath(generatedPath)}";
import type { Database as Committed } from "${importPath(join("src", "lib", "supabase", "database.types.ts"))}";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type ForeignKeys<R> = R extends readonly (infer F)[] ? (F extends { foreignKeyName: infer N } ? N : never) : never;
type TableShape<S> = {
  [K in keyof S]: S[K] extends { Row: infer R; Insert: infer I; Update: infer U; Relationships: infer F }
    ? { Row: R; Insert: I; Update: U; foreignKeys: ForeignKeys<F> }
    : S[K];
};
type FunctionShape<S> = { [K in keyof S]: S[K] extends { Args: infer A; Returns: infer R } ? { Args: A; Returns: R } : S[K] };
/** Names present in only one side or with a different type. */
type Diff<A, B> = {
  [K in keyof A | keyof B]: K extends keyof A ? (K extends keyof B ? (Equal<A[K], B[K]> extends true ? never : K) : K) : K;
}[keyof A | keyof B];

type G = Generated["public"];
type C = Committed["public"];

// A compile error below names what differs: run \`npm run db:types\` (or fix database.types.ts by hand).
export const tablesThatDiffer: never = undefined as unknown as Diff<TableShape<G["Tables"]>, TableShape<C["Tables"]>>;
export const viewsThatDiffer: never = undefined as unknown as Diff<TableShape<G["Views"]>, TableShape<C["Views"]>>;
export const functionsThatDiffer: never = undefined as unknown as Diff<
  FunctionShape<G["Functions"]>,
  FunctionShape<C["Functions"]>
>;
export const enumsThatDiffer: never = undefined as unknown as Diff<G["Enums"], C["Enums"]>;
`,
);

const tsc = spawnSync(
  "npx",
  [
    "tsc",
    "--noEmit",
    "--strict",
    "--skipLibCheck",
    "--target",
    "es2022",
    "--module",
    "esnext",
    "--moduleResolution",
    "bundler",
    checkFile,
  ],
  { stdio: "inherit", shell },
);
if (tsc.status !== 0) {
  console.error("\ndatabase.types.ts não corresponde ao banco gerado pelas migrações (veja os nomes acima).");
  if (process.env.CI) {
    // No Docker locally? Copy the file below into src/lib/supabase/database.types.ts.
    console.info("\n----- BEGIN GENERATED database.types.ts -----");
    console.info(readFileSync(generatedPath, "utf8"));
    console.info("----- END GENERATED database.types.ts -----");
  }
  process.exit(1);
}
console.info("database.types.ts corresponde ao schema das migrações.");

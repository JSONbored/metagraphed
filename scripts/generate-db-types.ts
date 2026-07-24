// kanel's CJS build re-exports everything off its default export rather than
// as real top-level named exports under Node's ESM interop (confirmed
// empirically: `import processDatabase from "kanel"` resolves to the whole
// exports object, not the function itself) -- destructure off the default.
import kanelPkg from "kanel";
import path from "node:path";
import {
  startScratchPostgres,
  stopScratchPostgres,
} from "./db-types-scratch-container.ts";
import { repoRoot } from "./lib.ts";

// Kanel schema introspection against a disposable scratch Postgres
// (types-epic C, #7861) -- generates per-table row interfaces for every
// table in deploy/postgres/schema.sql's public schema (31 tables today).
// Adoption in workers/data-api.ts is scoped to the 10 tables the issue
// lists explicitly; this script itself generates the full schema so a
// later adoption batch never needs to re-run codegen against a narrower
// scope, and so the drift gate covers the whole schema, not just the
// currently-adopted slice.
//
// Tool choice (pre-made in the issue, recorded here for the same reason):
// Kanel over kysely-codegen (couples output to a query builder this repo
// doesn't use) or pgtyped (needs per-query annotations across ~200 call
// sites -- too invasive for phase one). Kanel emits plain interfaces per
// table, which is exactly what postgres.js's `sql<Row[]>\`...\`` call sites
// need with zero further wiring.
export async function generateDbTypes(): Promise<void> {
  const { processDatabase } = kanelPkg;
  const db = await startScratchPostgres();
  try {
    await processDatabase({
      connection: db.connectionString,
      schemas: ["public"],
      outputPath: path.join(repoRoot, "generated/db"),
      preDeleteOutputFolder: true,
    });
  } finally {
    stopScratchPostgres(db.containerName);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await generateDbTypes();
  console.log("Generated Postgres row types.");
}

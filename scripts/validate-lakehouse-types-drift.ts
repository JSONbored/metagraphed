// generated/lakehouse/types.ts must be what the committed snapshot produces.
//
// The same guarantee validate-db-types-drift.ts gives, and the same limit: it
// CANNOT catch the lakehouse having moved. Nothing readable from a pull request
// can. `scripts/refresh-lakehouse-schema.ts` is that check and it runs out of
// band against the real catalog with R2_CATALOG_TOKEN.
//
// What this does catch is the artifact being hand-edited or left stale after a
// re-snapshot -- which for these four tables means a producer building rows
// against a column list the loader will reject at append time.
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import {
  emitTypes,
  readSnapshot,
  TYPES_PATH,
} from "./generate-lakehouse-types.ts";

const committed = readFileSync(path.join(repoRoot, TYPES_PATH), "utf8");
const regenerated = emitTypes(readSnapshot());

if (committed === regenerated) {
  process.stdout.write(
    `${TYPES_PATH} matches ${"generated/lakehouse/schema.json"}.\n`,
  );
  process.exit(0);
}

process.stderr.write(
  `${TYPES_PATH} is stale. Run \`npm run build:lakehouse-types\` and commit ` +
    "the result.\n",
);
process.exit(1);

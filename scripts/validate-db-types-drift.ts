// The committed db types must be what the snapshot generates (#10261).
//
// Deterministic and credential-free: it regenerates `generated/db/types.ts`
// from the committed `generated/db/schema.json` and compares. That catches a
// hand-edit to a generated file and a snapshot updated without regenerating --
// which is the pair `validate:contract-drift` catches for `openapi.json`, and
// the same reason it exists.
//
// It CANNOT catch production having moved. Nothing readable from a pull request
// can. `scripts/snapshot-neon-schema.ts` is that check, and it runs out of band
// against a real branch.
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import { emitTypes, readSnapshot, TYPES_PATH } from "./generate-db-types.ts";

const committed = readFileSync(path.join(repoRoot, TYPES_PATH), "utf8");
const regenerated = emitTypes(readSnapshot());

if (committed === regenerated) {
  const columns = readSnapshot();
  console.log(
    `db-types drift: ${TYPES_PATH} is current (${new Set(columns.map((c) => c.table)).size} table(s), ${columns.length} column(s)).`,
  );
  process.exit(0);
}

// The first differing line, rather than a whole-file diff: the file is 750
// lines and the useful fact is which column moved.
const committedLines = committed.split("\n");
const regeneratedLines = regenerated.split("\n");
const at = committedLines.findIndex(
  (line, index) => line !== regeneratedLines[index],
);
console.error(
  `db-types drift: ${TYPES_PATH} is not what ${"generated/db/schema.json"} generates -- run \`npm run build:db-types\` and commit the result.`,
);
if (at >= 0) {
  console.error(`  first difference at line ${at + 1}:`);
  console.error(`    committed:    ${committedLines[at] ?? "(end of file)"}`);
  console.error(`    regenerated:  ${regeneratedLines[at] ?? "(end of file)"}`);
}
process.exit(1);

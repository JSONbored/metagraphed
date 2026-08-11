// generated/lakehouse/types.ts and types.rs must be what the committed
// snapshot produces.
//
// The same guarantee validate-db-types-drift.ts gives, and the same limit: it
// CANNOT catch the lakehouse having moved. Nothing readable from a pull request
// can. `scripts/refresh-lakehouse-schema.ts` is that check and it runs out of
// band against the real catalog with R2_CATALOG_TOKEN.
//
// What this does catch is either artifact being hand-edited or left stale after
// a re-snapshot -- which for these four tables means a producer building rows
// against a column list the loader will reject at append time.
//
// BOTH artifacts, since #10315. The Rust one is the PRODUCER's side: the
// decoder in metagraphed-infra/services/indexer-rs builds its rows as
// `serde_json::json!({ "hotkey": …, "netuid": … })`, so today a column rename
// is caught by `iceberg_load.py`'s cast INSIDE the append rather than by the
// compiler. Letting types.rs go stale while types.ts moved would put the two
// halves of one schema out of step, which is the specific failure the pair
// exists to prevent.
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import {
  emitRustTypes,
  emitTypes,
  readSnapshot,
  RUST_PATH,
  SNAPSHOT_PATH,
  TYPES_PATH,
} from "./generate-lakehouse-types.ts";

const snapshot = readSnapshot();
const stale = (
  [
    [TYPES_PATH, emitTypes(snapshot)],
    [RUST_PATH, emitRustTypes(snapshot)],
  ] as const
).filter(
  ([file, regenerated]) =>
    readFileSync(path.join(repoRoot, file), "utf8") !== regenerated,
);

if (stale.length === 0) {
  process.stdout.write(
    `${TYPES_PATH} and ${RUST_PATH} match ${SNAPSHOT_PATH}.\n`,
  );
  process.exit(0);
}

process.stderr.write(
  `${stale.map(([file]) => file).join(", ")} stale. Run ` +
    "`npm run build:lakehouse-types` and commit the result.\n",
);
process.exit(1);

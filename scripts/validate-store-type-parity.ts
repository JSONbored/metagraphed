// The same table in Neon and in the lakehouse must agree on shape (#11043).
//
// Every other seam here is checked: `db-types-drift` (Neon -> generated),
// `lakehouse-types-drift` (catalog -> generated + Zod), `lakehouse-readers`
// (readers -> snapshot), and the MCP/REST/GraphQL parity gates. Nothing
// compared the SAME TABLE ACROSS THE TWO STORES, and that gap cost four
// narrowings and two dropped columns before anyone looked:
//
//   neuron_daily.take                          float8 -> float
//   nominator_positions.share_fraction         float8 -> float
//   subnet_hyperparams.weights_version         int8   -> int
//   subnet_hyperparams_history.weights_version int8   -> int
//   nominator_positions.shares                 numeric -> ABSENT
//   nominator_positions.source                 text    -> ABSENT
//
// The lakehouse is the long-term store: it is supposed to hold the chain's
// history, and a narrowing there is not a formatting difference. `float8 ->
// float` loses the ninth decimal of a published commission on every append;
// `int8 -> int` OVERFLOWS past 2^31, and `weights_version` is a chain-derived
// counter rather than a bounded enum.
//
// ## Widening passes, narrowing fails
//
// The direction is the whole rule. `int4 -> long` carries every int4 that will
// ever exist, so it loses nothing and is allowed silently. `int8 -> int` cannot
// carry what it is given. A gate that flagged both would report three harmless
// rows beside four real ones and get muted.
//
// ## Absent is a FAILURE, not a projection
//
// A column in Neon and missing from the lakehouse means the archive cannot
// reconstruct the row. `nominator_positions.shares` arrived in migration 0025,
// AFTER the 2026-08-02 exodus load, so the frozen copy predates the column and
// never gained it -- invisible from either side alone, which is exactly what
// this compares.
//
// Pure over two COMMITTED snapshots: no network, no token, no catalog call.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./lib.ts";

const NEON_SNAPSHOT = "generated/db/schema.json";
const LAKE_SNAPSHOT = "generated/lakehouse/schema.json";

/**
 * Every Iceberg type a Neon type may be stored as, WIDEST FIRST.
 *
 * Read as "a value of this Neon type fits, without loss, in each of these".
 * `int8` is not in `int`'s list and that asymmetry is the point.
 */
const FITS: Readonly<Record<string, ReadonlySet<string>>> = {
  int2: new Set(["int", "long"]),
  int4: new Set(["int", "long"]),
  int8: new Set(["long"]),
  float4: new Set(["float", "double"]),
  float8: new Set(["double"]),
  // Arbitrary precision on one side, 64-bit float on the other. `double` is
  // what the writer produces and what every reader here already assumes; the
  // narrowing is inherent to the format, not a mistake this gate can fix.
  numeric: new Set(["double"]),
  bool: new Set(["boolean"]),
  text: new Set(["string", "date"]),
  varchar: new Set(["string", "date"]),
  date: new Set(["date", "string"]),
  json: new Set(["string"]),
  jsonb: new Set(["string"]),
  timestamptz: new Set(["long", "string"]),
  timestamp: new Set(["long", "string"]),
};

/**
 * The divergences that exist today, and the ONLY ones tolerated. IT SHRINKS.
 *
 * Shipping this simply red would make it noise, and a gate nobody reads is how
 * four narrowings and two dropped columns lasted this long. So the known set is
 * a BASELINE: anything not on it fails immediately, and an entry that stops
 * diverging fails too, because a stale entry overstates the damage.
 *
 * Every line is a data-loss bug with an owner (#11043) and a known fix --
 * Iceberg widening is a safe promotion. This is the scoreboard for closing
 * them, not permission to keep them.
 */
const KNOWN: ReadonlySet<string> = new Set<string>([
  // EMPTY, and it stays that way. All six original divergences were fixed in
  // the catalog on 2026-08-13 (metagraphed-infra#536): the two float32
  // narrowings and both int8 -> int32 `weights_version` columns were widened,
  // and `nominator_positions.shares` / `.source` -- added by migration 0025
  // AFTER the 2026-08-02 exodus load, so the frozen copy never had them --
  // were added. Every record count was checked before and after; Iceberg
  // widening rewrites nothing.
  //
  // Emptying this was not optional. The gate fails on a KNOWN entry that has
  // STOPPED diverging, precisely so a baseline cannot outlive the damage it
  // describes and quietly overstate it.
]);
export interface Column {
  table: string;
  column: string;
}
interface NeonColumn extends Column {
  udt: string;
}
interface LakeColumn extends Column {
  type: string;
}
export interface Divergence {
  table: string;
  column: string;
  detail: string;
}

/** The verdict for two snapshots, as a pure function so the rule is testable. */
export function compare(
  neon: readonly NeonColumn[],
  lake: readonly LakeColumn[],
): { narrowed: Divergence[]; dropped: Divergence[]; compared: number } {
  const byTableNeon = new Map<string, Map<string, string>>();
  for (const c of neon) {
    if (!byTableNeon.has(c.table)) byTableNeon.set(c.table, new Map());
    byTableNeon.get(c.table)!.set(c.column, c.udt);
  }
  const byTableLake = new Map<string, Map<string, string>>();
  for (const c of lake) {
    if (!byTableLake.has(c.table)) byTableLake.set(c.table, new Map());
    byTableLake.get(c.table)!.set(c.column, c.type);
  }
  const narrowed: Divergence[] = [];
  const dropped: Divergence[] = [];
  let compared = 0;
  for (const [table, cols] of byTableNeon) {
    const lakeCols = byTableLake.get(table);
    // A table that exists in only one store is not a divergence: Neon carries
    // 64 tables and the lakehouse archives a subset by design.
    if (!lakeCols) continue;
    for (const [column, udt] of cols) {
      compared += 1;
      const stored = lakeCols.get(column);
      if (stored === undefined) {
        dropped.push({
          table,
          column,
          detail: `${table}.${column} is ${udt} in Neon and ABSENT from the lakehouse -- the archive cannot reconstruct the row`,
        });
        continue;
      }
      const fits = FITS[udt];
      // An unmapped Neon type is not silently passed: saying "we have not
      // decided how this is stored" is a different fact from "it fits".
      if (!fits) {
        narrowed.push({
          table,
          column,
          detail: `${table}.${column}: Neon type \`${udt}\` has no declared lakehouse mapping -- add it to FITS`,
        });
        continue;
      }
      if (!fits.has(stored)) {
        narrowed.push({
          table,
          column,
          detail: `${table}.${column}: Neon ${udt} stored as lakehouse ${stored} -- a value that fits in ${udt} may not fit in ${stored}`,
        });
      }
    }
  }
  return { narrowed, dropped, compared };
}

function main(): void {
  const neon = JSON.parse(
    readFileSync(path.join(repoRoot, NEON_SNAPSHOT), "utf8"),
  ) as NeonColumn[];
  const lake = JSON.parse(
    readFileSync(path.join(repoRoot, LAKE_SNAPSHOT), "utf8"),
  ) as LakeColumn[];
  const { narrowed, dropped, compared } = compare(neon, lake);
  const all = [...narrowed, ...dropped];
  const key = (d: Divergence) => `${d.table}.${d.column}`;
  const seen = new Set(all.map(key));
  const fixed = [...KNOWN].filter((k) => !seen.has(k));
  const failures = all.filter((d) => !KNOWN.has(key(d)));
  process.stdout.write(
    `store-type-parity: ${compared} shared column(s); ${all.length} diverge ` +
      `(${all.length - failures.length} known, baseline ${KNOWN.size}), ` +
      `${failures.length} NEW, ${fixed.length} fixed.\n`,
  );
  if (fixed.length > 0) {
    process.stderr.write(
      "\nFIXED -- delete these from KNOWN so the baseline keeps shrinking:\n" +
        fixed.map((k) => `  ${k}`).join("\n") +
        "\n",
    );
  }
  if (failures.length === 0 && fixed.length === 0) return;
  const narrowedNew = narrowed.filter((d) => !KNOWN.has(key(d)));
  const droppedNew = dropped.filter((d) => !KNOWN.has(key(d)));
  const narrowed_ = narrowedNew;
  const dropped_ = droppedNew;
  void narrowed_;
  void dropped_;
  process.stderr.write(
    `\n${failures.length} NEW column(s) lose data on the way to the lakehouse.\n\n` +
      (narrowedNew.length
        ? `NARROWED:\n${narrowedNew.map((d) => `  ${d.detail}`).join("\n")}\n\n`
        : "") +
      (droppedNew.length
        ? `DROPPED:\n${droppedNew.map((d) => `  ${d.detail}`).join("\n")}\n\n`
        : "") +
      `Iceberg widening (int -> long, float -> double) is a safe promotion: no\n` +
      `rewrite, forward and backward compatible. See #11043.\n`,
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

// The lane topology declaration must describe tables that actually exist
// (#11183).
//
// `src/lane-table-topology.ts` states things Postgres cannot know -- that a
// producer prunes only its own rows, that a partial pass is partial in
// coldkeys. Those are declarations and stay declarations. What this gates is
// the half that IS checkable: every column the declaration names must exist in
// `generated/db/schema.json`, the snapshot introspected from live Neon.
//
// WHY THAT MATTERS MORE THAN IT SOUNDS. The declaration is consumed by coverage
// rules to scope their queries. A column renamed upstream would not fail those
// rules loudly -- `WHERE source = $1` against a dropped column errors, but a
// coverageUnit pointing at a column that moved would quietly count the wrong
// thing, which is precisely the class of failure #11166/#11170/#11180 were.
//
// The consistency rules below are the other half: they refuse declarations that
// are internally impossible, so a table cannot claim two producers without
// saying how to tell them apart.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import {
  COVERAGE_UNIT_ROWS,
  LANE_TABLE_TOPOLOGY,
  type LaneTableTopology,
} from "../src/lane-table-topology.ts";

const SNAPSHOT_PATH = "generated/db/schema.json";

interface ColumnRow {
  table: string;
  column: string;
}

/** table -> its columns, from the introspected snapshot. */
export function columnsByTable(raw: string): Map<string, Set<string>> {
  const parsed = JSON.parse(raw) as ColumnRow[] | { columns: ColumnRow[] };
  const rows = Array.isArray(parsed) ? parsed : parsed.columns;
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!out.has(row.table)) out.set(row.table, new Set());
    out.get(row.table)!.add(row.column);
  }
  return out;
}

export function problemsFor(
  topology: Readonly<Record<string, LaneTableTopology>>,
  columns: Map<string, Set<string>>,
): string[] {
  const problems: string[] = [];
  for (const [table, t] of Object.entries(topology)) {
    const cols = columns.get(table);
    if (!cols) {
      problems.push(
        `${table}: declared here but absent from ${SNAPSHOT_PATH} -- either the table was dropped or the snapshot is stale`,
      );
      continue;
    }

    const needsColumn: [string, string | null][] = [
      ["producers.column", t.producers.column],
      [
        "coverageUnit",
        t.coverageUnit === COVERAGE_UNIT_ROWS ? null : t.coverageUnit,
      ],
      ["prunes.perKey", t.prunes === false ? null : t.prunes.perKey],
    ];
    for (const [field, column] of needsColumn) {
      if (column && !cols.has(column)) {
        problems.push(
          `${table}.${field} names "${column}", which is not a column of ${table} (${[...cols].sort().join(", ")})`,
        );
      }
    }

    // A table cannot claim several producer lanes without a way to tell them
    // apart: that is exactly the state nominator_positions was read in (#11180).
    if (t.producers.lanes.length > 1 && !t.producers.column) {
      problems.push(
        `${table}: declares ${t.producers.lanes.length} producer lanes but no column to tell them apart, so a coverage rule cannot scope to one`,
      );
    }
    if (t.producers.lanes.length > 1 && !t.producers.fullScanValue) {
      problems.push(
        `${table}: declares several producer lanes but names no fullScanValue, so a rule cannot know whose completeness it is judging`,
      );
    }
    if (t.producers.lanes.length === 1 && t.producers.column) {
      problems.push(
        `${table}: declares one producer lane but also a discriminator column -- one of the two is wrong, and a rule scoping on it would filter to a subset of a single writer's rows`,
      );
    }
    if (t.producers.fullScanValue && !t.producers.column) {
      problems.push(
        `${table}: names a fullScanValue but no column to match it against, so the value can never be applied`,
      );
    }
  }
  return problems;
}

function main(): void {
  const columns = columnsByTable(
    readFileSync(path.join(repoRoot, SNAPSHOT_PATH), "utf8"),
  );
  const problems = problemsFor(LANE_TABLE_TOPOLOGY, columns);
  if (problems.length) {
    process.stderr.write(
      `lane-topology: ${problems.length} problem(s):\n` +
        problems.map((p) => `  ${p}`).join("\n") +
        `\n  -> src/lane-table-topology.ts describes what a coverage rule needs to\n` +
        `     scope correctly. A declaration that disagrees with the schema does not\n` +
        `     fail the rule loudly; it makes it count the wrong thing.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `lane-topology: ${Object.keys(LANE_TABLE_TOPOLOGY).length} lane table(s) declared, every named column present.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

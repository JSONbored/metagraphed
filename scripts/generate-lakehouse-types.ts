// Types and column tuples for the four Iceberg tables, from a committed schema
// snapshot (#10315).
//
// THE LAKEHOUSE WAS THE ONE STORE WHOSE SCHEMA GENERATED NOTHING. Everywhere
// else the schema is the contract and types fall out of it -- `schemas-src/` ->
// openapi.json -> `ApiSchema<>`, and `generated/db/schema.json` ->
// `generated/db/types.ts` for every Neon table (#10261). The Iceberg tables
// have a live schema in the catalog and every producer built rows against it
// FROM MEMORY: the Rust decoder constructs row maps by hand, and so does every
// ad-hoc projector.
//
// WHEN THE ONLY CHECK FIRES IS THE PROBLEM. `iceberg_load.py` reads column
// types off the live table and casts the incoming rows to them, which is
// correct and stays. But that cast is the FIRST thing that compares a
// producer's idea of the schema to the real one, and it happens inside the
// append -- the one irreversible step. A decoder that renames a column
// compiles, tests, runs, produces rows, and fails at the last possible moment.
// `--dry-run` exists because that is too late, which is an admission that the
// check belongs earlier.
//
// This moves it earlier for anything written in this repo: import the column
// tuple instead of hand-typing eleven names.
//
// WHAT THIS CANNOT DO, and the snapshot boundary is the same one
// generate-db-types.ts documents: nothing readable from a pull request can
// catch the LAKEHOUSE having moved. `npm run refresh:lakehouse-schema` is that
// check and it needs R2_CATALOG_TOKEN, so it runs out of band against the real
// catalog. The drift validator only asserts that the committed types match the
// committed snapshot -- that the repo is internally consistent.
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import { CHAIN_FIREHOSE_TOPICS } from "../src/chain-firehose-topics.ts";

export const SNAPSHOT_PATH = "generated/lakehouse/schema.json";
export const TYPES_PATH = "generated/lakehouse/types.ts";
export const RUST_PATH = "generated/lakehouse/types.rs";
/**
 * The Zod lands in `schemas-src/`, with every other schema in this repo.
 *
 * Its siblings from this generator (types.ts, types.rs) are TYPES and belong
 * beside the snapshot they describe. A Zod schema is a SCHEMA, and this repo
 * has one place for those -- #9830's rule is that a schema has a single
 * source, and a second home for lakehouse shapes is exactly the split that
 * rule exists to prevent. Generated rather than hand-written, so the "do not
 * edit" header and the drift gate still apply: it is single-sourced from the
 * catalog snapshot AND single-homed with the rest of the contract.
 */
export const ZOD_PATH = "schemas-src/lakehouse.ts";

export interface LakehouseColumn {
  table: string;
  field_id: number;
  column: string;
  type: string;
  required: boolean;
}

export function readSnapshot(): LakehouseColumn[] {
  return JSON.parse(
    readFileSync(path.join(repoRoot, SNAPSHOT_PATH), "utf8"),
  ) as LakehouseColumn[];
}

/**
 * Iceberg primitive -> TypeScript.
 *
 * `long` IS `number`, unlike `int8` in generated/db/types.ts, and the
 * difference is the reader rather than a preference. Postgres `int8` arrives
 * through node-postgres, whose parser leaves a value a STRING when it is not
 * exactly representable (src/pg-sql.ts), so the type has to admit both. R2 SQL
 * answers JSON, so a `long` is already a JS number by the time any code here
 * sees it -- typing it `number | string` would describe a shape that cannot
 * occur and push a coercion onto every call site.
 *
 * Every `long` in these four tables is a block number, an index, or
 * epoch-milliseconds. The largest is ~1.79e12 against a safe ceiling of
 * ~9.01e15, so the representable range is not close.
 */
const TS_TYPE: Readonly<Record<string, string>> = {
  // Iceberg uuid, which R2 SQL returns as BASE64-ENCODED BYTES
  // ("AA2+kG8JRdOnBgo8lnnc5Q==") rather than canonical uuid text -- verified
  // against chain.surfaces.id. A reader expecting "0a0dbe90-..." gets a string
  // that is the right type and the wrong value, which is why this is mapped
  // explicitly rather than left to fall back to string.
  uuid: "string",
  // Iceberg timestamptz. R2 SQL renders it as an ISO-8601 string with
  // MICROSECOND precision ("2026-08-02T00:00:35.111100Z"), not as an epoch
  // number -- verified against chain.subnets.updated_at. Everything else
  // temporal in this lakehouse is `long` epoch-ms; these three registry tables
  // are the exception, inherited from the 2026-08-02 exodus load.
  timestamptz: "string",
  boolean: "boolean",
  // `date` IS `string`, and that is read off the reader rather than assumed.
  // R2 SQL serializes an Iceberg date as 'YYYY-MM-DD', and
  // src/self-health-cold-tier.ts:42 has been asserting exactly that at runtime
  // since before this generator existed -- it rejects the row unless
  // `typeof row.day === "string"` and the value matches DAY_SHAPE. Typing it
  // `number` (the days-since-epoch it is on disk) would describe a shape the
  // reader treats as malformed.
  date: "string",
  double: "number",
  // 32-bit on disk, a JS number by the time it arrives over JSON -- the same
  // reasoning `double` and `long` are given above.
  float: "number",
  int: "number",
  long: "number",
  string: "string",
};

const pascal = (table: string) =>
  table
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

export function emitTypes(columns: LakehouseColumn[]): string {
  const tables = [...new Set(columns.map((c) => c.table))];
  const out: string[] = [
    "// GENERATED by scripts/generate-lakehouse-types.ts from",
    `// ${SNAPSHOT_PATH}. Do not edit. Run \`npm run build:lakehouse-types\``,
    "// after re-snapshotting the catalog with `npm run refresh:lakehouse-schema`.",
    "//",
    "// One interface per Iceberg table in the `chain` namespace, plus the",
    "// column tuple in FIELD-ID ORDER -- which is the order the loader appends",
    "// and therefore the order a hand-built row must be written in.",
    "",
  ];
  for (const table of tables) {
    const cols = columns
      .filter((c) => c.table === table)
      .sort((a, b) => a.field_id - b.field_id);
    const unknown = cols.filter((c) => !TS_TYPE[c.type]);
    if (unknown.length > 0) {
      throw new Error(
        `unmapped Iceberg type(s) in ${table}: ` +
          unknown.map((c) => `${c.column}:${c.type}`).join(", ") +
          " -- add it to TS_TYPE rather than letting it fall back",
      );
    }
    out.push(`/** \`chain.${table}\` */`);
    // A TYPE ALIAS, NOT AN INTERFACE, and the difference is load-bearing. An
    // interface has no implicit index signature, so `BlocksRow` is not
    // assignable to `Record<string, unknown>` -- and every formatter these rows
    // feed takes exactly that. Emitting an interface made the generated types
    // unusable at the boundary they exist to cross; a type alias gets the
    // implicit signature and passes straight through.
    out.push(`export type ${pascal(table)}Row = {`);
    for (const c of cols) {
      const optional = c.required ? "" : " | null";
      out.push(`  ${c.column}: ${TS_TYPE[c.type]}${optional};`);
    }
    out.push("};");
    out.push("");
    out.push(`/** \`chain.${table}\` columns, in field-id order. */`);
    out.push(
      `export const ${table.toUpperCase()}_COLUMNS = [`,
      ...cols.map((c) => `  ${JSON.stringify(c.column)},`),
      "] as const;",
      "",
    );
  }
  out.push("/** Every Iceberg table this repo reads, by name. */");
  out.push(
    "export const LAKEHOUSE_TABLES = [",
    ...tables.map((t) => `  ${JSON.stringify(t)},`),
    "] as const;",
    "",
  );
  return out.join("\n");
}

/**
 * Iceberg primitive -> Rust, for the producer side.
 *
 * The decoder in `metagraphed-infra/services/indexer-rs` builds its rows as
 * `serde_json::json!({ "hotkey": …, "netuid": … })` -- column names as string
 * literals, typed from memory. Nothing compares that to the real schema until
 * `iceberg_load.py` casts the incoming rows inside the APPEND, which is the
 * one irreversible step; `--dry-run` exists because that is too late (#10315).
 *
 * A struct whose field names ARE the columns moves the check to compile time:
 * rename a column here and the decoder stops building.
 *
 * `long` is `i64` rather than `u64` even where the value cannot be negative --
 * Iceberg's `long` is signed, and widening it in the producer would let a
 * value through that the table cannot hold.
 */
const RUST_TYPE: Readonly<Record<string, string>> = {
  boolean: "bool",
  double: "f64",
  int: "i32",
  long: "i64",
  string: "String",
};

/**
 * The tables the decoder WRITES -- a subset of the ones the snapshot covers.
 *
 * Exported so the test can assert it stays a subset: a name here that the
 * snapshot does not carry would emit a struct for a table nobody has the schema
 * of, which is the failure this whole generator exists to prevent.
 *
 * Derived from the firehose topic vocabulary (#11045): the decoder's four
 * tables ARE the four topics, one declaration.
 */
export const DECODER_TABLES: readonly string[] = CHAIN_FIREHOSE_TOPICS;

/**
 * The Rust mirror of `emitTypes`, for the decoder that writes these tables.
 *
 * FIELD ORDER IS DECLARATION ORDER, and serde preserves it, so a struct
 * serialized to JSON produces the columns in field-id order -- the order the
 * loader appends in.
 */
/**
 * Iceberg primitive -> Zod, mirroring TS_TYPE column for column.
 *
 * Generated rather than hand-written for the reason this whole file exists: a
 * hand-written schema beside a generated type is two declarations of one fact,
 * and the copy drifts. Both emitters read the same catalog snapshot, so a
 * column that changes shape changes both or neither.
 */
const ZOD_TYPE: Readonly<Record<string, string>> = {
  uuid: "z.base64()",
  timestamptz: "z.iso.datetime()",
  boolean: "z.boolean()",
  // 'YYYY-MM-DD' over the wire -- see TS_TYPE's note. `z.iso.date()` rather
  // than a bare string: the format is not assumed, it is the one
  // src/self-health-cold-tier.ts has asserted at runtime since before this
  // generator existed, and all three date columns are day stamps.
  date: "z.iso.date()",
  double: "z.number()",
  // Same mapping as `double`, and correct for either -- JSON has one number
  // type. It cannot express the storage difference, and #11043 is where that
  // difference matters: `neuron_daily.take` and
  // `nominator_positions.share_fraction` are float32 in the catalog while
  // their Postgres source and this repo's writer are both double, so every
  // append downcasts a published figure.
  float: "z.number()",
  // INTEGER, not just a number. Every `int`/`long` in this catalog is a block
  // number, an index, a count, or epoch-milliseconds -- z.number() would
  // accept 3.7 for a block height. TS_TYPE maps both to `number` because
  // TypeScript has no integer type; Zod does, so the runtime check is allowed
  // to be stricter than the compile-time one.
  int: "z.int()",
  long: "z.int()",
  string: "z.string()",
};

/**
 * A runtime schema per table, so a lakehouse read can be CHECKED and not cast.
 *
 * `generated/lakehouse/types.ts` gives every read a compile-time row type, and
 * `r2SqlQuery<BlocksRow>(...)` is a cast: nothing verifies the engine actually
 * answered those columns with those types. A generated type nobody validates
 * fails exactly like a hand-written one -- silently, at the boundary, in
 * production.
 *
 * LOOSE ON UNKNOWN KEYS, strict on the ones named. A query selects a SUBSET
 * (`SELECT count(*)`, a hand-written projection), so `.strict()` would reject
 * most reads for being narrower than the table -- and `.partial()` is what
 * makes one generated schema usable by every projection of that table. What it
 * pins is the TYPE of any column that IS present, which is the half a cast
 * never checked.
 */
/**
 * Unit notes for columns whose NAME misstates or omits their unit (#11092) --
 * carried by the generator because the emitted Zod is do-not-edit. Keyed by
 * bare column name: the same column means the same thing in every table that
 * carries it, which is the property that makes a name-keyed map safe.
 */
const COLUMN_DESCRIPTIONS: Readonly<Record<string, string>> = {
  emission_tao:
    "ALPHA-denominated for non-root subnets, per TEMPO -- the subnet's `tempo` hyperparameter, 360 blocks (~20 tempos/day) on effectively every subnet -- despite the on-chain-inherited name (#2550/#8945). netuid 0 (root) is genuine TAO. Multiply by tempos/day before deriving a daily figure.",
};

// ASYNC, unlike its two siblings: a described column emits a call chain long
// enough that prettier splits it, and the committed file must be BOTH exactly
// what this returns (the drift gate byte-compares) and format:check-clean --
// so the formatting runs here, once, instead of being hand-mimicked.
export async function emitZodSchemas(
  columns: LakehouseColumn[],
): Promise<string> {
  const tables = [...new Set(columns.map((c) => c.table))];
  const out: string[] = [
    "// GENERATED by scripts/generate-lakehouse-types.ts from",
    `// ${SNAPSHOT_PATH}. Do not edit. Run \`npm run build:lakehouse-types\``,
    "// after re-snapshotting the catalog with `npm run refresh:lakehouse-schema`.",
    "//",
    "// One Zod schema per Iceberg table in the `chain` namespace -- the runtime",
    "// half of types.ts. A read validates against these; it does not cast to",
    "// them.",
    "",
    'import { z } from "zod";',
    "",
  ];
  for (const table of tables) {
    const cols = columns
      .filter((c) => c.table === table)
      .sort((a, b) => a.field_id - b.field_id);
    const unknown = cols.filter((c) => !ZOD_TYPE[c.type]);
    if (unknown.length > 0) {
      throw new Error(
        `unmapped Iceberg type(s) in ${table}: ` +
          unknown.map((c) => `${c.column}:${c.type}`).join(", ") +
          " -- add it to ZOD_TYPE rather than letting it fall back",
      );
    }
    out.push(
      `/**`,
      ` * \`chain.${table}\` as the catalog declares it.`,
      ` *`,
      ` * OPEN (\`.catchall\`) on purpose: a read selects a projection, and often`,
      ` * an aggregate alias that is not a column at all. Closed would delete it.`,
      ` * PARTIAL on purpose: a projection carries a subset of the columns.`,
      ` * What stays pinned is the TYPE of any declared column that IS present.`,
      ` */`,
    );
    out.push(`export const ${pascal(table)}RowSchema = z`);
    out.push("  .object({");
    for (const c of cols) {
      const inner = ZOD_TYPE[c.type];
      const described = COLUMN_DESCRIPTIONS[c.column]
        ? `${inner}.describe(${JSON.stringify(COLUMN_DESCRIPTIONS[c.column])})`
        : inner;
      out.push(
        `    ${c.column}: ${c.required ? described : `${described}.nullable()`},`,
      );
    }
    out.push("  })");
    // `.partial()` because a query selects a SUBSET of the columns.
    //
    // `.catchall(z.unknown())`, NOT `.loose()`, and the spelling is the point:
    // #10790 banned the unreasoned open object precisely because
    // `.passthrough()` said both "this is genuinely open" and "nobody thought
    // about it" in one word. `.loose()` is Zod 4's spelling of the same thing.
    // The reason here is written above the schema rather than left implied.
    //
    // Open because a read selects things that are NOT columns:
    // `COUNT(*) AS n`, `SUM(amount_tao) AS total_tao`. Zod strips unknown keys
    // by default, so a closed schema silently DELETED the aggregate from every
    // rollup that reads one -- which is most of them. Found by parsing a real
    // aggregate projection, not by reasoning about it.
    out.push("  .partial()");
    out.push("  .catchall(z.unknown());");
    out.push("");
  }
  out.push("/** Every table's row schema, by table name. */");
  out.push("export const LAKEHOUSE_ROW_SCHEMAS = {");
  for (const table of tables) {
    out.push(`  ${table}: ${pascal(table)}RowSchema,`);
  }
  out.push("} as const;");
  out.push("");
  const prettier = await import("prettier");
  return prettier.format(out.join("\n"), { parser: "typescript" });
}

export function emitRustTypes(
  columns: LakehouseColumn[],
  // A PARAMETER, not a closed-over constant. Hardcoding the production table
  // names inside the emitter made it untestable with synthetic input -- every
  // test builds columns for a table called `t` or `a`, and a hardcoded filter
  // silently emitted nothing for all of them. A default keeps the call site
  // unchanged; the seam is for the tests.
  decoderTables: readonly string[] = DECODER_TABLES,
): string {
  // THE TWO SIDES COVER DIFFERENT SETS, and this filter is what keeps that
  // honest. The snapshot spans every `chain.*` table this repo READS -- 13 of
  // them, once the cold tiers were included. The decoder WRITES four. Emitting
  // a producer struct for `self_health_daily` or `nominator_positions` would
  // assert that the decoder writes tables it has never written, and the
  // `LAKEHOUSE_TABLES` const below says "every Iceberg table this decoder
  // writes" in as many words.
  //
  // It also keeps RUST_TYPE honest: the two Iceberg types the reader side had
  // to learn (`date` on self_health_daily, `float` on nominator_positions)
  // appear only in tables the decoder does not write, so mapping them on the
  // Rust side would be inventing a producer contract for a value no producer
  // here emits. A decoder table that gains one still throws, which is the
  // check working.
  const tables = [...new Set(columns.map((c) => c.table))].filter((t) =>
    decoderTables.includes(t),
  );
  const out: string[] = [
    "// GENERATED by scripts/generate-lakehouse-types.ts from",
    `// ${SNAPSHOT_PATH}. Do not edit. Run \`npm run build:lakehouse-types\``,
    "// after re-snapshotting the catalog with `npm run refresh:lakehouse-schema`.",
    "//",
    "// One struct per Iceberg table in the `chain` namespace, for the producer",
    "// side -- the decoder that WRITES these tables, which otherwise types the",
    "// column names from memory and finds out at the append (#10315).",
    "//",
    "// Every column is Option<T>: the Iceberg schema marks none of them",
    "// required, and a producer that cannot express a missing value would have",
    "// to invent one.",
    "",
    "#![allow(dead_code)]",
    "",
  ];
  for (const table of tables) {
    const cols = columns
      .filter((c) => c.table === table)
      .sort((a, b) => a.field_id - b.field_id);
    const unknown = cols.filter((c) => !RUST_TYPE[c.type]);
    if (unknown.length > 0) {
      throw new Error(
        `unmapped Iceberg type(s) in ${table}: ` +
          unknown.map((c) => `${c.column}:${c.type}`).join(", ") +
          " -- add it to RUST_TYPE rather than letting it fall back",
      );
    }
    out.push(`/// \`chain.${table}\``);
    out.push("#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]");
    out.push(`pub struct ${pascal(table)}Row {`);
    for (const c of cols) {
      const inner = RUST_TYPE[c.type];
      out.push(
        `    pub ${c.column}: ${c.required ? inner : `Option<${inner}>`},`,
      );
    }
    out.push("}");
    out.push("");
    out.push(`/// \`chain.${table}\` columns, in field-id order.`);
    out.push(
      `pub const ${table.toUpperCase()}_COLUMNS: [&str; ${cols.length}] = [`,
      ...cols.map((c) => `    ${JSON.stringify(c.column)},`),
      "];",
      "",
    );
  }
  out.push("/// Every Iceberg table this decoder writes, by name.");
  out.push(
    `pub const LAKEHOUSE_TABLES: [&str; ${tables.length}] = [`,
    ...tables.map((t) => `    ${JSON.stringify(t)},`),
    "];",
    "",
  );
  return out.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync } = await import("node:fs");
  const snapshot = readSnapshot();
  writeFileSync(path.join(repoRoot, TYPES_PATH), emitTypes(snapshot));
  writeFileSync(path.join(repoRoot, RUST_PATH), emitRustTypes(snapshot));
  writeFileSync(path.join(repoRoot, ZOD_PATH), await emitZodSchemas(snapshot));
  process.stdout.write(`wrote ${TYPES_PATH}, ${RUST_PATH} and ${ZOD_PATH}`);
}

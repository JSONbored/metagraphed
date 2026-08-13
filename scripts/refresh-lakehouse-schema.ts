// Re-snapshot the four Iceberg tables from the live R2 Data Catalog (#10315).
//
// OUT OF BAND, exactly like scripts/snapshot-neon-schema.ts. It needs
// R2_CATALOG_TOKEN, so it cannot run from a pull request -- and that boundary
// is the point rather than a limitation: the committed snapshot is what a PR
// can be judged against, and whether the LAKEHOUSE has moved is a different
// question that only a real catalog can answer.
//
// Run:
//   R2_CATALOG_TOKEN=... node scripts/refresh-lakehouse-schema.ts
//   npm run build:lakehouse-types
//
// The REST prefix is discovered from /v1/config rather than hardcoded: the
// catalog returns it as `overrides.prefix` and it is a UUID, so a literal here
// would be a second copy of a value the server already publishes.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { repoRoot } from "./lib.ts";
import {
  SNAPSHOT_PATH,
  type LakehouseColumn,
} from "./generate-lakehouse-types.ts";

const BASE =
  process.env.R2_CATALOG_URI ??
  "https://catalog.cloudflarestorage.com/918f0f0e2eb26709d1cf4fb76085c8fb/metagraphed-lakehouse";
const WAREHOUSE =
  process.env.R2_WAREHOUSE ??
  "918f0f0e2eb26709d1cf4fb76085c8fb_metagraphed-lakehouse";

/**
 * Every `chain.*` table this repo READS, not every table the catalog holds.
 *
 * The first four are the ones the decoder appends to. The rest are the cold
 * tiers' own tables, and they were the gap: `chain` carries 26 tables, this
 * list named 4, and the other ten that `src/*-cold-tier.ts` queries had no
 * snapshot, no generated tuple and no drift coverage -- exactly the "checks
 * nothing until the append" condition #10315 was filed about, one layer out.
 *
 * READ, rather than "all 26", on purpose. A type for a table nothing queries is
 * dead code the moment it is generated -- `DatabaseTables` and `TableName` on
 * the Neon side are the standing example, generated and imported by nothing.
 * The unlisted tables (account_balances, featured_validators, neurons,
 * providers, rehearsal, subnet_ownership, subnets, surfaces,
 * validator_nominator_counts) are written by producers outside this repo and
 * never read through R2 SQL here; add one here the moment a reader does.
 *
 * `subnet_snapshots` WAS on that list and should not have been (#11008). It is
 * joined by src/neuron-daily-cold-tier.ts, and not incidentally: the join
 * prices stake and emission in TAO through
 * `nd.stake_tao * s.tao_in_pool_tao / s.alpha_in_pool`, so three of its columns
 * feed a published figure while having no snapshot, no generated tuple, no Zod
 * schema and no drift coverage. The rule above was right and simply was not
 * followed, which is why scripts/validate-lakehouse-readers.ts now checks it
 * rather than leaving it to a comment.
 */
export const TABLES = [
  // The four the decoder appends to.
  "blocks",
  "extrinsics",
  "chain_events",
  "account_events",
  // The nine the cold tiers read.
  "account_identity",
  "account_identity_history",
  "nominator_positions",
  "rpc_proxy_events",
  "self_health_daily",
  "subnet_hyperparams",
  "subnet_hyperparams_history",
  "subnet_identity_history",
  "subnet_ownership_history",
  // The two daily rollups, and the snapshot that prices them in TAO.
  "neuron_daily",
  "account_position_daily",
  "subnet_snapshots",
  // WRITTEN BUT NOT (YET) READ. This list used to be READ tables only, on the
  // rule that a type for a table nothing queries is dead code the moment it is
  // generated. That rule was right when the only consumer was a cold-tier
  // query, and it stopped being right when the lakehouse became the archive.
  //
  // Two things changed. `validate:store-type-parity` (#11060) compares Neon
  // against THIS snapshot, so a table absent here is a table whose column types
  // nothing compares -- it saw 16 tables and 186 columns while the archive held
  // 26. And the state mirror now WRITES these, so their shape is load-bearing
  // whether or not a route reads them.
  //
  // The dead-code objection does not apply either: the generator emits into
  // `LAKEHOUSE_ROW_SCHEMAS`, a registry, so every schema it produces is
  // referenced and none of this touches the unreferenced-exports ceiling.
  "account_balances",
  "neurons",
  "subnet_identity",
  "subnet_ownership",
  "subnets",
  "surfaces",
  "providers",
  "validator_nominator_counts",
];

// Guarded, so importing TABLES does not reach for the catalog. Before this the
// module fetched at IMPORT time, which meant any tool that wanted the table
// list -- scripts/validate-lakehouse-readers.ts, for one -- had to have a
// catalog token to read a constant.
async function main(): Promise<void> {
  const token = process.env.R2_CATALOG_TOKEN ?? "";
  if (!token) {
    process.stderr.write(
      "R2_CATALOG_TOKEN is required -- this reads the live catalog.\n",
    );
    process.exit(1);
  }

  const auth = { Authorization: `Bearer ${token}` };

  const config = (await (
    await fetch(
      `${BASE}/v1/config?warehouse=${encodeURIComponent(WAREHOUSE)}`,
      {
        headers: auth,
      },
    )
  ).json()) as { overrides?: { prefix?: string } };
  const prefix = config.overrides?.prefix;
  if (!prefix) {
    process.stderr.write("catalog /v1/config returned no prefix\n");
    process.exit(1);
  }

  const columns: LakehouseColumn[] = [];
  for (const table of TABLES) {
    const res = await fetch(
      `${BASE}/v1/${prefix}/namespaces/chain/tables/${table}`,
      { headers: auth },
    );
    if (!res.ok) {
      process.stderr.write(`chain.${table}: HTTP ${res.status}\n`);
      process.exit(1);
    }
    const body = (await res.json()) as {
      metadata?: {
        "current-schema-id"?: number;
        schemas?: { "schema-id"?: number; fields?: unknown[] }[];
      };
    };
    const schemas = body.metadata?.schemas ?? [];
    // The CURRENT schema, not the newest in the list: Iceberg keeps every
    // historical schema, and reading the last one would pin whichever happened
    // to be appended most recently rather than the one in force.
    const current =
      schemas.find(
        (s) => s["schema-id"] === body.metadata?.["current-schema-id"],
      ) ?? schemas[schemas.length - 1];
    for (const field of (current?.fields ?? []) as {
      id: number;
      name: string;
      type: unknown;
      required?: boolean;
    }[]) {
      columns.push({
        table,
        field_id: field.id,
        column: field.name,
        type:
          typeof field.type === "string"
            ? field.type
            : JSON.stringify(field.type),
        required: Boolean(field.required),
      });
    }
  }

  writeFileSync(
    path.join(repoRoot, SNAPSHOT_PATH),
    `${JSON.stringify(columns, null, 2)}\n`,
  );
  process.stdout.write(
    `snapshotted ${columns.length} columns across ${TABLES.length} tables\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

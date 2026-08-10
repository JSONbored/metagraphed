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

/** The tables the decoder appends to, in the order it appends them. */
const TABLES = ["blocks", "extrinsics", "chain_events", "account_events"];

const token = process.env.R2_CATALOG_TOKEN ?? "";
if (!token) {
  process.stderr.write(
    "R2_CATALOG_TOKEN is required -- this reads the live catalog.\n",
  );
  process.exit(1);
}

const auth = { Authorization: `Bearer ${token}` };

const config = (await (
  await fetch(`${BASE}/v1/config?warehouse=${encodeURIComponent(WAREHOUSE)}`, {
    headers: auth,
  })
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

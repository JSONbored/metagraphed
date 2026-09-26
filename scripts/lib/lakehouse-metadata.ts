import { d1AdminBatch, d1AdminCredentials } from "./d1-admin.ts";

export interface LakehouseMetadata {
  "current-schema-id": number;
  schemas: { "schema-id": number; fields: Record<string, unknown>[] }[];
  snapshots: { "timestamp-ms": number }[];
}

/** One bounded D1 read supplies both scheduled checks. These summaries are
 * committed atomically with the decoder's table pointer, not reconstructed
 * from object listings or a paid R2 SQL query. */
export async function loadLakehouseMetadata(): Promise<
  Map<string, LakehouseMetadata>
> {
  const credentials = d1AdminCredentials({
    ...process.env,
    CLOUDFLARE_API_TOKEN:
      process.env.CLOUDFLARE_D1_API_TOKEN ?? process.env.CLOUDFLARE_API_TOKEN,
  });
  const [result] = await d1AdminBatch(
    [
      {
        sql: "SELECT namespace,name,metadata_summary FROM iceberg_catalog_tables WHERE namespace IN ('chain','chain_testnet') ORDER BY namespace,name LIMIT 1001",
      },
    ],
    credentials,
  );
  if (!result || !result.results.length || result.results.length > 1000)
    throw new Error("Catalog metadata inventory is empty or exceeds its bound");
  const tables = new Map<string, LakehouseMetadata>();
  for (const row of result.results) {
    if (
      !["chain", "chain_testnet"].includes(String(row.namespace)) ||
      typeof row.name !== "string" ||
      !/^[a-z][a-z0-9_]{0,127}$/.test(row.name) ||
      typeof row.metadata_summary !== "string" ||
      row.metadata_summary.length > 65536
    )
      throw new Error("Catalog metadata row is invalid");
    let metadata: LakehouseMetadata;
    try {
      metadata = JSON.parse(row.metadata_summary);
    } catch {
      throw new Error("Catalog metadata summary is invalid JSON");
    }
    if (
      !metadata ||
      !Number.isSafeInteger(metadata["current-schema-id"]) ||
      !Array.isArray(metadata.schemas) ||
      metadata.schemas.length !== 1 ||
      metadata.schemas[0]?.["schema-id"] !== metadata["current-schema-id"] ||
      !Array.isArray(metadata.schemas[0]?.fields) ||
      !Array.isArray(metadata.snapshots) ||
      metadata.snapshots.length > 1 ||
      metadata.snapshots.some(
        (s) =>
          !s ||
          !Number.isSafeInteger(s["timestamp-ms"]) ||
          s["timestamp-ms"] < 0,
      )
    )
      throw new Error("Catalog schema or freshness metadata is incomplete");
    const key = `${row.namespace}.${row.name}`;
    if (tables.has(key))
      throw new Error("Catalog metadata inventory repeats a table");
    tables.set(key, metadata);
  }
  return tables;
}

export function lakehouseTable(
  tables: ReadonlyMap<string, LakehouseMetadata>,
  namespace: string,
  name: string,
): LakehouseMetadata {
  const table = tables.get(`${namespace}.${name}`);
  if (!table)
    throw new Error(`Catalog metadata is unavailable: ${namespace}.${name}`);
  return table;
}

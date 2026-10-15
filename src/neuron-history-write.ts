import { createProducerStore } from "./producer-store.ts";
import { NEURON_MIRROR_PLANS } from "./neurons-neon-write.ts";

/** Opt-in historical writes share one transaction and verify the accepted
 * projection before commit. Equal-capture enrichment fills only missing stake;
 * all other operands and identities must agree. Replay preserves write stamps.
 * An older or conflicting input is a failure, never a count-only success. */
export async function writeNeuronHistory(
  connectionString: string,
  dailyRows: Record<string, unknown>[],
  positionRows: Record<string, unknown>[],
): Promise<void> {
  const statements = [];
  for (const [name, rows] of [
    ["neuron_daily", dailyRows],
    ["account_position_daily", positionRows],
  ] as const) {
    if (!rows.length) continue;
    const { columns, conflict } = NEURON_MIRROR_PLANS[name];
    const business = columns.filter((column) => column !== "updated_at");
    const equal = (alias: string) =>
      business
        .map((column) =>
          column === "stake_tao"
            ? `(${alias}.stake_tao IS NULL OR ${name}.stake_tao IS NOT DISTINCT FROM ${alias}.stake_tao)`
            : `${name}.${column} IS NOT DISTINCT FROM ${alias}.${column}`,
        )
        .join(" AND ");
    const same = business
      .filter((column) => column !== "stake_tao")
      .map(
        (column) => `${name}.${column} IS NOT DISTINCT FROM EXCLUDED.${column}`,
      )
      .join(" AND ");
    const updates = columns
      .filter((column) => !conflict.includes(column))
      .map((column) => `${column}=EXCLUDED.${column}`)
      .join(",");
    const original = JSON.stringify(rows);
    statements.push({
      text: `INSERT INTO ${name} (${columns.join(",")})
        SELECT ${columns.join(",")} FROM jsonb_populate_recordset(NULL::${name},$1::jsonb) WHERE true
        ON CONFLICT (${conflict.join(",")}) DO UPDATE SET ${updates}
        WHERE ${name}.captured_at < EXCLUDED.captured_at OR
          (${name}.stake_tao IS NULL AND EXCLUDED.stake_tao IS NOT NULL AND ${same})`,
      values: [original],
    });
    // ON CONFLICT locks even a declined row until commit. Verify on that same
    // connection, including no-op replays, so a newer row cannot masquerade as
    // acceptance. Null input stake means unavailable; same-capture enrichment
    // may remain, while every other supplied column must match exactly.
    statements.push({
      text: `SELECT CAST(CASE WHEN NOT EXISTS (
        SELECT 1 FROM jsonb_populate_recordset(NULL::${name},$1::jsonb) incoming
        WHERE NOT EXISTS (SELECT 1 FROM ${name} WHERE ${equal("incoming")})
      ) THEN '1' ELSE 'historical projection conflict' END AS integer)`,
      values: [original],
    });
  }
  const store = createProducerStore(connectionString);
  try {
    await store.transaction(statements);
  } finally {
    await store.close();
  }
}

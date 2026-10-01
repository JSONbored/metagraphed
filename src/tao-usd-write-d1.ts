import type { ProducerStore } from "./producer-store.ts";
import type { TaoUsdIndexRow } from "./tao-usd-ingest.ts";
import { isD1ConnectionError } from "./d1-connection-error.ts";

/** Both stores persist the same pinned observation and JSON provenance. */
export function taoUsdIndexStatement(row: TaoUsdIndexRow) {
  return {
    text: `INSERT INTO tao_usd_index
      (block_number, observed_at, usd_per_tao, price_basis, eth_usd, pool_count, pools)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (block_number, observed_at) DO NOTHING`,
    values: [
      row.block_number,
      row.observed_at,
      row.usd_per_tao,
      row.price_basis,
      row.eth_usd,
      row.pool_count,
      JSON.stringify(row.pools),
    ],
  };
}

/** Read the primary key after a lost reply before replaying this observation:
 * its atomic batch may already have advanced the archive export revision. */
export async function writeTaoUsdIndexD1(
  store: Pick<ProducerStore, "run" | "first">,
  row: TaoUsdIndexRow,
): Promise<void> {
  const { text, values } = taoUsdIndexStatement(row);
  const [block_number, observed_at] = values;
  try {
    await store.run(text, values);
  } catch (error) {
    // Generic SQL includes additive writes; do not add retries to the shared
    // D1 adapter. Schema, constraint, authorization and quota failures stay
    // fatal. A persistent connection failure also remains visible.
    if (!isD1ConnectionError(error)) throw error;
    await new Promise((resolve) =>
      setTimeout(resolve, 250 + Math.floor(Math.random() * 250)),
    );
    const committed = await store.first<{
      block_number: number;
      observed_at: number;
    }>(
      "SELECT block_number,observed_at FROM tao_usd_index WHERE block_number=? AND observed_at=?",
      [block_number, observed_at],
    );
    if (
      committed?.block_number === block_number &&
      committed.observed_at === observed_at
    )
      return;
    await store.run(text, values);
  }
}

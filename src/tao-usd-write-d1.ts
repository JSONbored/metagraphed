import type { ProducerStore } from "./producer-store.ts";
import type { TaoUsdIndexRow } from "./tao-usd-ingest.ts";

/** Recover only this immutable, conflict-keyed observation. A lost D1 batch
 * reply may have committed both the row and its archive export revision. Read
 * the primary key before replaying so that case never advances the revision
 * twice. Every attempt keeps the same pinned observation and provenance. */
export async function writeTaoUsdIndexD1(
  store: Pick<ProducerStore, "run" | "first">,
  row: TaoUsdIndexRow,
): Promise<void> {
  const { block_number, observed_at } = row;
  const text = `INSERT INTO tao_usd_index
      (block_number, observed_at, usd_per_tao, price_basis, eth_usd, pool_count, pools)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (block_number, observed_at) DO NOTHING`;
  const values = [
    block_number,
    observed_at,
    row.usd_per_tao,
    row.price_basis,
    row.eth_usd,
    row.pool_count,
    JSON.stringify(row.pools),
  ];
  try {
    await store.run(text, values);
  } catch (error) {
    // Generic SQL includes additive writes; do not add retries to the shared
    // D1 adapter. Schema, constraint, authorization and quota failures stay
    // fatal. A persistent connection failure also remains visible.
    if (
      !(error instanceof Error) ||
      !/^(?:D1_ERROR: )?(?:Network connection lost\.|Replica disconnected from primary\.|D1 DB reset because its code was updated\.|Internal error (?:while starting up|in) D1 DB storage caused object to be reset\.|Cannot resolve D1 DB due to transient issue on remote node\.|internal error; reference = e_[A-Za-z0-9_-]+)$/.test(
        error.message,
      )
    )
      throw error;
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

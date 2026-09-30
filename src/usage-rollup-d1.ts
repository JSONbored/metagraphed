import { createHash, randomUUID } from "node:crypto";
import type { ProducerStore } from "./producer-store.ts";

export interface UsageRollupBucket {
  day: string;
  family: string;
  cost_shape: string;
  request_count: number;
  keyed_count: number;
}

/** Apply every bucket atomically and replay a lost reply without adding twice.
 * Receipts expire after ten minutes; SQL refuses an expired invocation even
 * after its receipt is pruned. Historical usage counters are never pruned. */
export async function writeUsageRollupD1(
  store: ProducerStore,
  buckets: readonly UsageRollupBucket[],
  deps: { batchId?: string; now?: () => number } = {},
): Promise<void> {
  if (buckets.length === 0) return;
  const batchId = deps.batchId ?? randomUUID();
  const now = deps.now ?? Date.now;
  const payload = JSON.stringify(buckets);
  const digest = createHash("sha256").update(payload).digest("hex");
  const expiresAt = now() + 600_000;
  const currentTime = "CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)";
  const statements = [
    {
      text: "DELETE FROM api_usage_rollup_batches WHERE batch_id IN (SELECT batch_id FROM api_usage_rollup_batches WHERE expires_at<? ORDER BY expires_at LIMIT 200)",
      values: [now()],
    },
    {
      text: `INSERT INTO api_usage_rollup_batches(batch_id,sha256,expires_at)
        SELECT ?,?,? WHERE ?>=${currentTime}
        ON CONFLICT(batch_id) DO NOTHING`,
      values: [batchId, digest, expiresAt, expiresAt],
    },
    {
      text: `INSERT INTO api_usage_rollup(day,route_family,cost_shape,request_count,keyed_count)
        SELECT json_extract(b.value,'$.day'),json_extract(b.value,'$.family'),
          json_extract(b.value,'$.cost_shape'),sum(json_extract(b.value,'$.request_count')),
          sum(json_extract(b.value,'$.keyed_count'))
        FROM json_each(?) b JOIN api_usage_rollup_batches r
          ON r.batch_id=? AND r.sha256=?
        WHERE r.applied=0 AND r.expires_at>=${currentTime}
        GROUP BY 1,2,3
        ON CONFLICT(day,route_family,cost_shape) DO UPDATE SET
          request_count=api_usage_rollup.request_count+excluded.request_count,
          keyed_count=api_usage_rollup.keyed_count+excluded.keyed_count`,
      values: [payload, batchId, digest],
    },
    {
      text: `UPDATE api_usage_rollup_batches SET applied=1
        WHERE batch_id=? AND sha256=? AND expires_at>=${currentTime}`,
      values: [batchId, digest],
    },
  ];
  const apply = async () => {
    await store.transaction(statements);
    const receipt = await store.first<{ sha256: string; applied: number }>(
      "SELECT sha256,applied FROM api_usage_rollup_batches WHERE batch_id=?",
      [batchId],
    );
    if (receipt?.sha256 !== digest || receipt.applied !== 1)
      throw new Error("Usage rollup batch was not acknowledged");
  };
  try {
    await apply();
  } catch (error) {
    // Only this receipt-guarded transaction may be replayed. Generic SQL
    // .all() also executes additive writes and must never retry blindly.
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
    await apply();
  }
}

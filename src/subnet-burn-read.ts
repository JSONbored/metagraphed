import { selectedD1Store } from "./d1-store.ts";
import type { UntypedRowQuerier } from "./read-store.ts";
import { SUBNET_BURN_HISTORY_TABLE } from "./subnet-burn-history.ts";

/** Ranking inputs only need the latest price for subnets in the neuron scan.
 * Seek the existing (netuid, observed_at) primary key instead of ranking every
 * retained observation. The JSON binding also supports more than 100 subnets. */
export async function readLatestSubnetBurns(
  db: UntypedRowQuerier,
  env: unknown,
  netuids: readonly number[],
): Promise<Record<string, unknown>[]> {
  const store = selectedD1Store(env, [SUBNET_BURN_HISTORY_TABLE]);
  if (!store)
    return db.query(`SELECT netuid, burn_tao FROM (
      SELECT netuid, burn_tao,
        ROW_NUMBER() OVER (PARTITION BY netuid ORDER BY observed_at DESC) AS rn
      FROM subnet_burn_history
    ) WHERE rn = 1`);
  const wanted = [...new Set(netuids)];
  if (wanted.length === 0) return [];
  return store.query(
    `SELECT h.netuid, h.burn_tao
     FROM json_each(?) wanted CROSS JOIN subnet_burn_history h
     WHERE h.netuid=wanted.value AND h.observed_at=(
       SELECT latest.observed_at FROM subnet_burn_history latest
       WHERE latest.netuid=wanted.value ORDER BY latest.observed_at DESC LIMIT 1
     ) ORDER BY h.netuid`,
    [JSON.stringify(wanted)],
  );
}

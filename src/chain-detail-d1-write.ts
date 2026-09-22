import { captureUpsertStatements } from "./capture-family-d1.ts";
import { storeChainDetailPayloads } from "./chain-detail-payloads.ts";
import {
  CHAIN_DETAIL_MIRROR_PLANS,
  type ChainDetailMirrorInput,
} from "./chain-detail-neon-write.ts";
import type { ProducerStore, ProducerStatement } from "./producer-store.ts";
import type { NeonWriteResult } from "./neon-write.ts";

/** Details and their coverage register commit together, including queue replay. */
export async function writeChainDetailD1(
  store: ProducerStore,
  env: unknown,
  input: ChainDetailMirrorInput,
): Promise<Record<string, NeonWriteResult>> {
  const byTable = {
    chain_detail_extrinsics: input.extrinsicRows,
    chain_detail_chain_events: input.chainEventRows,
    chain_detail_account_events: input.accountEventRows,
    chain_detail_blocks: input.blockRows,
  };
  const results: Record<string, NeonWriteResult> = {};
  try {
    const statements: ProducerStatement[] = [];
    for (const plan of CHAIN_DETAIL_MIRROR_PLANS) {
      const rows = byTable[plan.table as keyof typeof byTable];
      const prepared = rows.length
        ? captureUpsertStatements(
            plan,
            await storeChainDetailPayloads(env, rows),
          )
        : [];
      statements.push(...prepared);
      results[plan.table] = {
        ok: true,
        rows: rows.length,
        statements: prepared.length,
      };
    }
    if (statements.length > 900)
      throw new RangeError("Chain detail exceeds atomic statement budget");
    await store.transaction(statements);
  } catch (error) {
    for (const plan of CHAIN_DETAIL_MIRROR_PLANS)
      results[plan.table] = {
        ok: false,
        rows: 0,
        statements: 0,
        reason: String(error),
      };
  }
  return results;
}

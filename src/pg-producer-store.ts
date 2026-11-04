import type { NativeSource } from "./native-api-process.ts";
import type { NativeProducerEnv } from "./native-producer-store.ts";
import { FAMILY_MIRROR_PLANS } from "./hyperparams-identity-neon-write.ts";
import { LEDGER_MIRROR_PLANS } from "./ledger-neon-write.ts";
import { PASS_TABLES } from "./pass-completeness.ts";
import {
  chainDetailTables,
  CHAIN_DETAIL_NEON_LANE,
} from "./chain-detail-neon-write.ts";
import {
  BLOCKS_HEAD_NEON_LANE,
  RAW_CAPTURE_STATE_NEON_LANE,
} from "./capture-state-neon-write.ts";
import {
  NOMINATOR_POSITIONS_NEON_LANE,
  SELF_STAKE_NEON_LANE,
} from "./nominator-positions-neon-write.ts";
import { TAO_USD_INDEX_NEON_LANE } from "./tao-usd-index.ts";

const laneTables: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...Object.fromEntries(
    Object.entries(FAMILY_MIRROR_PLANS).map(([lane, plan]) => [
      lane,
      [plan.latest.table, plan.history.table],
    ]),
  ),
  ...Object.fromEntries(
    Object.entries(LEDGER_MIRROR_PLANS).map(([lane, plan]) => [
      lane,
      [
        plan.table,
        PASS_TABLES[lane],
        ...(lane === "hotkey-alpha" ? ["nominator_positions"] : []),
      ],
    ]),
  ),
  [CHAIN_DETAIL_NEON_LANE]: chainDetailTables(),
  [BLOCKS_HEAD_NEON_LANE]: ["blocks_head"],
  [RAW_CAPTURE_STATE_NEON_LANE]: ["raw_capture_state"],
  [NOMINATOR_POSITIONS_NEON_LANE]: [
    "nominator_positions",
    "nominator_positions_passes",
    "nominator_scan_receipts",
  ],
  [SELF_STAKE_NEON_LANE]: [
    "nominator_positions",
    "nominator_positions_passes",
    "nominator_scan_receipts",
  ],
  [TAO_USD_INDEX_NEON_LANE]: ["tao_usd_index"],
});

/** Use an already verified scoped source. The application still owns pool
 * admission and closure; these handles never open connections of their own. */
export function createPgProducerBindings(
  source: Pick<NativeSource, "relations" | "access" | "producer" | "sql">,
  requestedLanes: readonly string[],
): Required<NativeProducerEnv> {
  const lanes = [...requestedLanes];
  const tables = Object.freeze([...source.relations]);
  if (source.access !== "read-write" || tables.length === 0)
    throw new TypeError("Native producers require a writable source");
  if (lanes.length > 20 || new Set(lanes).size !== lanes.length)
    throw new RangeError("Native producer lanes must be unique and bounded");
  for (const lane of lanes) {
    if (
      !Object.hasOwn(laneTables, lane) ||
      !laneTables[lane].every((table) => tables.includes(table))
    )
      throw new Error(`Native producer source does not own lane: ${lane}`);
  }
  const store = Object.freeze({
    query: source.producer.query.bind(source.producer),
    first: source.producer.first.bind(source.producer),
    run: source.producer.run.bind(source.producer),
    transaction: source.producer.transaction.bind(source.producer),
  });
  const writer = Object.freeze({ unsafe: source.sql.unsafe.bind(source.sql) });
  return Object.freeze({
    NATIVE_PRODUCER_STORE: Object.freeze({ tables, store }),
    NATIVE_WRITE_RUNNERS: Object.freeze(
      Object.fromEntries(lanes.map((lane) => [lane, writer])),
    ),
  });
}

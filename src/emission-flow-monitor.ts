// #8750: decide whether the dormant TAO-flow emission path has stirred.
//
// v440 ships a SECOND, fully-written implementation of emission shares --
// `get_shares_flow`, which computes shares from TAO *flow* EMAs (actual capital
// moving in and out of a subnet) rather than from price EMAs. It is
// `#[allow(dead_code)]`; the live path is `get_shares_price_ema`. If it is ever
// switched on, the gate's input changes from price to demand flow and every
// published emission number moves at once -- and there is no governance pallet,
// so there is no proposal or vote to see it coming (#8697).
//
// The decision lives here as a pure function so it is testable without a chain
// or a database, matching src/emission-gate-history.ts's shape.
//
// Three things this gets right that a naive watcher would not:
//
//   * THE EMA IS THE EARLY SIGNAL, NOT THE FLAG. `SubnetEmaTaoFlow` resumes the
//     moment `get_shares_flow` is called AT ALL, whether or not
//     `NetTaoFlowEnabled` is set. Watching only the flag would miss a dry run.
//   * UNSET IS THE STEADY STATE. All four flow parameters are unset on chain.
//     "Became set" is the event; a value CHANGING between two set values is
//     also an event, but going from unset to unset is not.
//   * THE RAW ACCUMULATOR IS NOISE. `SubnetTaoFlow` is written continuously by
//     live stake/swap code (`record_tao_inflow`/`record_tao_outflow`) and
//     carries no signal about the dormant path. It is deliberately absent here.

/**
 * The four network-level parameters that provision the flow path. Provisioning
 * them is a precursor to enabling it, so each becoming set is worth an alert.
 *
 * Keys are twox128("SubtensorModule") ++ twox128(item); values are the item
 * name as recorded in the watch table.
 */
export const FLOW_PARAM_ITEMS = {
  net_tao_flow_enabled:
    "0x658faa385070e074c85bf6b568cf0555c706fdcbd8121fd89933fcd62e0c6d89",
  flow_norm_exponent:
    "0x658faa385070e074c85bf6b568cf05557e29a7803ace496e1a2226bd3c77febb",
  tao_flow_cutoff:
    "0x658faa385070e074c85bf6b568cf05557afff86a9f45066de6c2bb632bf96c0c",
  flow_ema_smoothing_factor:
    "0x658faa385070e074c85bf6b568cf0555373354fa23fca680f5b9e59cbc7a5127",
} as const;

export type FlowParamItem = keyof typeof FLOW_PARAM_ITEMS;

/**
 * The block every `SubnetEmaTaoFlow` entry is frozen at (#8750, measured live
 * 2026-07-30 across 124 of 128 subnets). Recorded as a constant so "has the EMA
 * moved" is answerable without re-deriving it from the chain every run -- the
 * whole point of the monitor is that this number should never change.
 */
export const EMA_FROZEN_BASELINE_BLOCK = 8_466_530;

/**
 * One subnet's `SubnetEmaTaoFlow` entry: `Option<(u64 block, I64F64 ema)>`.
 *
 * 24 bytes when present -- the block is the FIRST 8, little-endian, and the
 * remaining 16 are the I64F64 EMA. Returns null for absent or malformed
 * storage, which is a real reading: 4 of 128 subnets have no entry at all.
 */
export function decodeSubnetEmaTaoFlow(hex: unknown): { block: number } | null {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]{48}$/.test(hex)) {
    return null;
  }
  let block = 0n;
  // Bytes 0..7 little-endian: walk backwards so the most significant byte is
  // shifted in first, matching decodeLeU128's loop in src/network-parameters.ts.
  for (let i = 16; i >= 2; i -= 2) {
    block = (block << 8n) | BigInt(parseInt(hex.slice(i, i + 2), 16));
  }
  return { block: Number(block) };
}

export interface FlowParamObservation {
  item: FlowParamItem;
  /** Raw storage value, or null when the item is unset. */
  raw: string | null;
}

export interface FlowWatchEvent {
  item: FlowParamItem | "subnet_ema_tao_flow";
  /** Set only for EMA rows; network-level parameters carry null. */
  netuid: number | null;
  /** For parameters: is the storage item now set. For the EMA: always true. */
  is_set: boolean;
  /** For EMA rows: the block the entry is stamped at. */
  ema_block: number | null;
  observed_at: number;
  block_number: number;
  /**
   * TRUE on an item's FIRST observation. Capture began with these already in
   * whatever state they were in, so that state is not itself an event -- same
   * reasoning as emission-gate-history's own `predates_capture`.
   */
  predates_capture: boolean;
}

/**
 * Events to append for one observation of the flow parameters.
 *
 * `previous` maps an item to whether it was set at the last observation; an
 * item absent from it has never been recorded and yields a `predates_capture`
 * row rather than an alertable change.
 *
 * Ordered by FLOW_PARAM_ITEMS so the same observation always produces the same
 * rows in the same order.
 */
export function flowParamEvents(input: {
  current: readonly FlowParamObservation[];
  previous: ReadonlyMap<FlowParamItem, boolean>;
  blockNumber: number;
  observedAt: number;
}): FlowWatchEvent[] {
  const byItem = new Map(input.current.map((o) => [o.item, o]));
  const events: FlowWatchEvent[] = [];

  for (const item of Object.keys(FLOW_PARAM_ITEMS) as FlowParamItem[]) {
    const observation = byItem.get(item);
    if (!observation) continue;
    const isSet = observation.raw !== null;
    const seen = input.previous.has(item);
    const wasSet = seen ? (input.previous.get(item) as boolean) : null;

    // Unset -> unset is the steady state and by far the common case; it is
    // what "zero alerts" means and must not produce a row.
    if (seen && wasSet === isSet) continue;

    events.push({
      item,
      netuid: null,
      is_set: isSet,
      ema_block: null,
      observed_at: input.observedAt,
      block_number: input.blockNumber,
      predates_capture: !seen,
    });
  }

  return events;
}

/**
 * Events to append for subnets whose flow EMA has ADVANCED past the frozen
 * baseline.
 *
 * This is the earlier and more reliable of the two signals: the EMA starts
 * moving as soon as `get_shares_flow` runs, regardless of whether
 * `NetTaoFlowEnabled` was flipped. A subnet still stamped at (or before) the
 * baseline is dormant and produces nothing -- so a run over a healthy chain
 * emits zero rows.
 *
 * Subnets with no entry (4 of 128) decode to null and are skipped rather than
 * treated as block 0, which would otherwise read as "moved backwards".
 */
export function emaAdvancedEvents(input: {
  current: ReadonlyMap<number, { block: number } | null>;
  baselineBlock: number;
  blockNumber: number;
  observedAt: number;
}): FlowWatchEvent[] {
  const events: FlowWatchEvent[] = [];

  for (const netuid of [...input.current.keys()].sort((a, b) => a - b)) {
    const entry = input.current.get(netuid) ?? null;
    if (entry === null) continue;
    if (entry.block <= input.baselineBlock) continue;

    events.push({
      item: "subnet_ema_tao_flow",
      netuid,
      is_set: true,
      ema_block: entry.block,
      observed_at: input.observedAt,
      block_number: input.blockNumber,
      predates_capture: false,
    });
  }

  return events;
}

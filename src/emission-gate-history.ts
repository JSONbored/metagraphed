// #8748: decide what a gate-parameter observation should APPEND, if anything.
//
// Append-on-change, never overwrite-per-refresh: a row exists only where a
// value actually moved, so the table IS the change log rather than a sampling
// of one. That decision lives here as a pure function so it is testable without
// a database, the same shape scripts/apply-migrations.ts uses for
// pendingMigrations.
//
// Three things this gets right that a naive differ would not:
//
//   * NULL IS A READING, not a gap. An unset storage item means "use the
//     runtime default" -- h unset means 3, and h = 0 would make the Hill gate
//     0.5 for every subnet. So null -> 0.75 is a real change, and so is
//     0.75 -> null.
//   * THETA IS NOT GOVERNANCE. EmissionGateBar is recomputed by the runtime on
//     the 360-block cadence from live demand; q and h are set by root-origin
//     extrinsics. Recording them under one label would answer "what did
//     governance change" with twenty runtime recomputations a day.
//   * THE FIRST OBSERVATION IS NOT A CHANGE. When capture begins, a value is
//     already in place and its own change date is unrecoverable -- the
//     0.61 -> 0.75 quantile move happened before any of this existed. That row
//     is marked `predates_capture` rather than given an invented date.

/** Which parameters this tracks, and who moves them. */
export const GATE_PARAM_SOURCES = {
  emission_gate_bar: "runtime_recomputed",
  emission_bar_quantile: "governance",
  emission_gate_exponent: "governance",
  block_emission_halvings: "runtime_recomputed",
} as const;

export type GateParam = keyof typeof GATE_PARAM_SOURCES;
export type GateParamSource = (typeof GATE_PARAM_SOURCES)[GateParam];

/** One parameter's value at a block. `null` means the storage item is unset. */
export type GateParamReading = Partial<Record<GateParam, number | null>>;

export interface GateParamChange {
  param: GateParam;
  value: number | null;
  previous_value: number | null;
  source: GateParamSource;
  block_number: number;
  observed_at: number;
  predates_capture: boolean;
}

/**
 * Rows to append for one observation, given the last known values.
 *
 * `previous` is what the table already holds — absent from it means the
 * parameter has never been recorded, which produces a `predates_capture` row
 * rather than a change.
 *
 * Ordered by GATE_PARAM_SOURCES rather than by object key order, so the same
 * observation always produces the same rows in the same order.
 */
export function gateParamChanges(input: {
  current: GateParamReading;
  previous: GateParamReading;
  blockNumber: number;
  observedAt: number;
}): GateParamChange[] {
  const changes: GateParamChange[] = [];

  for (const param of Object.keys(GATE_PARAM_SOURCES) as GateParam[]) {
    if (!(param in input.current)) continue;
    const value = input.current[param] ?? null;
    const seen = param in input.previous;
    const previous = seen ? (input.previous[param] ?? null) : null;

    // Not a change — the common case, and the reason the table stays small
    // even though theta is sampled every few minutes.
    if (seen && previous === value) continue;

    changes.push({
      param,
      value,
      previous_value: seen ? previous : null,
      source: GATE_PARAM_SOURCES[param],
      block_number: input.blockNumber,
      observed_at: input.observedAt,
      predates_capture: !seen,
    });
  }

  return changes;
}

export interface SubnetEnabledChange {
  netuid: number;
  enabled: boolean;
  previous_enabled: boolean | null;
  block_number: number;
  observed_at: number;
  predates_capture: boolean;
}

/**
 * Rows to append for the per-subnet enablement flags.
 *
 * `SubnetEmissionEnabled` DEFAULTS TO TRUE on chain: absent storage is enabled,
 * `0x00` is disabled. Callers must therefore pass the DECODED boolean, never
 * key presence — this function cannot tell the difference, and a caller that
 * conflates them inverts the meaning for every subnet that has never been
 * explicitly set.
 *
 * Sorted by netuid so a run's rows land in a stable order regardless of how the
 * caller enumerated the map.
 */
export function subnetEnabledChanges(input: {
  current: ReadonlyMap<number, boolean>;
  previous: ReadonlyMap<number, boolean>;
  blockNumber: number;
  observedAt: number;
}): SubnetEnabledChange[] {
  const changes: SubnetEnabledChange[] = [];

  for (const netuid of [...input.current.keys()].sort((a, b) => a - b)) {
    const enabled = input.current.get(netuid) as boolean;
    const seen = input.previous.has(netuid);
    const previous = seen ? (input.previous.get(netuid) as boolean) : null;
    if (seen && previous === enabled) continue;

    changes.push({
      netuid,
      enabled,
      previous_enabled: previous,
      block_number: input.blockNumber,
      observed_at: input.observedAt,
      predates_capture: !seen,
    });
  }

  return changes;
}

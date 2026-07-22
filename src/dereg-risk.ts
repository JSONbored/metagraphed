// Pure computation of the two #6746/#6748 alert-condition metrics -- the
// protocol-health signals SubnetAIQ's deregistration-risk monitor pioneers
// (EMA-price-rank-vs-cutoff + immunity-period countdown), stripped of its
// trading "AVOID/CAUTION" framing and buildable entirely from data
// metagraphed already captures. No I/O: callers own fetching the underlying
// rows (the economics tier, formatNeuron's own immunity_expires_at_block
// output, src/metagraph-neurons.mjs) and the current block number --
// matches this codebase's other pure-shaping/no-I/O module convention
// (src/concentration.ts, src/alpha-volume.mjs).
//
// buildDeregRiskSnapshot's return shape is exactly what
// src/alert-triggers.mjs's readConditionMetric reads from -- see that
// module's ALERT_CONDITION_METRICS for the two metric names this backs.

// Ranks subnets by alpha_price_tao descending (1 = highest price) -- the
// "EMA-price-rank" SubnetAIQ's monitor computes, simplified to the raw
// (non-EMA) rank: metagraphed doesn't capture a price time series cheaply
// enough for a real moving average yet, and an honestly-labeled raw rank is
// preferable to fabricating a smoothed figure. A row with a missing/
// non-finite alpha_price_tao is excluded entirely (never assigned a rank),
// so a condition referencing it degrades to "no snapshot entry" (never
// matches) rather than a fabricated rank of 0 or similar.
export function subnetAlphaPriceRank(
  economicsRows: Array<Record<string, unknown>> | null | undefined,
): Map<number, number> {
  const ranked = (economicsRows || [])
    .filter(
      (row): row is { netuid: number; alpha_price_tao: number } =>
        Number.isInteger(row?.netuid) &&
        // typeof-guarded before Number(): Number(null) === 0 (finite), which
        // would otherwise rank a genuinely-absent price as a real zero price.
        typeof row?.alpha_price_tao === "number" &&
        Number.isFinite(row.alpha_price_tao as number),
    )
    .map((row) => ({ netuid: row.netuid, price: row.alpha_price_tao }))
    .sort((a, b) => b.price - a.price);
  const rankByNetuid = new Map<number, number>();
  ranked.forEach((entry, index) => {
    rankByNetuid.set(entry.netuid, index + 1);
  });
  return rankByNetuid;
}

// Blocks remaining until each currently-immune neuron's immunity period
// expires, keyed by "netuid:hotkey" (the same key alert-triggers.mjs's
// readConditionMetric looks up). `rows` is a flat list drawn from any
// combination of subnets' already-formatted neuron rows (formatNeuron's own
// output, src/metagraph-neurons.mjs -- immunity_expires_at_block is only
// present there when a subnet's live immunity_period hyperparameter was
// passed in, and only non-null while is_immunity_period is true). A row
// with no immunity_expires_at_block, or whose countdown has already reached
// zero/gone negative (expired since the row's own snapshot was captured),
// contributes no entry -- never a zero/negative countdown that a `lte`
// condition could wrongly treat as "still counting down".
export function neuronImmunityCountdownBlocks(
  rows: Array<Record<string, unknown>> | null | undefined,
  currentBlock: number | undefined,
): Map<string, number> {
  const countdownByKey = new Map<string, number>();
  if (!Number.isFinite(currentBlock)) return countdownByKey;
  for (const row of rows || []) {
    if (
      !Number.isInteger(row?.netuid) ||
      !row?.hotkey ||
      !Number.isInteger(row?.immunity_expires_at_block)
    ) {
      continue;
    }
    // Number.isFinite(currentBlock) already returned above if it weren't a
    // finite number, so this is safe past that guard.
    const countdown =
      (row.immunity_expires_at_block as number) - (currentBlock as number);
    if (countdown <= 0) continue;
    countdownByKey.set(`${row.netuid}:${row.hotkey}`, countdown);
  }
  return countdownByKey;
}

export interface DeregRiskSnapshot {
  subnetAlphaPriceRank: Map<number, number>;
  neuronImmunityCountdownBlocks: Map<string, number>;
}

// Convenience wrapper composing both metrics into the exact snapshot shape
// triggerMatchesEvent's metricSnapshot parameter expects.
export function buildDeregRiskSnapshot({
  economicsRows,
  neuronRows,
  currentBlock,
}: {
  economicsRows?: Array<Record<string, unknown>> | null;
  neuronRows?: Array<Record<string, unknown>> | null;
  currentBlock?: number;
} = {}): DeregRiskSnapshot {
  return {
    subnetAlphaPriceRank: subnetAlphaPriceRank(economicsRows),
    neuronImmunityCountdownBlocks: neuronImmunityCountdownBlocks(
      neuronRows,
      currentBlock,
    ),
  };
}

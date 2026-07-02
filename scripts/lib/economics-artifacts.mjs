// Economics artifact derivation, extracted verbatim from scripts/lib.mjs (#510
// maintainability decomposition). Pure + side-effect free: every function takes
// plain objects and returns plain objects, with no module state and no I/O, so
// the output is byte-identical to the in-lib.mjs originals. Re-exported from
// scripts/lib.mjs so existing importers keep their import paths unchanged.

// #1009: per-subnet validator + economic entity, derived from the chain
// snapshot's `economics` block (validator/miner counts, stake, registration
// cost, alpha price). dTAO emission is price-weighted, so each subnet's
// emission_share is its alpha price as a fraction of the network total across
// every subnet that reports one — computed here rather than read from the
// now-zeroed on-chain subnet_emission field. Pure + side-effect free so it is
// fully unit-testable; subnets with no economics block are omitted (graceful
// when the snapshot predates the economics fetcher).
// Miner-readiness heuristic (#1306): 0-100 "how easy is it for a new miner to
// join + earn on this subnet". Weighs registration being open, free UID slots
// (vs. having to outcompete an existing miner), the registration cost, and
// whether the subnet is actually active. A display/ranking signal for miner
// discovery — never a guarantee, never feeds completeness.
export function computeMinerReadiness(economics, openSlots, emissionShare) {
  if (!economics || typeof economics !== "object") return null;
  let score = 0;
  if (economics.registration_allowed) score += 40; // can register at all
  if (typeof openSlots === "number" && openSlots > 0) score += 30; // room
  const cost = economics.registration_cost_tao;
  if (Number.isFinite(cost)) {
    if (cost <= 1) score += 20;
    else if (cost <= 10) score += 10;
    else if (cost <= 100) score += 5;
  } else {
    // unknown cost (missing, or a NaN/Infinity that slipped through a typeof
    // check) — don't over-penalize.
    score += 10;
  }
  const active =
    (typeof emissionShare === "number" && emissionShare > 0) ||
    (typeof economics.total_stake_tao === "number" &&
      economics.total_stake_tao > 0);
  if (active) score += 10; // worth mining
  return Math.max(0, Math.min(100, score));
}

export function computeAlphaMarketCapTao(alphaPriceTao, totalStakeTao) {
  if (!Number.isFinite(alphaPriceTao) || !Number.isFinite(totalStakeTao)) {
    return null;
  }
  // total_stake_tao is the on-chain circulating-alpha proxy for this display
  // metric until a dedicated circulating-alpha supply field is available.
  return alphaPriceTao * totalStakeTao;
}

export function buildEconomicsArtifact({
  subnets,
  economicsByNetuid,
  generatedAt,
  network = null,
  capturedAt = null,
}) {
  const numericOrZero = (value) => (typeof value === "number" ? value : 0);
  const round = (value, places) => {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
  };
  const withEconomics = subnets
    .map((subnet) => ({
      subnet,
      economics: economicsByNetuid.get(subnet.netuid) || null,
    }))
    .filter((entry) => entry.economics);
  const totalAlphaPrice = withEconomics.reduce(
    (sum, { economics }) => sum + numericOrZero(economics.alpha_price_tao),
    0,
  );
  const rows = withEconomics.map(({ subnet, economics }) => {
    const price =
      typeof economics.alpha_price_tao === "number"
        ? economics.alpha_price_tao
        : null;
    const emissionShare =
      price != null && totalAlphaPrice > 0
        ? round(price / totalAlphaPrice, 6)
        : null;
    const participants =
      numericOrZero(economics.validator_count) +
      numericOrZero(economics.miner_count);
    const maxUids = numericOrZero(economics.max_uids);
    const openSlots = maxUids > 0 ? Math.max(0, maxUids - participants) : null;
    const alphaMarketCapTao = computeAlphaMarketCapTao(
      price,
      economics.total_stake_tao,
    );
    return {
      netuid: subnet.netuid,
      slug: subnet.slug,
      name: subnet.name,
      block: subnet.block ?? null,
      ...economics,
      alpha_market_cap_tao: alphaMarketCapTao,
      emission_share: emissionShare,
      open_slots: openSlots,
      miner_readiness: computeMinerReadiness(
        economics,
        openSlots,
        emissionShare,
      ),
    };
  });
  // Highest emission share first (the "top subnets by emission" view); stable
  // tiebreak on netuid so the order is deterministic.
  rows.sort(
    (a, b) =>
      (b.emission_share ?? -1) - (a.emission_share ?? -1) ||
      a.netuid - b.netuid,
  );
  const sumField = (field) =>
    rows.reduce((sum, row) => sum + numericOrZero(row[field]), 0);
  return {
    schema_version: 1,
    generated_at: generatedAt,
    network,
    captured_at: capturedAt,
    summary: {
      subnet_count: subnets.length,
      with_economics_count: rows.length,
      total_stake_tao: round(sumField("total_stake_tao"), 9),
      total_validators: sumField("validator_count"),
      total_miners: sumField("miner_count"),
      registration_open_count: rows.filter((row) => row.registration_allowed)
        .length,
    },
    subnets: rows,
  };
}

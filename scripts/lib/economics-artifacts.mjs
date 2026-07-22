// Economics artifact derivation, extracted verbatim from scripts/lib.mjs (#510
// maintainability decomposition). Pure + side-effect free: every function takes
// plain objects and returns plain objects, with no module state and no I/O, so
// the output is byte-identical to the in-lib.mjs originals. Re-exported from
// scripts/lib.mjs so existing importers keep their import paths unchanged.

import { withAlphaPriceChanges } from "../../src/alpha-price-change.ts";

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

// Fixed per-subnet alpha max supply on Bittensor — the denominator for FDV.
export const ALPHA_MAX_SUPPLY = 21_000_000;

export function computeAlphaMarketCapTao(alphaPriceTao, totalStakeTao) {
  if (!Number.isFinite(alphaPriceTao) || !Number.isFinite(totalStakeTao)) {
    return null;
  }
  // total_stake_tao is the on-chain circulating-alpha proxy for this display
  // metric until a dedicated circulating-alpha supply field is available.
  return alphaPriceTao * totalStakeTao;
}

export function computeAlphaFdvTao(alphaPriceTao) {
  if (alphaPriceTao == null || !Number.isFinite(alphaPriceTao)) {
    return null;
  }
  return alphaPriceTao * ALPHA_MAX_SUPPLY;
}

const RAO_PER_TAO = 1_000_000_000n;

// Sum a per-subnet TAO field in exact rao-integer BigInt space, not float
// space (#2924): summing ~130 subnets' already-large total_stake_tao values
// with plain `+=` compounds float error, and the network-wide total is
// already well past 2^53-1's exact-double ceiling (~9,007,199 TAO at rao
// precision) -- confirmed live 2026-07-14 at ~328M TAO, 36x over. Formats as
// a fixed 9-decimal (rao-precision) string, never a JS number, so neither
// the summation nor the JSON serialization loses precision. Mirrors the
// toRaoBig/raoBigToTao pattern used for per-entity sums elsewhere (e.g.
// src/chain-yield.ts), extended to a string output since -- unlike those
// per-entity totals -- this sum's magnitude is the whole reason this exists.
// No negative-sign handling: total_stake_tao is a non-negative on-chain
// quantity (matches the schema's own `minimum: 0`), so a negative sum is
// unreachable -- unlike a real negative-capable delta, branching on a sign
// that can never occur here would just be untestable dead code.
function taoNumberToRao(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? BigInt(Math.round(value * 1e9))
    : 0n;
}

function raoToTaoString(rao) {
  const whole = rao / RAO_PER_TAO;
  const frac = rao % RAO_PER_TAO;
  return `${whole}.${frac.toString().padStart(9, "0")}`;
}

function sumFieldTaoString(rows, field) {
  let sumRao = 0n;
  for (const row of rows) {
    sumRao += taoNumberToRao(row[field]);
  }
  return raoToTaoString(sumRao);
}

// #6641: Backprop's "Total Network Value" split -- root (netuid 0) stake is
// TAO-denominated with no AMM/price exposure, exactly like
// buildGlobalValidatorEntry's root_stake_tao/alpha_stake_tao split in
// src/metagraph-neurons.ts and the root-has-no-AMM carve-out stake-quote.mjs
// documents -- just applied to the network-wide rollup instead of a
// per-entity one. Root's own alpha_market_cap_tao (its ~1.0 moving_price
// times its TAO stake) is deliberately excluded from the alpha rollup so its
// stake isn't counted as both "root value" and "alpha value"; total_network
// is the rao-exact sum of the two, not a re-parsed string addition.
export function computeNetworkValueSummary(rows) {
  let rootRao = 0n;
  let alphaRao = 0n;
  for (const row of rows) {
    if (row.netuid === 0) {
      rootRao += taoNumberToRao(row.total_stake_tao);
    } else {
      alphaRao += taoNumberToRao(row.alpha_market_cap_tao);
    }
  }
  return {
    total_root_value_tao: raoToTaoString(rootRao),
    total_alpha_value_tao: raoToTaoString(alphaRao),
    total_network_value_tao: raoToTaoString(rootRao + alphaRao),
  };
}

export function buildEconomicsArtifact({
  subnets,
  economicsByNetuid,
  generatedAt,
  network = null,
  capturedAt = null,
  /** Optional Map<netuid, snapshot rows> for #7227 alpha_price_change_* fields. */
  priceHistoryByNetuid = null,
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
    const alphaFdvTao = computeAlphaFdvTao(price);
    const history =
      priceHistoryByNetuid instanceof Map
        ? priceHistoryByNetuid.get(subnet.netuid)
        : null;
    // #7227: always attach the four change keys (null when history is missing
    // or too short) so the listing shape stays schema-stable.
    const withChanges = withAlphaPriceChanges(
      {
        ...economics,
        alpha_market_cap_tao: alphaMarketCapTao,
        alpha_fdv_tao: alphaFdvTao,
        emission_share: emissionShare,
        open_slots: openSlots,
        miner_readiness: computeMinerReadiness(
          economics,
          openSlots,
          emissionShare,
        ),
      },
      history,
    );
    return {
      netuid: subnet.netuid,
      slug: subnet.slug,
      name: subnet.name,
      block: subnet.block ?? null,
      ...withChanges,
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
      total_stake_tao: sumFieldTaoString(rows, "total_stake_tao"),
      total_validators: sumField("validator_count"),
      total_miners: sumField("miner_count"),
      registration_open_count: rows.filter((row) => row.registration_allowed)
        .length,
      ...computeNetworkValueSummary(rows),
    },
    subnets: rows,
  };
}

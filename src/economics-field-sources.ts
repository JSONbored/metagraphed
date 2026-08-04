// Where every value on an /api/v1/economics row came from (#9106).
//
// This is the response that made `read_at` necessary. Its fields have THREE
// origins, and until now nothing in the body distinguished them:
//
//   1. the bulk `SubnetInfoRuntimeApi.get_all_metagraphs_info` call, at its own
//      height -- published on the row as `block`;
//   2. `state_queryStorageAt` reads pinned to `chain_state.block`;
//   3. our arithmetic, some of it at build time.
//
// `alpha_price_tao` and `moving_price_pinned` are THE SAME CHAIN ITEM read at
// (1) and (2) respectively. schemas-src/shared.ts already says so in prose --
// "Same chain items, different instant" -- and the two exist separately
// precisely because they disagree. A two-key map would label both `measured` /
// `SubtensorModule.SubnetMovingPrice` and thereby assert they are
// interchangeable. `registration_allowed` / `registration_allowed_pinned` is
// the same pair.
//
// ── The storage item names are recovered, not transcribed ───────────────────
//
// scripts/fetch-native-subnets.py keys PIPELINE_STORAGE_ITEMS by FRIENDLY name
// against hardcoded twox128 digests, so the real pallet item names appear
// nowhere in this repo. Each name below was recovered by hashing candidates
// against those committed digests until one matched. That is worth knowing
// because `first_emission_block` is `FirstEmissionBlockNumber`, not the
// `FirstEmissionBlock` anyone would write by hand.
// ── TWO TIERS, TWO PROVENANCES (#9220) ──────────────────────────────────────
//
// Everything above describes the R2 artifact, and stopped being true of the
// response as soon as #9197 moved the live refresh onto a Worker cron.
// resolveLiveEconomics prefers KV whenever it passes its gates, so the map
// below is normally NOT the one describing the row a caller is holding.
//
// The two writers now read the same values in genuinely different ways:
//
//   R2 (scripts/fetch-native-subnets.py -> build-artifacts.ts)
//     one bulk `get_all_metagraphs_info` at its own height, plus pinned
//     storage reads at chain_state.block. TWO instants, both published.
//
//   live-kv (src/live-economics-refresh.ts)
//     no bulk call exists. A Worker has no bittensor SDK, so every field is
//     one `state_queryStorageAt` against a NAMED SubtensorModule map pinned to
//     a single block, and the four per-UID aggregates come from the D1
//     `neurons` table the poller keeps on a 15-minute tick.
//
// So on the live tier `alpha_price_tao` and `moving_price_pinned` are the same
// word at the SAME instant -- the pair that exists precisely because the two
// instants differ collapses to one. Publishing the map below against that row
// would assert a bulk call that never happened and a capture instant that does
// not exist. Hence a map per tier, selected by `economicsFieldSources` from the
// `source` loadNetworkEconomics already tracks, rather than one static map that
// is true of whichever tier happens not to be serving.
import type { FieldSource, FieldSources } from "./field-provenance.ts";

/** The bulk runtime call every capture-instant field is read from. */
const BULK = "SubnetInfoRuntimeApi.get_all_metagraphs_info";

export const ECONOMICS_FIELD_SOURCES = {
  // --- Read off the bulk call, at its own height -----------------------------
  block: { kind: "measured", storage: BULK, read_at: "capture" },
  name: { kind: "measured", storage: BULK, read_at: "capture" },
  max_uids: { kind: "measured", storage: BULK, read_at: "capture" },
  max_validators: { kind: "measured", storage: BULK, read_at: "capture" },
  registration_allowed: { kind: "measured", storage: BULK, read_at: "capture" },
  registration_cost_tao: {
    kind: "measured",
    storage: BULK,
    read_at: "capture",
  },
  // The published alpha price, whose meaning ADR 0023 decision 1 fixes as-is.
  // Same chain item as moving_price_pinned below, a different instant.
  alpha_price_tao: { kind: "measured", storage: BULK, read_at: "capture" },
  tao_in_pool_tao: { kind: "measured", storage: BULK, read_at: "capture" },
  alpha_in_pool: { kind: "measured", storage: BULK, read_at: "capture" },
  alpha_out_pool: { kind: "measured", storage: BULK, read_at: "capture" },
  subnet_volume_tao: { kind: "measured", storage: BULK, read_at: "capture" },
  owner_hotkey: { kind: "measured", storage: BULK, read_at: "capture" },
  owner_coldkey: { kind: "measured", storage: BULK, read_at: "capture" },

  // --- Pinned storage reads at chain_state.block -----------------------------
  miner_burned_fraction: {
    kind: "measured",
    storage: "SubtensorModule.MinerBurned",
    read_at: "chain_state.block",
  },
  emission_enabled: {
    kind: "measured",
    storage: "SubtensorModule.SubnetEmissionEnabled",
    read_at: "chain_state.block",
  },
  subtoken_enabled: {
    kind: "measured",
    storage: "SubtensorModule.SubtokenEnabled",
    read_at: "chain_state.block",
  },
  first_emission_block: {
    kind: "measured",
    storage: "SubtensorModule.FirstEmissionBlockNumber",
    read_at: "chain_state.block",
  },
  tao_in_emission_tao: {
    kind: "measured",
    storage: "SubtensorModule.SubnetTaoInEmission",
    read_at: "chain_state.block",
  },
  excess_tao: {
    kind: "measured",
    storage: "SubtensorModule.SubnetExcessTao",
    read_at: "chain_state.block",
  },
  alpha_in_emission: {
    kind: "measured",
    storage: "SubtensorModule.SubnetAlphaInEmission",
    read_at: "chain_state.block",
  },
  alpha_out_emission: {
    kind: "measured",
    storage: "SubtensorModule.SubnetAlphaOutEmission",
    read_at: "chain_state.block",
  },
  // The SAME item as alpha_price_tao, pinned. This pair is why read_at exists.
  moving_price_pinned: {
    kind: "measured",
    storage: "SubtensorModule.SubnetMovingPrice",
    read_at: "chain_state.block",
  },
  registration_allowed_pinned: {
    kind: "measured",
    storage: "SubtensorModule.NetworkRegistrationAllowed",
    read_at: "chain_state.block",
  },

  // --- Our arithmetic over capture-instant inputs ----------------------------
  // Aggregated from the bulk call's per-UID arrays, so they carry the capture
  // instant even though no single read produced them.
  validator_count: { kind: "reconstructed", storage: null, read_at: "capture" },
  miner_count: { kind: "reconstructed", storage: null, read_at: "capture" },
  total_stake_alpha: {
    kind: "reconstructed",
    storage: null,
    read_at: "capture",
  },
  max_stake_alpha: { kind: "reconstructed", storage: null, read_at: "capture" },
  // price / Σ price across subnets, at build time. THE STAGE-1 PRICE SHARE, not
  // the share of TAO a subnet receives -- /api/v1/chain/emission-pipeline
  // decomposes the difference.
  emission_share: { kind: "reconstructed", storage: null, read_at: "capture" },
  alpha_market_cap_tao: {
    kind: "reconstructed",
    storage: null,
    read_at: "capture",
  },
  alpha_fdv_tao: { kind: "reconstructed", storage: null, read_at: "capture" },
  open_slots: { kind: "reconstructed", storage: null, read_at: "capture" },
  miner_readiness: { kind: "reconstructed", storage: null, read_at: "capture" },

  // --- Ours, spanning instants or no chain read at all -----------------------
  // read_at omitted deliberately: each change combines the capture-instant
  // price with a DAILY price-history rollup, so no single instant is true of
  // them. Absent means "no single instant applies", not "unknown".
  // #9408. Arithmetic over two MEASURED reserves on this same row, so it is
  // reconstructed rather than measured -- no storage item holds it. It shares the
  // reserves' own instant, which is why no separate `read_at` is asserted: whichever
  // instant tao_in_pool_tao and alpha_in_pool were read at is the instant this is
  // true of, by construction.
  spot_price_tao: { kind: "reconstructed", storage: null },
  alpha_price_change_1h: { kind: "reconstructed", storage: null },
  alpha_price_change_1d: { kind: "reconstructed", storage: null },
  alpha_price_change_7d: { kind: "reconstructed", storage: null },
  alpha_price_change_1m: { kind: "reconstructed", storage: null },
  // A registry identifier we mint. Never read from chain, so no instant.
  slug: { kind: "reconstructed", storage: null },
} as const satisfies FieldSources;

/** Pinned to the one block the whole live sweep reads at. */
const pinned = (storage: string): FieldSource => ({
  kind: "measured",
  storage,
  read_at: "chain_state.block",
});

/**
 * Provenance for a row served from the live KV tier (#9197's Worker cron).
 *
 * Same key set as the R2 map above -- tests/field-provenance.test.ts derives
 * the field list from the published route schema and checks BOTH maps against
 * it, so the two can never drift apart in coverage, only in what they claim.
 *
 * The storage item names are the ones ECONOMICS_STORAGE_MAPS reads, not the
 * recovered-by-hashing names in the R2 comment above: this lane's digests are
 * held against tests/fixtures/emission-pipeline.json's own `item_hashes`, so
 * the mapping from field to pallet item is checked rather than asserted.
 */
export const ECONOMICS_FIELD_SOURCES_LIVE_KV = {
  // --- one pinned storage read each ------------------------------------------
  max_uids: pinned("SubtensorModule.MaxAllowedUids"),
  max_validators: pinned("SubtensorModule.MaxAllowedValidators"),
  registration_allowed: pinned("SubtensorModule.NetworkRegistrationAllowed"),
  registration_cost_tao: pinned("SubtensorModule.Burn"),
  // THE SAME WORD as moving_price_pinned below, at the same instant -- the two
  // differ only in fixed-point scale on this tier. They stay separate fields
  // because the published shape is shared with the R2 tier, where they really
  // are two instants.
  alpha_price_tao: pinned("SubtensorModule.SubnetMovingPrice"),
  tao_in_pool_tao: pinned("SubtensorModule.SubnetTAO"),
  alpha_in_pool: pinned("SubtensorModule.SubnetAlphaIn"),
  alpha_out_pool: pinned("SubtensorModule.SubnetAlphaOut"),
  subnet_volume_tao: pinned("SubtensorModule.SubnetVolume"),
  owner_hotkey: pinned("SubtensorModule.SubnetOwnerHotkey"),
  owner_coldkey: pinned("SubtensorModule.SubnetOwner"),
  miner_burned_fraction: pinned("SubtensorModule.MinerBurned"),
  emission_enabled: pinned("SubtensorModule.SubnetEmissionEnabled"),
  subtoken_enabled: pinned("SubtensorModule.SubtokenEnabled"),
  first_emission_block: pinned("SubtensorModule.FirstEmissionBlockNumber"),
  tao_in_emission_tao: pinned("SubtensorModule.SubnetTaoInEmission"),
  excess_tao: pinned("SubtensorModule.SubnetExcessTao"),
  alpha_in_emission: pinned("SubtensorModule.SubnetAlphaInEmission"),
  alpha_out_emission: pinned("SubtensorModule.SubnetAlphaOutEmission"),
  moving_price_pinned: pinned("SubtensorModule.SubnetMovingPrice"),
  registration_allowed_pinned: pinned(
    "SubtensorModule.NetworkRegistrationAllowed",
  ),

  // --- the pinned head itself ------------------------------------------------
  // Not a storage item but still one chain read: the `chain_getHeader` this
  // sweep pinned every read above to (src/subtensor-pinned-storage.ts), named
  // in the RPC's own namespace.method form the pattern already admits
  // alongside a runtime API. It equals chain_state.block on this tier by
  // construction, which is what makes "capture" and "chain_state.block" the
  // same instant here.
  block: {
    kind: "measured",
    storage: "Chain.getHeader",
    read_at: "chain_state.block",
  },

  // --- carried from the published registry index, not read here --------------
  // This lane builds its subnet list from /metagraph/subnets.json, so identity
  // is whatever the last publish minted. No chain read at this sweep's instant,
  // so no instant -- the same treatment `slug` has always had.
  name: { kind: "reconstructed", storage: null },
  slug: { kind: "reconstructed", storage: null },

  // --- D1 `neurons`, a THIRD instant we do not publish -----------------------
  // The poller Container refreshes that table on its own 15-minute tick, so
  // these four were read at neither `capture` nor `chain_state.block`.
  // `read_at` is therefore ABSENT, which the vocabulary defines as "no single
  // published instant applies" -- the honest answer, where naming either
  // instant would be a false one.
  validator_count: { kind: "reconstructed", storage: null },
  miner_count: { kind: "reconstructed", storage: null },
  total_stake_alpha: { kind: "reconstructed", storage: null },
  max_stake_alpha: { kind: "reconstructed", storage: null },

  // --- our arithmetic over the pinned reads ---------------------------------
  // price / Σ price, every input pinned to the same block.
  emission_share: {
    kind: "reconstructed",
    storage: null,
    read_at: "chain_state.block",
  },
  alpha_fdv_tao: {
    kind: "reconstructed",
    storage: null,
    read_at: "chain_state.block",
  },

  // --- arithmetic that SPANS the pinned block and the D1 tick ----------------
  // Each of these combines a pinned read with a `neurons` aggregate, so no
  // single instant is true of them either.
  alpha_market_cap_tao: { kind: "reconstructed", storage: null },
  open_slots: { kind: "reconstructed", storage: null },
  miner_readiness: { kind: "reconstructed", storage: null },

  // --- price history rollup, unchanged from the R2 tier ----------------------
  // #9408. Arithmetic over two MEASURED reserves on this same row, so it is
  // reconstructed rather than measured -- no storage item holds it. It shares the
  // reserves' own instant, which is why no separate `read_at` is asserted: whichever
  // instant tao_in_pool_tao and alpha_in_pool were read at is the instant this is
  // true of, by construction.
  spot_price_tao: { kind: "reconstructed", storage: null },
  alpha_price_change_1h: { kind: "reconstructed", storage: null },
  alpha_price_change_1d: { kind: "reconstructed", storage: null },
  alpha_price_change_7d: { kind: "reconstructed", storage: null },
  alpha_price_change_1m: { kind: "reconstructed", storage: null },
} as const satisfies FieldSources;

/**
 * The provenance map describing the tier a row was actually served from.
 *
 * `source` is what loadNetworkEconomics already reports (`live-kv` when
 * resolveLiveEconomics accepted the KV blob, `r2-fallback` otherwise). Anything
 * else -- including undefined -- resolves to the R2 map, because that is the
 * tier the committed artifact always describes and a wrong-but-conservative
 * answer beats claiming a live read that may not have happened.
 */
export function economicsFieldSources(
  source: string | null | undefined,
): FieldSources {
  return source === "live-kv"
    ? ECONOMICS_FIELD_SOURCES_LIVE_KV
    : ECONOMICS_FIELD_SOURCES;
}

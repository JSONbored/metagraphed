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
import type { FieldSources } from "./field-provenance.ts";

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
  alpha_price_change_1h: { kind: "reconstructed", storage: null },
  alpha_price_change_1d: { kind: "reconstructed", storage: null },
  alpha_price_change_7d: { kind: "reconstructed", storage: null },
  alpha_price_change_1m: { kind: "reconstructed", storage: null },
  // A registry identifier we mint. Never read from chain, so no instant.
  slug: { kind: "reconstructed", storage: null },
} as const satisfies FieldSources;

/** Public provenance for the existing economics artifact/snapshot fields. */
export const LEGACY_EMISSION_SHARE_DESCRIPTION =
  "Artifact-normalized moving-price share: alpha_price_tao divided by the sum " +
  "of reported alpha prices, including Root when Root reports a price. " +
  "Legacy snapshot rows do not retain the historical runtime eligibility " +
  "inputs needed to certify v440 Stage 1. This is neither a verified runtime " +
  "Stage-1 share nor final TAO emission. For the separately reconstructed, " +
  "pinned live pipeline, use /api/v1/chain/emission-pipeline and inspect " +
  "verification.verified.";

export const MEAN_LEGACY_EMISSION_SHARE_DESCRIPTION =
  "Arithmetic mean of available legacy emission_share values for the day. " +
  LEGACY_EMISSION_SHARE_DESCRIPTION;

export const TOTAL_LEGACY_EMISSION_SHARE_DESCRIPTION =
  "Sum of available legacy emission_share values for member subnets; this " +
  "does not re-normalize the stored denominator. " +
  LEGACY_EMISSION_SHARE_DESCRIPTION;

export const PIPELINE_EMISSION_SHARE_DESCRIPTION =
  "Reconstructed v440 Stage-1 price share over the eligible non-root set at " +
  "chain_state.block. This is distinct from the artifact-normalized " +
  "emission_share on economics and legacy snapshot routes. It is not final " +
  "TAO emission; inspect final_share and verification.verified.";

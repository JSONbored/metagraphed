// Domain schemas shared across more than one pilot route (types-epic A,
// #7859) — kept out of envelope.ts (which is response-shape-only) and out of
// any single routes/*.ts file to avoid two independently hand-maintained,
// driftable copies of the same shape. Not part of the issue's literal file
// list; added because SubnetEconomics/SubnetStatus/CoverageLevel/etc. are
// each referenced by 2+ of the 5 pilot routes' real payloads.
//
// Derived from public/metagraph/openapi.json's components.schemas (built
// from src/contracts.ts, the canonical JSON-Schema contract), cross-checked
// against real handler output — see tests/zod-schemas.test.ts.
import { z } from "zod";
import { QUERY_ENUMS } from "./query-enums.ts";
import { ALPHA_USD_UNAVAILABLE } from "../src/alpha-usd.ts";

/**
 * An epoch-MILLISECOND instant, published as an integer (#10386).
 *
 * Registered as its own component so the schema STATES that a field is an
 * instant instead of leaving it to a spelling. GraphQL's `Int` is 32-bit
 * signed and every real epoch-ms value overflows it -- 1786323600000 against
 * a ceiling of 2147483647 -- and a non-null `Int` carrying one raises on
 * every request and nulls its whole surrounding object (#10215, which
 * `EndpointIncidentWindow.started_at` shipped with until it was found by
 * hand). `schemas-src/graphql/emit.ts` maps this component id to `Float`.
 *
 * The type alone cannot tell: `z.int()` stamps the JS safe-integer ceiling on
 * every integer, count and instant alike, so "maximum exceeds Int32" is true
 * of all of them. The emitter stood a `/_at$/` name test in for the missing
 * fact, which rescued 7 fields and missed 8 that production proves overflow
 * -- `candles[].bucket_start` on 1371 of 1371 observed candles, and the six
 * `rpc-usage` coverage bounds. Use this schema for an instant; for a span, use
 * {@link DurationMillisSchema}.
 */
export const EpochMillisSchema = z
  .int()
  .min(0)
  .describe(
    "An epoch-millisecond instant. Published as Float in GraphQL: the value exceeds the 32-bit range of GraphQL's Int.",
  );

/**
 * A span in MILLISECONDS, published as an integer (#10214).
 *
 * A span is not an instant, and the comment this replaces concluded from that
 * it was safe as `Int`. It is not: 2^31 milliseconds is 24.8 days, and two of
 * these fields reach it on paths that already exist.
 *
 *   `SelfHealthLane.age_ms`  `nowMs - row.checked_at` over the newest
 *                            `lane_health` row, with no recency filter on the
 *                            read and retention pruning that only runs on a
 *                            lane's OWN insert -- so a lane whose producer died
 *                            never prunes, and its age climbs without bound. A
 *                            watchdog's own `age_ms` is the same subtraction.
 *   `TaoUsd.age_ms`          bounded by the requested window, and the window
 *                            vocabulary includes `30d` = 2.59e9 ms, which is
 *                            1.21x the ceiling.
 *
 * Both fail in the direction that matters most: an `Int` carrying an
 * over-range value raises at execution time and nulls its surrounding object,
 * so the surface reports NOTHING precisely when the thing it monitors has been
 * broken longest. The `conformance:graphql-int-range` sweep could not catch
 * either -- it read live values, and neither was over-range at the time; it
 * retired once the executor enforced the range on every request (#10214).
 *
 * `schemas-src/graphql/emit.ts` maps this component id to `Float`, the only
 * spelling GraphQL has for the value -- which is what the hand-written SDL
 * chose for all eight of these fields by hand.
 */
export const DurationMillisSchema = z
  .int()
  .describe(
    "A duration in milliseconds. Published as Float in GraphQL: a span past 24.8 days exceeds the 32-bit range of GraphQL's Int.",
  );

/**
 * An unsigned 64-bit integer read straight from chain storage (#10214).
 *
 * `decodeLeU64Number` returns `Number(value)` with no range guard, so what the
 * runtime holds is what the field carries. Today's values are small --
 * `UnlockRate` 934,866 and `MaturityRate` 311,622 -- but they are governance
 * -set u64s, and nothing between the storage read and the response narrows
 * them to anything GraphQL's 32-bit `Int` can hold. Published as `Float`,
 * which is what the SDL already does for both.
 */
export const ChainU64Schema = z
  .int()
  .min(0)
  .describe(
    "An unsigned 64-bit integer read from chain storage. Published as Float in GraphQL: the runtime's range exceeds that of GraphQL's Int.",
  );

/** One vocabulary, owned by the leaf module so routes AND tools can import it
 * without the cycle that owning it on a route would create (#9799). */
export const NATIVE_NAME_QUALITY_VALUES = [
  "chain",
  "placeholder",
  "empty",
] as const;

/** One vocabulary, owned by the leaf module so routes AND tools can import it
 * without the cycle that owning it on a route would create (#9799). */
export const CONFIDENCE_LEVEL_VALUES = ["low", "medium", "high"] as const;

/** One vocabulary, owned by the leaf module so routes AND tools can import it
 * without the cycle that owning it on a route would create (#9799). */
export const IDENTITY_LEVEL_VALUES = [
  "none",
  "directory",
  "partial",
  "complete",
] as const;

/** One vocabulary, owned by the leaf module so routes AND tools can import it
 * without the cycle that owning it on a route would create (#9799). */
export const PROFILE_LEVEL_VALUES = QUERY_ENUMS.profileLevel;

/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const COVERAGE_LEVEL_VALUES = QUERY_ENUMS.coverageLevel;
export const CoverageLevelSchema = z.enum(COVERAGE_LEVEL_VALUES);
export type CoverageLevel = z.infer<typeof CoverageLevelSchema>;

// Chain network for the network-aware MCP tools (#8228). Same two values, and
// the same chain-name spelling, `call_rpc` already accepts — an agent should
// not have to learn that the RPC lane says "test" while a data lane says
// "testnet". Only the tools whose artifact is actually published per-network
// (list_subnets, get_subnet_detail) take this; everything else stays mainnet.
// #9645: described here rather than at each of the 18 tools that accept it —
// the two names are chain names, not environment names, and "test" reads as a
// staging copy of mainnet when it is a separate chain with its own subnets,
// its own netuids and its own history.
export const McpNetworkSchema = z
  .enum(["finney", "test"])
  .describe(
    "Which Bittensor chain to read: `finney` is mainnet (the default when " +
      "omitted), `test` is testnet. They are separate chains — a netuid on one " +
      "is unrelated to the same netuid on the other.",
  )
  .meta({ examples: ["finney"] });
export type McpNetwork = z.infer<typeof McpNetworkSchema>;

/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const CURATION_LEVEL_VALUES = QUERY_ENUMS.curationLevel;
export const CurationLevelSchema = z.enum(CURATION_LEVEL_VALUES);
export type CurationLevel = z.infer<typeof CurationLevelSchema>;

export const SubnetStatusSchema = z.enum(["active", "inactive", "unknown"]);
export type SubnetStatus = z.infer<typeof SubnetStatusSchema>;

export const SubnetTypeSchema = z.enum(["root", "application"]);
export type SubnetType = z.infer<typeof SubnetTypeSchema>;

/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const BITTENSOR_NETWORK_VALUES = ["finney", "test", "local"] as const;
export const BittensorNetworkSchema = z.enum(BITTENSOR_NETWORK_VALUES);
export type BittensorNetwork = z.infer<typeof BittensorNetworkSchema>;

/**
 * What an address-labelling entity IS (#8372).
 *
 * Both copies carried an instruction rather than an import -- "keep all three
 * in sync" on one and "Keep both in sync" on the other -- which is the shape
 * of a vocabulary with no owner. `validate:schema-vocabularies` could not see
 * either: prettier had wrapped both as `z` then `.enum([...])` on the next
 * line, and the gate's matcher was anchored on `z.enum(`.
 *
 * THE OWNER IS schemas/entity.schema.json, not this list (#10483). That file
 * is what a registry contribution is validated against, so a category it
 * accepts and this enum does not is a label the registry stores and the API
 * cannot describe. #10442/#10516 added the four money-map categories there and
 * not here, and nothing noticed: the drift is invisible until the first
 * treasury entry exists, at which point `/accounts/{ss58}/entities` serves a
 * category its own published enum calls invalid. `validate:schema-vocabularies`
 * now asserts the two match, because the consolidation that gave this
 * vocabulary an owner never gave it a gate against the JSON Schema half.
 */
export const ENTITY_CATEGORY_VALUES = [
  "exchange",
  "bridge",
  "foundation",
  "pool",
  "infra",
  "project",
  "operator",
  "other",
  // The money-map roles (#10440). `owner` is deliberately absent: subnet
  // ownership is chain-derived from SubnetOwner and must never be declarable.
  "payment-collector",
  "treasury",
  "burn",
  "multisig",
] as const;
export const EntityCategorySchema = z.enum(ENTITY_CATEGORY_VALUES);
export type EntityCategory = z.infer<typeof EntityCategorySchema>;

/**
 * The human-governance axis of a registry SUBMISSION (#10483).
 *
 * ONE vocabulary across two registries: a subnet surface's `review.state` and
 * an entity label's are the same three states, meaning the same three things --
 * a contribution enters as `community-submitted`, and a maintainer promotes it
 * to `maintainer-reviewed` or marks it `rejected`. Both
 * `schemas/entity.schema.json` and `schemas/subnet-manifest.schema.json`
 * declare it, and it was restated inline at each site with no owner.
 *
 * NOT `ReviewStateSchema` in routes/subnet-detail.ts, which is registered as the
 * published `ReviewState` component and is a DIFFERENT five-value vocabulary --
 * `unreviewed | machine-generated | maintainer-reviewed | needs-review | stale`,
 * the CURATION state of a subnet profile. The two share one member
 * (`maintainer-reviewed`) and one obvious name, which is precisely why this one
 * is named for the submission rather than for the review: importing the wrong
 * `ReviewStateSchema` type-checks and silently republishes the other component.
 *
 * Distinct again from the machine-verification axis, which the build's prober
 * owns and no contribution may set.
 */
export const SUBMISSION_REVIEW_STATE_VALUES = [
  "community-submitted",
  "maintainer-reviewed",
  "rejected",
] as const;
export const SubmissionReviewStateSchema = z.enum(
  SUBMISSION_REVIEW_STATE_VALUES,
);
export type SubmissionReviewState = z.infer<typeof SubmissionReviewStateSchema>;

/**
 * How a callable surface authenticates.
 *
 * Restated by the agent catalogue and the subnet detail card, which describe
 * the same surfaces -- and the catalogue's own comment already said so:
 * "Single-sourcing the two declarations is #9799". `signature` means the
 * request is signed per call (a hotkey/nonce/signature header set) rather than
 * carrying a static token.
 */
export const SURFACE_AUTH_SCHEME_VALUES = [
  "none",
  "bearer",
  "api-key",
  "basic",
  "oauth2",
  "signature",
  "custom",
] as const;
export const SurfaceAuthSchemeSchema = z.enum(SURFACE_AUTH_SCHEME_VALUES);
export type SurfaceAuthScheme = z.infer<typeof SurfaceAuthSchemeSchema>;

/** Where an auth credential travels. Same two restating modules as the kind
 * above -- one vocabulary split across two files describing one surface. */
export const SURFACE_AUTH_LOCATION_VALUES = [
  "header",
  "query",
  "cookie",
  "body",
] as const;
export const SurfaceAuthLocationSchema = z.enum(SURFACE_AUTH_LOCATION_VALUES);
export type SurfaceAuthLocation = z.infer<typeof SurfaceAuthLocationSchema>;

/** What a capture pass concluded about one surface's schema since the last
 * one. The drift artifact declares it and the profile card republishes it. */
export const SCHEMA_DRIFT_STATUS_VALUES = [
  "new",
  "changed",
  "unchanged",
  "not-captured",
  "missing-after-previous-capture",
] as const;
export const SchemaDriftStatusSchema = z.enum(SCHEMA_DRIFT_STATUS_VALUES);
export type SchemaDriftStatus = z.infer<typeof SchemaDriftStatusSchema>;

/** The vocabulary, exported as a tuple so every other schema that needs
 * these values imports them instead of restating them (#9799). */
export const HEALTH_STATUS_VALUES = QUERY_ENUMS.healthStatus;
export const HealthStatusSchema = z.enum(HEALTH_STATUS_VALUES);
export type HealthStatus = z.infer<typeof HealthStatusSchema>;

export const PartnershipTierSchema = z
  .enum(["pilot"])
  .describe(
    "Display/placement tier for a subnet — e.g. a featured-pilot homepage slot. Distinct from Authority and CurationLevel, which are trust signals only and never drive placement.",
  );
export type PartnershipTier = z.infer<typeof PartnershipTierSchema>;

export const PartnershipMetadataSchema = z
  .object({
    // The hand-edited OpenAPI component declares format: "date" (plain
    // calendar date, e.g. "2026-07-04") -- z.iso.date() is the Zod
    // equivalent, verified against real registry/subnets/*.json partnership
    // data before adding this constraint.
    since: z.iso.date(),
    tier: PartnershipTierSchema,
    validator_hotkey: z.string().optional(),
  })
  .strict();
export type PartnershipMetadata = z.infer<typeof PartnershipMetadataSchema>;

// Per-subnet validator/economic metrics (src/contracts.ts's SubnetEconomics
// component) — the /api/v1/economics list item AND the optional `economics`
// field nested inside /api/v1/subnets/{netuid}'s SubnetDetailArtifact.
/**
 * The USD twins `withAlphaUsd` stamps on EACH economics row (#10381), as
 * opposed to the blob-level reading in ALPHA_USD_OVERLAY below.
 *
 * DECLARED HERE BECAUSE THE ROW HALF WAS NOT. #10790 declared the blob half
 * and the row half went with it undeclared, which was invisible while these
 * schemas were `.passthrough()`. #10853's flip to `.strict()` turned that
 * into a hard refusal, and `/api/v1/economics` began 500ing on every request
 * with `response_schema_drift` naming these four keys (2026-08-12) -- the
 * same shape as #10897's three routes, found the same way.
 *
 * ALL OPTIONAL, because emission is conditional by design: a `_usd` field is
 * written only when the reading priced it (an explicit null would be
 * indistinguishable from a genuine zero once it reached a chart), and the
 * basis rides only on a row that has an `alpha_market_cap_tao` to describe.
 * The blob's `tao_usd_unavailable` is what says why they are absent.
 */
export const ALPHA_USD_ROW_OVERLAY = {
  alpha_market_cap_basis: z
    .literal("total_stake_alpha")
    .optional()
    .describe(
      "What alpha_market_cap_tao multiplies -- published rather than documented, because a market cap without its basis is not a number anyone can reconcile (#10381).",
    ),
  alpha_price_usd: z
    .number()
    .optional()
    .describe("alpha_price_tao converted at the blob's tao_usd reading."),
  alpha_market_cap_usd: z
    .number()
    .optional()
    .describe("alpha_market_cap_tao converted at the blob's tao_usd reading."),
  alpha_fdv_usd: z
    .number()
    .optional()
    .describe("alpha_fdv_tao converted at the blob's tao_usd reading."),
} as const;

export const SubnetEconomicsSchema = z
  .object({
    // The serve-time USD twins (#10381), declared with the schema they are
    // stamped onto rather than restated here -- see ALPHA_USD_ROW_OVERLAY.
    ...ALPHA_USD_ROW_OVERLAY,
    // OPTIONAL on six fields (#10965): identity (name/netuid/slug) and the
    // market roll-ups (alpha_fdv_tao/alpha_market_cap_tao/emission_share) are
    // stamped by the MAINNET economics overlay at serve time. Testnet serves
    // the raw chain economics inside the subnet-detail document, which never
    // carries them -- measured on the served testnet response, which the
    // response tripwire now actually validates. `nullable` stays where it was:
    // absent means "this network's producer has no such field", null still
    // means "known to be unknown".
    alpha_fdv_tao: z.number().nullable().optional(),
    // --- v440 emission pipeline (#8743) ---------------------------------
    // Optional, not required: a refresh whose node could not serve
    // state_queryStorageAt publishes the rest of the economics block rather
    // than nothing, so these keys are absent on a degraded run and null only
    // when the value itself is genuinely unknown.
    //
    // Alpha into the pool and alpha to participants. alpha_out_emission is
    // NOT a constant 1.0 -- it is a per-subnet halving curve that reads 1.0
    // today only because no subnet has crossed its first threshold.
    alpha_in_emission: z.number().nullable().optional(),
    alpha_out_emission: z.number().nullable().optional(),
    alpha_in_pool: z.number().nullable(),
    alpha_market_cap_tao: z.number().nullable().optional(),
    alpha_out_pool: z.number().nullable(),
    alpha_price_change_1d: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Signed %-change in alpha_price_tao over ~1 day from subnet_snapshots (#7227).",
      ),
    alpha_price_change_1h: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Signed %-change in alpha_price_tao over ~1h. Always null from daily snapshots (#7227).",
      ),
    alpha_price_change_1m: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Signed %-change in alpha_price_tao over ~30 days from subnet_snapshots (#7227).",
      ),
    alpha_price_change_7d: z
      .number()
      .nullable()
      .optional()
      .describe(
        "Signed %-change in alpha_price_tao over ~7 days from subnet_snapshots (#7227).",
      ),
    alpha_price_tao: z
      .number()
      .nullable()
      .describe(
        "The chain's MOVING price, not spot (#9408): on the live tier this is byte-identical to moving_price_pinned, the same word at the same instant. It is the right number for emission weighting, which is what the chain uses it for — but a lagging average is the wrong mark for valuing a position, and the gap widens exactly when the market moves. Use spot_price_tao for that.",
      ),
    // #9408: derived at serve time from tao_in_pool_tao / alpha_in_pool on this very
    // row, so it cannot disagree with the reserves published beside it, and shares
    // stake-quote's own spotPriceTao so the two routes mean the same thing by "spot".
    spot_price_tao: z
      .number()
      .nullable()
      .optional()
      .describe(
        "The AMM spot price in TAO per alpha — the pool ratio at rest, derived from tao_in_pool_tao / alpha_in_pool on this row. Root (netuid 0) has no AMM and is 1 by definition. Null when the reserves cannot support a price; an empty pool has no spot, and 0 would read as free. This is the mark to value a position at; alpha_price_tao is the moving average.",
      ),
    block: z.int().min(0).nullable().optional(),
    emission_share: z.number().min(0).max(1).nullable().optional(),
    // Stage 5. DEFAULTS TO TRUE on chain: absent storage is enabled and 0x00
    // is disabled, so 57 of 127 subnets are enabled with no entry at all.
    emission_enabled: z.boolean().nullable().optional(),
    // Stage 7: TAO the chain bought on this subnet's behalf.
    excess_tao: z.number().nullable().optional(),
    // Stage 0 eligibility. The block a subnet first emitted at, or null if it
    // never has.
    first_emission_block: z.int().min(0).nullable().optional(),
    max_stake_alpha: z.number().nullable(),
    max_uids: z.int().min(0),
    max_validators: z.int().min(0),
    miner_count: z.int().min(0),
    miner_readiness: z.int().min(0).max(100).nullable().optional(),
    // Stage 2. A FRACTION IN [0, 1], not an amount -- MinerBurned is U96F32
    // (divide by 2^32, never by 1e9). Verified across all 127 subnets: every
    // non-zero value lands in (0, 1] with a maximum of exactly 1.0, which a
    // misscaled amount would not.
    miner_burned_fraction: z.number().min(0).max(1).nullable().optional(),
    name: z.string().optional(),
    netuid: z.int().min(0).optional(),
    open_slots: z.int().min(0).nullable().optional(),
    owner_coldkey: z.string().nullable(),
    owner_hotkey: z.string().nullable(),
    registration_allowed: z.boolean(),
    registration_cost_tao: z.number().nullable(),
    slug: z.string().optional(),
    subnet_volume_tao: z.number().nullable(),
    // Stage 0 eligibility.
    subtoken_enabled: z.boolean().nullable().optional(),
    // Stage 1's input and stage 0's last gate, READ AT chain_state.block
    // (#8744) rather than off the bulk metagraph call the way alpha_price_tao
    // and registration_allowed are. Same chain items, different instant: the
    // bulk call runs at its own height, and every other term the
    // reconstruction combines these with is pinned. alpha_price_tao keeps its
    // own source and published meaning (ADR 0023 decision 1) -- these are a
    // second reading for the pipeline alone, which is why the names differ.
    //
    // Null is "not captured", never zero: a zero moving price is a real
    // stage-1 share of nothing, and conflating the two would hand a live
    // subnet a share of exactly 0.
    moving_price_pinned: z.number().nullable().optional(),
    registration_allowed_pinned: z.boolean().nullable().optional(),
    // The two per-subnet inputs to the chain's own deregistration order
    // (#10285), read in this same pinned sweep so an immunity verdict is
    // computed against the block the registration height was read at.
    //
    // `registered_at_block` is SubtensorModule.NetworkRegisteredAt -- the
    // SUBNET's registration height, not a neuron's. The registry index carries
    // a field of the same name that is a publish cycle behind this one.
    //
    // `subnet_mechanism` is 0 (Stable) or 1 (Dynamic), and is not cosmetic:
    // `get_moving_alpha_price` substitutes a flat 1.0 for a Stable subnet
    // instead of reading its moving price, which moves it from the top of a
    // price order to the bottom.
    //
    // Optional, because the R2 fallback tier still holds blobs captured before
    // these reads existed and they are legitimately servable.
    registered_at_block: z
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe(
        "SubtensorModule.NetworkRegisteredAt -- the SUBNET's registration height, read in this same pinned sweep. Both the immunity clock's start and the deregistration order's tie-break. Not a neuron's registration block, and not the registry index's field of the same name, which is a publish cycle behind this one.",
      ),
    subnet_mechanism: z
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe(
        "SubtensorModule.SubnetMechanism -- 0 is Stable, 1 is Dynamic. Not cosmetic: get_moving_alpha_price substitutes a flat 1.0 for a Stable subnet instead of reading its moving price, moving it from the top of a pruning-price order to the bottom.",
      ),
    // Stage 8: TAO injected into this subnet's own pool. Its sum with
    // excess_tao across subnets equals the issuance-derived block emission.
    //
    // A POINT SAMPLE AT `chain_state.block`, AND THAT IS FINE (#8744). This
    // comment previously said the value was "noisy by construction" per block
    // and that a daily rollup was the reportable figure. Measured across 14
    // consecutive finney blocks (8,740,604-8,740,617), that is not what the
    // chain does: both channels move smoothly and near-monotonically -- a few
    // rao per block -- and the derived liquidity_fraction varies by 1.8e-6 to
    // 1.0e-5 over the window. That is ~20x tighter than the 2e-4 tolerance the
    // reconstruction itself carries, so a rollup would average away noise
    // smaller than the error already in the number. There is no rollup.
    tao_in_emission_tao: z.number().nullable().optional(),
    tao_in_pool_tao: z.number().nullable(),
    total_stake_alpha: z.number().nullable(),
    validator_count: z.int().min(0),
  })
  .strict();
export type SubnetEconomics = z.infer<typeof SubnetEconomicsSchema>;

/**
 * `SubnetEconomics` as a READ path must take it.
 *
 * Same partial+catchall contract every lakehouse row schema is declared with,
 * and for the same two reasons: a read often carries a SUBSET of the columns
 * (a `fields=` projection, or a tier whose producer has no such field), and it
 * may carry MORE than the schema names (a producer that shipped a field before
 * this file learned about it). What stays pinned is the TYPE of any declared
 * key that IS present -- which is the half that catches a real defect.
 *
 * The strict schema above stays the PRODUCER's contract, where an undeclared
 * key is a genuine drift worth failing on. Reading through it instead would
 * make the leaderboards go empty the day a producer adds a field, turning a
 * schema into an availability risk -- and a route that answers nothing is
 * indistinguishable from one whose data is gone (#11339, closing #10789's
 * "replace the assertion with a parse").
 */
export const SubnetEconomicsReadSchema =
  SubnetEconomicsSchema.partial().catchall(z.unknown());
export type SubnetEconomicsRead = z.infer<typeof SubnetEconomicsReadSchema>;

// The block every v440 emission-pipeline read was pinned to (#8744), carried
// at the artifact's top level because one `state_queryStorageAt` produced the
// whole network's row set -- two subnets cannot disagree about it.
//
// ADR 0023 decision 5 makes provenance a contract, not a nice-to-have: the
// decomposition is OUR arithmetic over chain measurements, and a reader who
// cannot tell which block it was read at cannot check it. `block_hash` is here
// so that check is exact -- a height alone is ambiguous across a reorg.
//
// Absent (not null) on a degraded refresh whose node could not serve the
// pinned reads. Never defaulted to captured_at or to chain tip: a height that
// was not read from is worse than no height, because it looks like provenance.
/**
 * A public http(s) URL. Owned here since #10214: three route modules each
 * declared their own identical copy, so the same constraint was stated three
 * times and could drift in two of them unnoticed.
 */
export const HttpUrlSchema = z.string().regex(/^[Hh][Tt][Tt][Pp][Ss]?:\/\//);

/** The social links block, shared by the subnet index entry and its detail. */
export const SocialLinksSchema = z
  .object({
    reddit: HttpUrlSchema.optional(),
    telegram: HttpUrlSchema.optional(),
    x: HttpUrlSchema.optional(),
    youtube: HttpUrlSchema.optional(),
  })
  .strict();

export const ChainStateSchema = z
  .object({
    block: z.int().min(0),
    block_hash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .describe(
        "The block hash, so the pinning is exact -- a height alone is ambiguous across a reorg.",
      ),
    // Block emission is derived from issuance (#8747), never read from the
    // stale `BlockEmission` storage item. Kept at the height so a historical
    // row stays interpretable against the emission in force when captured.
    total_issuance_tao: z.number().nonnegative(),
    // The gate's three parameters AT THIS BLOCK (#8744). Not captured at any
    // height before now, and a live read is the wrong number for 359 blocks
    // out of 360: the runtime recomputes theta whenever block % 360 == 0, and
    // gates with the STORED value in between.
    //
    // theta is null when the bar is unset, which disables the gate outright
    // (apply_emission_gate's own `if theta <= zero { return; }`).
    emission_gate_bar: z
      .number()
      .nullable()
      .describe(
        "theta. Null when the bar is unset, which disables the gate outright.",
      ),
    emission_bar_quantile: z.number().nullable(),
    // NULL MEANS THE RUNTIME DEFAULT h = 3, NOT ZERO. h = 0 would make the
    // Hill gate return exactly 0.5 for every subnet, so coercing absent to 0
    // silently replaces the gate with a constant. Left null here and resolved
    // by the consumer against DEFAULT_EMISSION_GATE_EXPONENT.
    emission_gate_exponent: z
      .int()
      .nullable()
      .describe(
        "h. Null means the runtime default 3, NOT zero -- h = 0 makes the Hill gate a constant 0.5 for every subnet.",
      ),
    // How long after registration a subnet cannot be deregistered, in blocks
    // (#10285). Network-wide, so it sits with the other chain scalars rather
    // than on each subnet row.
    //
    // OPTIONAL, not merely nullable: the R2 fallback tier still holds blobs
    // captured before this read existed, and they are valid artifacts that a
    // request can legitimately be served from. Nullable alone would reject
    // them at the schema and turn a working fallback into an outage.
    network_immunity_period: z
      .int()
      .min(0)
      .nullable()
      .optional()
      .describe(
        "SubtensorModule.NetworkImmunityPeriod -- how many blocks after registration a subnet cannot be deregistered. Null on a blob captured before this read existed.",
      ),
  })
  .strict()
  .describe(
    "The chain state the decomposition's inputs were pinned to. theta/q/h are read AS STORED at this block -- the runtime gates with the stored bar between its 360-block recomputes, so a live read is the wrong number for 359 blocks out of 360.",
  );
export type ChainState = z.infer<typeof ChainStateSchema>;

// Per-field provenance (#9078): every published value labelled `measured` --
// with the pallet-qualified storage item behind it -- or `reconstructed`, our
// own arithmetic over one or more measurements.
//
// ADR 0023 decision 5 introduced this on /api/v1/chain/emission-pipeline; it
// lives here because it is now the shape EVERY surface publishing a
// `field_sources` map uses, and a consumer should learn it once rather than
// once per endpoint. src/field-provenance.ts is its runtime counterpart.
//
// A record rather than a fixed object: the key set is each route's own field
// list, and pinning it here would mean re-declaring every route's shape twice.
// tests/field-provenance.test.ts is what holds the keys to the served fields.
export const FieldSourcesSchema = z
  .record(
    z.string(),
    z
      .object({
        kind: z.enum(["measured", "reconstructed"]),
        // #9106. Optional, and absent on every surface whose fields share one
        // read instant. Present on /api/v1/economics, whose bulk-call fields
        // and pinned storage reads happen at different heights -- including
        // two that are the SAME chain item at both. Absent on a reconstruction
        // spanning instants means "no single instant applies", not "unknown".
        read_at: z.enum(["capture", "chain_state.block"]).optional(),
        // Non-null exactly when kind is "measured". Null on a reconstruction
        // is a positive statement, not an omission: for `block_emission_tao`
        // it says we did NOT read the `BlockEmission` storage item, which is
        // stale (#8747) and would otherwise look like the obvious source.
        storage: z.string().nullable(),
      })
      .strict(),
  )
  .describe(
    "Per-field { kind, storage } provenance map: every value is labelled measured (with the pallet-qualified storage item it was read from) or reconstructed (our arithmetic over measurements, storage null). ADR 0023 decision 5.",
  );
export type FieldSources = z.infer<typeof FieldSourcesSchema>;

// One concentration lens over a single value distribution (src/concentration.ts's
// computeConcentration()) -- shared by SubnetPerformanceArtifact/
// ChainPerformanceArtifact's incentive/dividends lenses AND
// ChainConcentrationArtifact/AccountPortfolioArtifact/BlocksSummaryArtifact's
// own concentration fields (types-epic B batch 3, #8057; verified via
// repo-wide $ref grep -- unlike subnet-concentration.ts's ConcentrationLensSchema,
// which is deliberately NOT this component since the hand-edited
// SubnetConcentrationArtifact never $ref'd it either). Registered as a public
// OpenAPI component (schemas-src/openapi-registry.ts) since routes outside
// this batch still reference it by name.
export const ConcentrationMetricsSchema = z
  .object({
    // Required and non-null (#10214): computeConcentration() writes both on
    // every card it builds -- the empty-distribution case nulls the CARD (the
    // `.nullable()` below), never a field inside one. The compiler walked
    // every producer including the degraded arms and none can write null
    // here; production answered both with values on the live surface. The
    // old `.nullable().optional()` spelling predates the typed producers and
    // described no writer.
    holders: z.int().min(0),
    total: z
      .number()
      .nullable()
      .optional()
      .describe(
        "The sum of the distribution this lens was computed over, in that distribution's own unit and window -- the FIELD EMBEDDING this lens names both (window-summed per-tempo alpha samples on miner-fairness, incentive shares on performance, block counts on blocks-summary). Never comparable across routes: two lenses over different distributions share these measures, not a unit.",
      ),
    gini: z.number().nullable().optional(),
    hhi: z.number().nullable().optional(),
    hhi_normalized: z.number().nullable().optional(),
    nakamoto_coefficient: z.int(),
    top_1pct_share: z.number().nullable().optional(),
    top_5pct_share: z.number().nullable().optional(),
    top_10pct_share: z.number().nullable().optional(),
    top_20pct_share: z.number().nullable().optional(),
    entropy: z.number().nullable().optional(),
    entropy_normalized: z.number().nullable().optional(),
  })
  .strict()
  .nullable()
  .describe(
    "One concentration lens over a single value distribution: holder count, total, and the Gini, HHI (raw and holder-count-normalized), Nakamoto coefficient, top-percentile cumulative shares, and Shannon entropy (raw and normalized) measures. Null when the distribution is empty (a cold store or an all-zero column).",
  );
export type ConcentrationMetrics = z.infer<typeof ConcentrationMetricsSchema>;

// Distribution summary of a 0-1 per-UID score across neurons (src/subnet-
// performance.ts's scoreDistribution()) -- shared by SubnetPerformanceArtifact/
// ChainPerformanceArtifact's trust/consensus/validator_trust lenses (types-epic
// B batch 3, #8057; verified via repo-wide $ref grep). Registered as a public
// OpenAPI component since ChainPerformanceArtifact (outside this batch) still
// references it by name.
export const ScoreDistributionSchema = z
  .object({
    // Required, not optional-and-nullable (#10214). BOTH producers --
    // src/chain-performance.ts and src/subnet-performance.ts's
    // scoreDistribution() -- return `null` for the whole block when no value
    // is finite, and otherwise set these four unconditionally from
    // `finite.length` and the sorted values. There is no path that yields a
    // distribution object with a missing or null count/mean/min/max, so the
    // looser shape published a possibility neither producer can express.
    count: z.int().min(0),
    mean: z.number(),
    min: z.number(),
    max: z.number(),
    p10: z.number().nullable().optional(),
    p25: z.number().nullable().optional(),
    p50: z.number().nullable().optional(),
    p75: z.number().nullable().optional(),
    p90: z.number().nullable().optional(),
  })
  .strict()
  .nullable()
  .describe(
    "Distribution summary of a 0\u20131 per-UID score across neurons: count, mean, min, max, and the p10/p25/p50/p75/p90 nearest-rank percentiles. Null when no neuron carries a finite score (a cold store or an empty network).",
  );
export type ScoreDistribution = z.infer<typeof ScoreDistributionSchema>;

/**
 * The blob-level USD overlay, declared ONCE for its three carriers (#10790).
 *
 * `withAlphaUsd`/`withAlphaUsdEconomics` stamp exactly one of these two at
 * serve time -- the reading every `_usd` field was converted at, or the named
 * reason there are none. Two schemas wrote the pair out by hand and the third,
 * `EconomicsArtifact`, declared neither while the overlay has always been
 * applied to it: /api/v1/economics served `tao_usd_unavailable` undescribed,
 * which `.passthrough()` allowed and `.strict()` finally caught.
 *
 * `tao_usd_unavailable` is a NAMED reason rather than mere absence, because
 * "no USD fields" and "no USD fields BECAUSE the index has too few pools" are
 * different answers and only the second tells a caller whether to retry.
 */
export const ALPHA_USD_OVERLAY = {
  tao_usd: z
    .object({
      usd_per_tao: z.number(),
      block_number: z.int().nullable(),
      observed_at: z.string().nullable(),
      price_basis: z.string().nullable(),
    })
    .strict()
    .optional()
    .describe(
      "The reading every _usd field was converted at. Rides at the blob level because ONE reading priced all of them.",
    ),
  tao_usd_unavailable: z
    .enum(ALPHA_USD_UNAVAILABLE)
    .optional()
    .describe(
      "Why there are no _usd fields. `index_unpriced` is ADR 0025's insufficient_pools -- a stated decline, never a price of zero.",
    ),
} as const;

/**
 * One captured GitHub release, declared once for its three carriers (#10790).
 *
 * `subnet-detail.ts`, `subnet-profile.ts` and `subnets.ts` each carried a
 * byte-identical copy inside their own `github_releases` array -- the same
 * shape written out three times, which is three places a field can be added to
 * two of. Identical at the point of collapse, so nothing published moves.
 */
export const GithubReleaseSchema = z
  .object({
    tag: z.string(),
    name: z.string().nullable(),
    published_at: z.iso.datetime(),
    url: z.string(),
    prerelease: z.boolean(),
  })
  .strict();

/**
 * A count and the spread of a measure -- ONE declaration, four domains (#10790).
 *
 * The eight-key summary (count/mean/min/p25/p50/p75/p90/max) was written out
 * four times: a 0-100 stability score with INTEGER percentiles, a net flow that
 * can be negative, a non-negative intensity, and an unbounded generic. The key
 * set is one vocabulary; the bounds are not, and collapsing them to a single
 * schema would erase exactly the constraints that say what each measure IS.
 *
 * So the SHAPE is declared once and the MEASURE is the parameter. A site that
 * knows its values are bounded says so, and none of them can drift on what a
 * distribution summary contains.
 *
 * `percentile` defaults to `measure` and is separate only because the stability
 * score's percentiles are whole numbers where its mean and p50 are not.
 *
 * ## p50, not `median`
 *
 * The 50th percentile is spelled `p50` here, beside `p25`/`p75`/`p90`, because
 * the registry serves that one statistic under BOTH names: this family answered
 * `median` while ScoreDistribution (shared.ts, /chain/performance and
 * /subnets/{netuid}/performance) answered `p50`, from the same kind of sorted
 * vector. A caller reading two of our distribution blocks had to know which
 * spelling each one used, and `median` sitting between `p25` and `p75` reads as
 * a different measurement rather than the middle of the same ladder.
 *
 * Renaming the published field is the point rather than a side effect, so the
 * producers moved with it in the same change -- a schema that renames ahead of
 * its writers is drift, and drift is now a 500.
 */
export function distributionStatsSchema(
  measure: z.ZodType,
  percentile: z.ZodType = measure,
) {
  return z
    .object({
      count: z.int().min(0),
      mean: measure,
      min: percentile,
      p25: percentile,
      p50: measure,
      p75: percentile,
      p90: percentile,
      max: percentile,
    })
    .strict();
}

/**
 * A per-subnet, per-day trend series -- ONE envelope, three point types (#10790).
 *
 * `{schema_version, netuid, window, point_count, points}` was written out three
 * times, for concentration, performance and yield, differing only in what a
 * point IS. The envelope is one vocabulary; the point is the parameter.
 *
 * `point_count` is the rows RETURNED. An empty series on a cold store is a
 * measurement, never an error -- which is why every one of these resolves to a
 * schema-stable empty card rather than null.
 */
export function subnetHistoryArtifactSchema(point: z.ZodType) {
  return z
    .object({
      schema_version: z.int(),
      netuid: z.int().min(0),
      window: z
        .string()
        .nullable()
        .optional()
        .describe("The resolved window label (7d/30d/90d)."),
      point_count: z.int().min(0),
      points: z.array(point),
    })
    .strict();
}

/**
 * A per-subnet, offset-paged entry list -- ONE envelope, three entry types
 * (#10790).
 *
 * `{schema_version, netuid, entry_count, limit, offset, next_cursor, entries}`
 * was written out three times, for hyperparameter history, identity history and
 * lifecycle, differing only in what an entry IS.
 *
 * `limit`/`offset` are NULLABLE rather than merely optional: the REST layer
 * defaults them before the loader runs, so a live response carries integers,
 * but the loader is reachable without them and a schema that promised numbers
 * would be wrong on that path.
 */
export function subnetEntryListSchema(entry: z.ZodType) {
  return z
    .object({
      schema_version: z.int(),
      netuid: z.int().min(0),
      entry_count: z.int().min(0),
      limit: z.int().min(1).max(1000).nullable().optional(),
      offset: z.int().min(0).nullable().optional(),
      next_cursor: z.string().nullable().optional(),
      entries: z.array(entry),
    })
    .strict();
}

/**
 * How the native snapshot was read -- ONE declaration (#10790).
 *
 * `fetch-native-subnets.py` writes this block once and it is copied into both
 * `subnets.json` and `coverage.json`'s `source.native`, which each declared it
 * separately: one with `.nullable()` the producer never emits, one without.
 * Optional rather than required, because an artifact captured before a field
 * existed still has to parse; never nullable, because the producer writes six
 * strings or nothing at all.
 */
export const NativeSnapshotSourceSchema = z
  .object({
    identity_storage: z.string().optional(),
    kind: z.string().optional(),
    method: z.string().optional(),
    package: z.string().optional(),
    rpc_family: z.string().optional(),
    version: z.string().optional(),
  })
  .strict();

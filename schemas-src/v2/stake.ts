import { z } from "zod";
import {
  V2DigestSchema,
  V2EnvelopeSchema,
  V2FreshnessSchema,
  V2HashSchema,
  V2HeightSchema,
  V2NetworkIdSchema,
  V2NetuidSchema,
  V2SubnetSchema,
  V2TimestampSchema,
} from "./primitives.ts";

const revision = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const uint = z
  .string()
  .max(39)
  .regex(/^(0|[1-9][0-9]*)$/);
const signed = z
  .string()
  .max(40)
  .regex(/^(0|-?[1-9][0-9]*)$/);
const within = (value: string, minimum: bigint, maximum: bigint) =>
  value.length <= 40 &&
  /^(0|-?[1-9][0-9]*)$/.test(value) &&
  BigInt(value) >= minimum &&
  BigInt(value) <= maximum;
const u64 = uint.refine((value) => within(value, 0n, 18446744073709551615n));
const u128 = uint.refine((value) =>
  within(value, 0n, 340282366920938463463374607431768211455n),
);
const i64 = signed.refine((value) =>
  within(value, -9223372036854775808n, 9223372036854775807n),
);
const i128 = signed.refine((value) =>
  within(
    value,
    -170141183460469231731687303715884105728n,
    170141183460469231731687303715884105727n,
  ),
);
const state = z.enum(["absent", "zero", "retired", "current"]);
const selection = z.enum(["legacy", "v2", "absent"]);
const rawShare = z.discriminatedUnion("encoding", [
  z.object({ encoding: z.literal("legacy_u64f64"), bits: u128 }).strict(),
  z
    .object({
      encoding: z.literal("safe_float_v2"),
      mantissa: u128,
      exponent: i64,
    })
    .strict()
    .refine(
      (value) =>
        within(value.mantissa, 0n, 1000000000000000000000n) &&
        (value.mantissa === "0"
          ? value.exponent === "0"
          : within(
              value.mantissa,
              100000000000000000001n,
              1000000000000000000000n,
            )),
    ),
]);
const observation = (bytes: number) =>
  z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("stored"),
        scale_hex: z
          .string()
          .length(bytes * 2 + 2)
          .regex(new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`)),
      })
      .strict(),
    z.object({ status: z.literal("absent_in_complete_census") }).strict(),
  ]);
const subnet = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("same_snapshot"),
      generation: V2SubnetSchema.shape.generation,
      counter_source: V2SubnetSchema.shape.counter_source,
      baseline_history_unqualified: z.boolean(),
      lifecycle: V2SubnetSchema.shape.lifecycle,
      operational: z.boolean(),
    })
    .strict(),
  z
    .object({ status: z.literal("residual_storage"), generation: z.null() })
    .strict(),
]);
const asset = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("tao"),
      genesis_hash: V2HashSchema,
      unit: z.literal("rao"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("subnet_alpha"),
      genesis_hash: V2HashSchema,
      netuid: V2NetuidSchema,
      registration_counter:
        V2SubnetSchema.shape.generation.shape.registration_counter.nullable(),
      unit: z.literal("alpha_atomic"),
    })
    .strict(),
]);
const quote = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("exact"),
      atomic_units: u64,
      basis: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("root_tao") }).strict(),
        z
          .object({ kind: z.literal("subnet_alpha"), netuid: V2NetuidSchema })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      status: z.literal("no_current_position"),
      state: z.enum(["absent", "retired"]),
    })
    .strict(),
]);

/** This is an admitted join member, not a wallet balance or a TAO valuation. */
export const V2StakePositionSchema = z
  .object({
    hotkey: V2HashSchema,
    coldkey: V2HashSchema,
    netuid: V2NetuidSchema,
    subnet,
    asset,
    selection: z.object({ member: selection, denominator: selection }).strict(),
    observations: z
      .object({
        legacy_member: observation(16),
        v2_member: observation(24),
        member_epoch: observation(8),
        legacy_denominator: observation(16),
        v2_denominator: observation(24),
        pool_epoch: observation(8),
        pool_balance: observation(8),
      })
      .strict(),
    assessment: z
      .object({
        status: z.literal("assessed"),
        share_state: state,
        member: rawShare.nullable(),
        denominator: rawShare.nullable(),
        pool_epoch: u64.nullable(),
        member_epoch: u64.nullable(),
      })
      .strict(),
    quote,
  })
  .strict()
  .refine((value) => {
    const member = value.assessment.member;
    const denominator = value.assessment.denominator;
    const zero = (share: NonNullable<typeof member>) =>
      share.encoding === "legacy_u64f64"
        ? share.bits === "0"
        : share.mantissa === "0";
    const shareState = value.assessment.share_state;
    if (
      (shareState === "absent") !== (member === null) ||
      (shareState === "zero" && (member === null || !zero(member))) ||
      (["current", "retired"].includes(shareState) &&
        (member === null || zero(member))) ||
      (shareState === "current" && (denominator === null || zero(denominator)))
    )
      return false;
    if ((value.netuid === 0) !== (value.asset.kind === "tao")) return false;
    if (
      value.asset.kind === "subnet_alpha" &&
      (value.asset.netuid !== value.netuid ||
        value.asset.registration_counter !==
          (value.subnet.status === "same_snapshot"
            ? value.subnet.generation.registration_counter
            : null))
    )
      return false;
    if (
      value.subnet.status === "same_snapshot" &&
      (value.subnet.generation.netuid !== value.netuid ||
        value.subnet.operational !==
          ["registered", "started"].includes(value.subnet.lifecycle) ||
        value.subnet.baseline_history_unqualified !==
          (value.netuid !== 0 &&
            value.subnet.generation.registration_counter === "0") ||
        (value.subnet.counter_source === "runtime_default" &&
          value.subnet.generation.registration_counter !== "0"))
    )
      return false;
    if (value.quote.status === "no_current_position")
      return value.quote.state === value.assessment.share_state;
    return (
      ["current", "zero"].includes(value.assessment.share_state) &&
      (value.netuid === 0
        ? value.quote.basis.kind === "root_tao"
        : value.quote.basis.kind === "subnet_alpha" &&
          value.quote.basis.netuid === value.netuid) &&
      (value.assessment.share_state !== "zero" ||
        value.quote.atomic_units === "0")
    );
  }, "Stake position identities, share state or quantity basis differ");

const principal = z.discriminatedUnion("status", [
  z.object({ status: z.literal("exact_rao"), value: u64 }).strict(),
  z.object({ status: z.literal("absent_in_complete_join") }).strict(),
  z
    .object({
      status: z.literal("no_current_position"),
      value: z.enum(["absent", "retired"]),
    })
    .strict(),
]);
const rootAmounts = z
  .object({
    profile_revision: z.literal("subtensor-488-root-basket-v1"),
    upstream_revision: z.literal("b6a81d144078eac18bd25c3af7cb31579bb670f3"),
    qualification: z.literal("metadata_qualified_source_candidate"),
    metadata_layout_qualified: z.literal(true),
    layout_snapshot_id: V2DigestSchema,
    runtime_semantics_attested: z.literal(false),
    state_proof_verified: z.literal(false),
    at_hash: V2HashSchema,
    state_metadata_sha256: V2DigestSchema,
    hotkey_hex: V2HashSchema,
    coldkey_hex: V2HashSchema,
    root_principal_rao: u64,
    basket_claimed_shares: i128,
    basket_claimed_correction_shares: i128,
    basket_owed_shares: u64,
    basket_shares_capped: u64,
    basket_shares_total: u64,
    deferred_alpha: z
      .array(
        z
          .object({
            netuid: V2NetuidSchema,
            generation: u64.refine((value) => value !== "0"),
            alpha_atomic: u64,
          })
          .strict(),
      )
      .max(256),
    deferred_cash_rao: u64,
    deferred_cash_claimed_settled_rao: i128,
  })
  .strict();
export const V2RootEntitlementSchema = z
  .object({
    snapshot_id: V2DigestSchema,
    key: z.object({ hotkey: V2HashSchema, coldkey: V2HashSchema }).strict(),
    principal,
    outcome: z.discriminatedUnion("status", [
      z.object({ status: z.literal("assessed"), value: rootAmounts }).strict(),
      z.object({ status: z.literal("protocol_custody") }).strict(),
    ]),
  })
  .strict()
  .refine((value) => {
    const escrow =
      value.key.coldkey ===
      "0x6d6f646c73756274656e7372626574612f657363000000000000000000000000";
    if (value.outcome.status === "protocol_custody") return escrow;
    if (escrow) return false;
    const amounts = value.outcome.value;
    return (
      amounts.layout_snapshot_id === value.snapshot_id &&
      amounts.hotkey_hex === value.key.hotkey &&
      amounts.coldkey_hex === value.key.coldkey &&
      amounts.root_principal_rao ===
        (value.principal.status === "exact_rao"
          ? value.principal.value
          : "0") &&
      amounts.deferred_alpha.every(
        (entry, index, entries) =>
          index === 0 || entries[index - 1].netuid < entry.netuid,
      ) &&
      [
        amounts.basket_shares_capped,
        amounts.basket_owed_shares,
        amounts.basket_shares_total,
      ].every((value) => within(value, 0n, 18446744073709551615n)) &&
      BigInt(amounts.basket_shares_capped) <=
        BigInt(amounts.basket_owed_shares) &&
      BigInt(amounts.basket_shares_capped) <=
        BigInt(amounts.basket_shares_total)
    );
  }, "Root claimant provenance or units differ");

export const V2AccountStakeEntrySchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("position"), position: V2StakePositionSchema })
    .strict(),
  z
    .object({
      kind: z.literal("root_entitlement"),
      entitlement: V2RootEntitlementSchema,
    })
    .strict(),
]);
export type V2AccountStakeEntry = z.infer<typeof V2AccountStakeEntrySchema>;

/** Check attribution without recomputing the producer's monetary semantics. */
export function isV2AccountStakeEntryAtState(
  entry: V2AccountStakeEntry,
  account: string,
  genesis: string,
  snapshot: {
    snapshot_id: string;
    block_hash: string;
    metadata_digest: string;
  },
): boolean {
  if (entry.kind === "position")
    return (
      entry.position.coldkey === account &&
      entry.position.asset.genesis_hash === genesis
    );
  const entitlement = entry.entitlement;
  return (
    entitlement.key.coldkey === account &&
    entitlement.snapshot_id === snapshot.snapshot_id &&
    (entitlement.outcome.status === "protocol_custody" ||
      (entitlement.outcome.value.at_hash === snapshot.block_hash &&
        entitlement.outcome.value.state_metadata_sha256 ===
          snapshot.metadata_digest))
  );
}

export const V2AccountStakeCursorSchema = z
  .object({
    version: z.literal(1),
    network: V2NetworkIdSchema,
    genesis_hash: V2HashSchema,
    account_id: V2HashSchema,
    publication_id: V2DigestSchema,
    kind: z.enum(["position", "root_entitlement"]),
    hotkey: V2HashSchema,
    netuid: V2NetuidSchema.nullable(),
  })
  .strict()
  .refine((value) => (value.kind === "position") === (value.netuid !== null));

export const V2AccountStakeInputSchema = z
  .object({
    network: V2NetworkIdSchema,
    account_id: V2HashSchema,
    publication_id: V2DigestSchema.optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.int().min(1).max(10).default(10),
  })
  .strict();

export const V2AccountStakeSchema = V2EnvelopeSchema.extend({
  account_id: V2HashSchema,
  stake: z
    .object({
      publication_id: V2DigestSchema,
      generation: V2HeightSchema.refine((value) => value !== "0"),
      source_id: V2DigestSchema,
      root_candidate_id: V2DigestSchema,
      request_id: V2DigestSchema,
      stake_candidate_id: V2DigestSchema,
      ecosystem_candidate_id: V2DigestSchema,
      block_publication_id: V2DigestSchema,
      projection_contract: z.literal(1),
      producer_revision: revision,
      observed_at: V2TimestampSchema,
      published_at: V2TimestampSchema,
      qualification: z.literal("source_reviewed_candidate"),
      state_proof_verified: z.literal(false),
      runtime_semantics_attested: z.literal(false),
      census_complete: z.literal(true),
      account_scope: z.literal("coldkey"),
      member_count: V2HeightSchema,
      claimant_count: V2HeightSchema,
      state: z
        .object({
          snapshot_id: V2DigestSchema,
          block_number: V2HeightSchema,
          block_hash: V2HashSchema,
          metadata_digest: V2DigestSchema,
          spec_version: z.int().min(0).max(4294967295),
          transaction_version: z.int().min(0).max(4294967295),
          producer_revision: revision,
          observed_at: V2TimestampSchema,
        })
        .strict(),
    })
    .strict(),
  freshness: V2FreshnessSchema.extend({
    target_seconds: z.literal(3600),
    target_blocks: z.null(),
  }),
  entries: z.array(V2AccountStakeEntrySchema).max(10),
  next_cursor: z.string().min(1).max(2048).nullable(),
})
  .strict()
  .refine(
    (value) =>
      value.snapshot.block_number === value.stake.state.block_number &&
      value.snapshot.block_hash === value.stake.state.block_hash &&
      value.snapshot.publication_id === value.stake.block_publication_id &&
      value.stake.observed_at === value.stake.state.observed_at,
    "Execution and stake state do not select the same canonical block",
  );

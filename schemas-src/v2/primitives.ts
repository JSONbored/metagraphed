import { z } from "zod";

export const V2NetworkIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
export const V2HeightSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(
    (value) =>
      value.length <= 19 &&
      /^[0-9]+$/.test(value) &&
      BigInt(value).toString() === value &&
      BigInt(value) <= 9223372036854775807n,
  );
export const V2HashSchema = z.string().regex(/^0x[0-9a-f]{64}$/);
export const V2DigestSchema = z.string().regex(/^[0-9a-f]{64}$/);
export const V2NetuidSchema = z.int().min(0).max(65535);
export const V2TimestampSchema = z.iso.datetime({ offset: true });

export const V2QuantitySchema = z
  .object({
    amount: z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/),
    decimals: z.int().min(0).max(255),
    asset: z.string().min(1).max(64),
    kind: z.enum(["asset", "shares", "voting_weight", "emission", "valuation"]),
  })
  .strict();

export const V2NetworkSchema = z
  .object({ id: V2NetworkIdSchema, genesis_hash: V2HashSchema })
  .strict();

export const V2SnapshotSchema = z
  .object({
    block_number: V2HeightSchema,
    block_hash: V2HashSchema,
    parent_hash: V2HashSchema,
    metadata_digest: V2DigestSchema,
    spec_version: z.int().nonnegative(),
    transaction_version: z.int().nonnegative(),
    producer_revision: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    publication_id: V2DigestSchema,
    observed_at: V2TimestampSchema,
    published_at: V2TimestampSchema,
  })
  .strict();

export const V2FreshnessSchema = z
  .object({
    status: z.enum(["current", "stale", "unknown"]),
    age_seconds: z.number().nonnegative(),
    finalized_lag_blocks: V2HeightSchema.nullable(),
    target_seconds: z.literal(30),
    target_blocks: z.literal(2),
  })
  .strict();

export const V2EnvelopeSchema = z.object({
  api_version: z.literal("2"),
  network: V2NetworkSchema,
  snapshot: V2SnapshotSchema,
  freshness: V2FreshnessSchema,
});

export const V2CoverageSchema = z
  .object({
    from_block: V2HeightSchema,
    through_block: V2HeightSchema,
    contiguous: z.literal(true),
  })
  .strict()
  .refine((value) => BigInt(value.from_block) <= BigInt(value.through_block));

export const V2EcosystemNetuidSchema = z.int().min(0).max(4095);
const counterPattern = /^(0|[1-9][0-9]{0,19})$/;
export const V2RegistrationCounterSchema = z
  .string()
  .regex(counterPattern)
  .refine(
    (value) =>
      counterPattern.test(value) && BigInt(value) <= 18446744073709551614n,
  );
export const V2SubnetGenerationSchema = z
  .object({
    netuid: V2EcosystemNetuidSchema,
    registration_counter: V2RegistrationCounterSchema,
  })
  .strict();
const observationSource = z.enum(["stored", "runtime_default"]);
export const V2SubnetSchema = z
  .object({
    generation: V2SubnetGenerationSchema,
    counter_source: observationSource,
    baseline_history_unqualified: z.boolean(),
    lifecycle: z.enum([
      "registered",
      "started",
      "pending_dissolution",
      "dissolving",
    ]),
    operational: z.boolean(),
    current_registration_block: z
      .object({
        value: z.int().min(0).max(4294967295),
        source: observationSource,
      })
      .strict(),
    pricing_mode_code: z
      .object({ value: z.int().min(0).max(65535), source: observationSource })
      .strict(),
    mechanism_count: z
      .object({ value: z.int().min(1).max(16), source: observationSource })
      .strict()
      .nullable(),
    mechanism_availability: z.enum(["current", "unavailable_during_cleanup"]),
    mechanisms: z
      .array(
        z
          .object({
            mechanism_id: z.int().min(0).max(15),
            storage_index: z.int().min(0).max(65535),
          })
          .strict(),
      )
      .max(16),
  })
  .strict()
  .refine((value) => {
    const { netuid, registration_counter } = value.generation;
    if (
      value.operational !==
        ["registered", "started"].includes(value.lifecycle) ||
      value.baseline_history_unqualified !==
        (netuid !== 0 && registration_counter === "0") ||
      (value.counter_source === "runtime_default" &&
        registration_counter !== "0") ||
      (value.current_registration_block.source === "runtime_default" &&
        value.current_registration_block.value !== 0) ||
      (value.pricing_mode_code.source === "runtime_default" &&
        value.pricing_mode_code.value !== 0)
    )
      return false;
    if (value.mechanism_availability === "unavailable_during_cleanup")
      return (
        value.lifecycle === "dissolving" &&
        value.mechanism_count === null &&
        value.mechanisms.length === 0
      );
    const count = value.mechanism_count;
    return (
      count !== null &&
      value.mechanisms.length === count.value &&
      (count.source !== "runtime_default" ||
        (count.value === 1 && value.lifecycle !== "dissolving")) &&
      value.mechanisms.every(
        (mechanism, index) =>
          mechanism.mechanism_id === index &&
          mechanism.storage_index === netuid + index * 4096,
      )
    );
  }, "Subnet observation does not match its generation, lifecycle or mechanism geometry");

const revision = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const netuidList = z
  .array(V2EcosystemNetuidSchema)
  .max(4096)
  .refine((values) =>
    values.every((value, index) => index === 0 || value > values[index - 1]),
  );
export const V2EcosystemSchema = z
  .object({
    publication_id: V2DigestSchema,
    generation: V2HeightSchema,
    source_id: V2DigestSchema,
    candidate_id: V2DigestSchema,
    block_publication_id: V2DigestSchema,
    projection_contract: z.literal(1),
    producer_revision: revision,
    profile_revision: z.string().regex(/^[a-z][a-z0-9-]{0,95}$/),
    upstream_revision: revision,
    observed_at: V2TimestampSchema,
    published_at: V2TimestampSchema,
    qualification: z.literal("source_reviewed_candidate"),
    state_proof_verified: z.literal(false),
    runtime_semantics_attested: z.literal(false),
    enumeration_complete: z.literal(true),
    reportable_mechanisms_complete: z.boolean(),
    operational_netuids: netuidList.refine((values) => values[0] === 0),
    residual_storage_netuids: netuidList,
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
  .strict()
  .refine(
    (value) =>
      value.state.observed_at === value.observed_at &&
      !value.residual_storage_netuids.some((id) =>
        value.operational_netuids.includes(id),
      ),
  );

export const V2EcosystemFreshnessSchema = V2FreshnessSchema.extend({
  target_seconds: z.literal(900),
  target_blocks: z.null(),
});
export const V2EcosystemEnvelopeSchema = z
  .object({
    api_version: z.literal("2"),
    network: V2NetworkSchema,
    snapshot: V2SnapshotSchema,
    ecosystem: V2EcosystemSchema,
    freshness: V2EcosystemFreshnessSchema,
  })
  .superRefine((value, context) => {
    if (
      value.snapshot.block_number !== value.ecosystem.state.block_number ||
      value.snapshot.block_hash !== value.ecosystem.state.block_hash ||
      value.snapshot.publication_id !== value.ecosystem.block_publication_id
    )
      context.addIssue({
        code: "custom",
        message: "Execution and state do not select the same canonical block",
      });
  });

/** A row belongs to this exact publication's reportable/operational projection. */
export function isV2SubnetAtEcosystem(
  subnet: z.infer<typeof V2SubnetSchema>,
  envelope: z.infer<typeof V2EcosystemEnvelopeSchema>,
): boolean {
  const id = subnet.generation.netuid;
  return (
    BigInt(subnet.current_registration_block.value) <=
      BigInt(envelope.snapshot.block_number) &&
    subnet.operational ===
      envelope.ecosystem.operational_netuids.includes(id) &&
    !envelope.ecosystem.residual_storage_netuids.includes(id) &&
    (subnet.mechanism_availability === "current" ||
      !envelope.ecosystem.reportable_mechanisms_complete)
  );
}

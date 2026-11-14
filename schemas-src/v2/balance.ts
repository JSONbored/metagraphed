import { z } from "zod";
import {
  V2DigestSchema,
  V2EnvelopeSchema,
  V2FreshnessSchema,
  V2HashSchema,
  V2HeightSchema,
  V2NetworkIdSchema,
  V2TimestampSchema,
} from "./primitives.ts";

const hash = V2HashSchema.length(66);
const digest = V2DigestSchema.length(64);
const revision = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
  .refine((value) => value.length === 40 || value.length === 64);
const uint = (bits: 32 | 64 | 128) =>
  z
    .string()
    .max(39)
    .refine((value) => {
      if (value.length > 39 || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
      const number = BigInt(value);
      return number.toString() === value && number < 1n << BigInt(bits);
    });

export const V2AccountInfoSchema = z
  .object({
    account_id: hash,
    nonce: uint(32),
    consumers: uint(32),
    providers: uint(32),
    sufficients: uint(32),
    free_rao: uint(64),
    reserved_rao: uint(64),
    frozen_rao: uint(64),
    flags: uint(128),
  })
  .strict();

export const V2AccountBalanceInputSchema = z
  .object({
    network: V2NetworkIdSchema.refine((value) => !/\s/.test(value)),
    account_id: hash,
    publication_id: digest.optional(),
  })
  .strict();

const result = z
  .discriminatedUnion("status", [
    z
      .object({ status: z.literal("stored"), account: V2AccountInfoSchema })
      .strict(),
    z
      .object({
        status: z.literal("not_stored"),
        runtime_default: V2AccountInfoSchema,
      })
      .strict(),
  ])
  .refine(
    (value) =>
      value.status === "stored" ||
      ((
        [
          "nonce",
          "consumers",
          "providers",
          "sufficients",
          "free_rao",
          "reserved_rao",
          "frozen_rao",
        ] as const
      ).every((field) => value.runtime_default[field] === "0") &&
        value.runtime_default.flags ===
          "170141183460469231731687303715884105728"),
  );

// Independently admit the reviewed semantics; a revision-shaped string alone
// cannot promote unknown runtime metadata into qualified account quantities.
const profiles = {
  "subtensor-486-account-info-v1": {
    spec: 486,
    metadata:
      "142e2f2735d9585567fd71e080554a2a0ec10d4ad0bcedb4993e87e473ddd852",
    upstream: "8b2a978a98c0d94300dd7c68b190b24b974b7d02",
  },
  "subtensor-488-account-info-v1": {
    spec: 488,
    metadata:
      "66804d7b7f326f3285f900a1533df30c17ffa1d2855a5c3f3559ae05471446b7",
    upstream: "b6a81d144078eac18bd25c3af7cb31579bb670f3",
  },
} as const;

export const V2AccountBalanceSchema = V2EnvelopeSchema.extend({
  account_id: hash,
  balance: z
    .object({
      publication_id: digest,
      generation: V2HeightSchema.refine((value) => value !== "0"),
      request_id: digest,
      observation_id: digest,
      projection_contract: z.literal(1),
      decoder_revision: revision,
      profile_revision: z.enum([
        "subtensor-486-account-info-v1",
        "subtensor-488-account-info-v1",
      ]),
      upstream_revision: revision,
      block_publication_id: digest,
      observed_at: V2TimestampSchema,
      published_at: V2TimestampSchema,
      lookup_scope: z.literal("exact_keys"),
      unit: z.literal("rao"),
      qualification: z.literal("reviewed_source_metadata_candidate"),
      state_proof_verified: z.literal(false),
      runtime_semantics_attested: z.literal(false),
      state: z
        .object({
          snapshot_id: digest,
          block_number: V2HeightSchema,
          block_hash: hash,
          metadata_digest: digest,
          spec_version: z.int().min(0).max(4294967295),
          transaction_version: z.literal(1),
          producer_revision: revision,
          observed_at: V2TimestampSchema,
        })
        .strict(),
    })
    .strict(),
  freshness: V2FreshnessSchema.extend({
    target_seconds: z.literal(30),
    target_blocks: z.literal(2),
  }),
  result,
})
  .strict()
  .refine((value) => {
    const account =
      value.result.status === "stored"
        ? value.result.account
        : value.result.runtime_default;
    const { balance, snapshot } = value;
    const profile = profiles[balance.profile_revision];
    return (
      account.account_id === value.account_id &&
      value.network.genesis_hash ===
        "0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03" &&
      snapshot.block_number === balance.state.block_number &&
      snapshot.block_hash === balance.state.block_hash &&
      snapshot.publication_id === balance.block_publication_id &&
      balance.observed_at === balance.state.observed_at &&
      balance.state.spec_version === profile.spec &&
      balance.state.metadata_digest === profile.metadata &&
      balance.upstream_revision === profile.upstream
    );
  }, "Balance result, reviewed state profile and captured execution must agree");

export type V2AccountBalance = z.infer<typeof V2AccountBalanceSchema>;

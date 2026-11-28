// GET /api/v1/subnets/{netuid}/commitments and
// GET /api/v1/subnets/{netuid}/commitments/{hotkey} (MET-7365, runtime spec
// 497). What each subnet's miners and validators publish on chain --
// Commitments.CommitmentOf, a deposit and a list of Data fields, and
// Commitments.RevealedCommitments, the timelocked payloads the chain has
// revealed -- served live from state.commitments (migration 0061).
import { z } from "zod";

const HEX = /^0x(?:[0-9a-f]{2})*$/;

export const CommitmentFieldSchema = z
  .object({
    kind: z
      .enum([
        "none",
        "raw",
        "big_raw",
        "blake2_256",
        "sha256",
        "keccak256",
        "sha3_256",
        "timelock",
        "timelock_failed",
        "reset_bonds",
      ])
      .describe(
        "The Data variant: `raw` (up to 128 bytes) and `big_raw` bytes; a BLAKE2-256, SHA-256, Keccak-256 or SHA3-256 hash; a `timelock` ciphertext the chain reveals at its drand round, or one whose reveal failed; the bonds-reset flag; or `none`.",
      ),
    hex: z
      .string()
      .regex(HEX)
      .nullable()
      .describe(
        "The field's bytes as 0x-prefixed lowercase hex. Null for `none` and `reset_bonds`, which carry none.",
      ),
    text: z
      .string()
      .nullable()
      .describe(
        "The bytes as UTF-8 text, when they are printable. Null for binary bytes and for fields with none.",
      ),
    reveal_round: z
      .int()
      .min(0)
      .nullable()
      .describe("A timelock's drand round. Null for every other kind."),
  })
  .strict()
  .describe("One Data field of a commitment, as the chain holds it.");

export const CommitmentRevealSchema = z
  .object({
    block: z.int().min(0).describe("The block the chain revealed it at."),
    hex: z
      .string()
      .regex(HEX)
      .describe("The revealed payload as the chain keeps it, 0x-prefixed hex."),
    text: z
      .string()
      .nullable()
      .describe(
        "The revealed payload as UTF-8 text, when it is printable. The chain keeps a reveal as SCALE bytes, so this is the payload inside them.",
      ),
  })
  .strict()
  .describe("One revealed timelock commitment.");

export const CommitmentSchema = z
  .object({
    block: z
      .int()
      .min(0)
      .describe(
        "The block the chain stamped the commitment with when it was set.",
      ),
    deposit: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,19})$/)
      .describe(
        "The deposit reserved for it, in rao (u64 atomic units as a decimal string).",
      ),
    fields: z
      .array(CommitmentFieldSchema)
      .describe("Its Data fields, in the order they were committed."),
  })
  .strict()
  .describe("A hotkey's commitment on one subnet (Commitments.CommitmentOf).");

const rangeFields = {
  valid_from: z
    .int()
    .min(0)
    .describe(
      "The first capture block at which this state was observed. The capture is hourly, so the change happened in the 300 or so blocks before it; `commitment.block` is the chain's own.",
    ),
};

const valueFields = {
  commitment: CommitmentSchema.nullable().describe(
    "The commitment, or null when the hotkey holds reveals but no commitment.",
  ),
  reveals: z
    .array(CommitmentRevealSchema)
    .describe(
      "The hotkey's revealed timelock commitments on this subnet, in the chain's order. Empty when it has none.",
    ),
};

export const SubnetCommitmentEntrySchema = z
  .object({
    hotkey: z.string().describe("The committing hotkey, SS58."),
    ...rangeFields,
    ...valueFields,
  })
  .strict()
  .describe("One hotkey's current commitment and reveals on the subnet.");

export const CommitmentStateSchema = z
  .object({
    ...rangeFields,
    valid_to: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "The first capture block at which another state was observed, or none (exclusive). Null while it is current.",
      ),
    ...valueFields,
  })
  .strict()
  .describe("One hotkey's commitment and reveals with their validity range.");

const observedFields = {
  observed_block: z
    .int()
    .min(0)
    .nullable()
    .describe(
      "The newest finalized block the capture read every subnet's commitments at. Null when no capture has been observed (store unbound, or the capture has not run): the response then carries no commitments at all.",
    ),
  observed_at: z
    .string()
    .nullable()
    .describe("When that capture ran, as an ISO timestamp."),
};

export const SubnetCommitmentsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    ...observedFields,
    total: z
      .int()
      .min(0)
      .nullable()
      .describe(
        "How many hotkeys hold a commitment or reveals on this subnet at the observed block. Null with no observation.",
      ),
    limit: z.int().min(1),
    offset: z.int().min(0),
    commitments: z
      .array(SubnetCommitmentEntrySchema)
      .describe(
        "One page of them, the most recently committed first (hotkeys with only reveals last), then by public key.",
      ),
  })
  .strict()
  .describe(
    "A subnet's current on-chain commitments and reveals from chain storage (runtime spec 497). Mirrors GET /api/v1/subnets/{netuid}/commitments.",
  );

export const HotkeyCommitmentArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    hotkey: z.string().describe("The hotkey, SS58."),
    ...observedFields,
    exists: z
      .boolean()
      .nullable()
      .describe(
        "Whether the chain held a commitment or reveals for this hotkey on this subnet at the observed block. Null with no observation.",
      ),
    current: CommitmentStateSchema.nullable().describe(
      "Its current commitment and reveals, or null when the chain holds none at the observed block.",
    ),
    history: z
      .array(CommitmentStateSchema)
      .describe(
        "Every state it has had on this subnet since the capture began, newest first, at most 100.",
      ),
  })
  .strict()
  .describe(
    "One hotkey's on-chain commitment on one subnet, with its history (runtime spec 497). Mirrors GET /api/v1/subnets/{netuid}/commitments/{hotkey}.",
  );

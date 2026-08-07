// MCP tool `get_neuron_history`.
// Mirrors GET /api/v1/subnets/{netuid}/neurons/{uid}/history.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// What the copies were publishing:
//   get_neuron_history: 1 bare `{"type":"object"}` site.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import {
  NeuronFieldsInputSchema,
  OpenObjectSchema,
  accountKeySchema,
  netuidSchema,
  uidSchema,
  windowSchema,
} from "./shared.ts";
import { NeuronHistoryArtifactSchema } from "../routes/subnet-metagraph.ts";

// EXACTLY ONE of `uid` / `hotkey` identifies the neuron (#9872), and that is
// PUBLISHED rather than only described.
//
// `oneOf` of two `required` branches is exactly-one, not at-least-one: passing
// both matches both branches, and matching two branches fails `oneOf`. It
// reaches the wire through `.meta()`, which z.toJSONSchema merges into the
// emitted schema -- `.refine()` would not, because a refinement has no JSON
// Schema form and Zod emits the base object regardless.
//
// The handler still enforces it (this server validates arguments in the
// handler by design, #8942). The published constraint is what an agent READS
// before calling; the handler is what makes the reading true.
export const GetNeuronInputSchema = z
  .object({
    netuid: netuidSchema(),
    uid: uidSchema()
      .optional()
      .describe(
        "The neuron's UID — its slot number within this subnet. Give this " +
          "OR `hotkey`, not both. A UID is REUSED after a deregistration, so " +
          "it identifies a slot rather than an operator; if what you have is " +
          "a key from a subnet API, a dashboard or a wallet, pass `hotkey`.",
      ),
    hotkey: accountKeySchema("hotkey")
      .optional()
      .describe(
        "The neuron's SS58 hotkey — the stable way to name an operator, and " +
          "the identifier every off-chain system uses. Give this OR `uid`, " +
          "not both. Returns `neuron: null` when the hotkey holds no UID on " +
          "this subnet, which is the answer to 'is it still registered'.",
      ),
    // #9082: narrow each returned row to these fields. Omit for the full
    // row. Valid names are NeuronSchema's own, so this enum cannot drift
    // from what the route can project.
    fields: NeuronFieldsInputSchema.meta({ examples: ["netuid,name,slug"] }),
  })
  .strict()
  .meta({ oneOf: [{ required: ["uid"] }, { required: ["hotkey"] }] });
export type GetNeuronInput = z.infer<typeof GetNeuronInputSchema>;

export const GetNeuronOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    neuron: OpenObjectSchema.nullable(),
  })
  .passthrough();
export type GetNeuronOutput = z.infer<typeof GetNeuronOutputSchema>;

export const GetNeuronHistoryInputSchema = z
  .object({
    netuid: netuidSchema(),
    uid: uidSchema(),
    window: windowSchema(["7d", "30d", "90d", "1y", "all"]).optional(),
  })
  .strict();
export type GetNeuronHistoryInput = z.infer<typeof GetNeuronHistoryInputSchema>;

export const GetNeuronHistoryOutputSchema = NeuronHistoryArtifactSchema;
export type GetNeuronHistoryOutput = z.infer<
  typeof GetNeuronHistoryOutputSchema
>;

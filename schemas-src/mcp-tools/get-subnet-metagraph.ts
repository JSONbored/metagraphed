// MCP tool `get_subnet_metagraph` (types-epic E batch 4, #8067). Mirrors
// GET /api/v1/subnets/{netuid}/metagraph, which is not one of
// schemas-src/routes/'s covered pilot routes -- no existing Zod schema to
// reuse. Modeled fresh, shallow, from the hand-written literal it replaces.
import { z } from "zod";
import { NeuronSchema } from "../routes/subnet-metagraph.ts";
import {
  NEURON_SORT_FIELD_NAMES,
  NEURON_SORT_NULLS_LAST_NOTE,
  NeuronFieldsInputSchema,
  accountKeySchema,
  netuidSchema,
} from "./shared.ts";

export const GetSubnetMetagraphInputSchema = z
  .object({
    netuid: netuidSchema(),
    validator_permit: z
      .boolean()
      .optional()
      .describe(
        "Restrict to neurons that hold (`true`) or lack (`false`) a validator permit.",
      )
      .meta({ examples: [true] }),
    // --- row selection (#9872) ---------------------------------------------
    //
    // The row count is the dominant cost of this tool, not the column count:
    // a three-field projection of subnet 53 still came back at ~24k tokens
    // because a hotkey is 48 characters and there are 256 of them. `fields`
    // is a column fix for a row problem, so these five parameters cut rows.
    hotkeys: z
      .array(accountKeySchema("hotkey"))
      .min(1)
      .optional()
      .describe(
        "Return only the neurons holding these hotkeys. This is the lookup " +
          "to use when you know a hotkey and want its row: every off-chain " +
          "system (a subnet's own API, a dashboard, wallet tooling) " +
          "identifies a miner by hotkey, while `uid` is an internal slot " +
          "number that is REUSED after deregistration. A hotkey that is not " +
          "registered on this subnet is simply absent from the result — that " +
          "is the answer to 'is it registered', not an error.",
      )
      .meta({
        examples: [["5CDYzuoN75FE8fBEJ3A587zsra9ee7xBLEwxrSgSpB3s4nsp"]],
      }),
    active: z
      .boolean()
      .optional()
      .describe(
        "Restrict to neurons the chain marks active (`true`) or inactive (`false`).",
      )
      .meta({ examples: [true] }),
    min_incentive: z
      .number()
      .min(0)
      .optional()
      .describe(
        "Drop neurons whose `incentive` is below this floor (inclusive, so " +
          "`min_incentive: 0` keeps the whole zero-incentive population — " +
          "which on most subnets is the majority). Rows with a null " +
          "`incentive` never pass a floor. For 'only the neurons actually " +
          "earning', either pass a small positive floor, or use `sort_by: " +
          '"incentive"` with a `limit`, which needs no threshold at all.',
      )
      .meta({ examples: [0.001] }),
    sort_by: z
      .enum(NEURON_SORT_FIELD_NAMES)
      .optional()
      .describe(
        `Order the rows by one numeric field. ${NEURON_SORT_NULLS_LAST_NOTE} ` +
          "Omit to keep the snapshot's own UID order.",
      )
      .meta({ examples: ["incentive"] }),
    order: z
      .enum(["asc", "desc"])
      .optional()
      .describe(
        "Sort direction for `sort_by`; defaults to `desc`, because the " +
          "question a sort usually answers here is 'who is at the top'. " +
          "Ignored when `sort_by` is omitted.",
      )
      .meta({ examples: ["desc"] }),
    limit: z
      .int()
      .min(1)
      .optional()
      .describe(
        "Return at most this many neurons, applied AFTER any filter and " +
          "sort. There is deliberately no default: omitting it returns the " +
          "whole snapshot, exactly as this tool always has. Pair it with " +
          "`sort_by` — a limit on unsorted rows just truncates by UID.",
      )
      .meta({ examples: [12] }),
    // #9082: narrow each returned row to these fields. Omit for the full
    // row. Valid names are NeuronSchema's own, so this enum cannot drift
    // from what the route can project.
    fields: NeuronFieldsInputSchema.meta({ examples: ["netuid,name,slug"] }),
  })
  .strict();
export type GetSubnetMetagraphInput = z.infer<
  typeof GetSubnetMetagraphInputSchema
>;

export const GetSubnetMetagraphOutputSchema = z
  .object({
    schema_version: z.int().optional(),
    netuid: netuidSchema(),
    neuron_count: z
      .int()
      .describe(
        "How many neurons are in `neurons` — the count AFTER any filter, " +
          "sort or limit, so it always equals `neurons.length`. When that is " +
          "fewer than the snapshot holds, `total_neuron_count` says how many " +
          "there were.",
      ),
    // Emitted only when a selection parameter actually removed rows (#9872).
    // Without it a filtered call answers `neuron_count: 12` for a 256-neuron
    // subnet, which reads as a measurement of the subnet rather than of the
    // response -- the same confident-zero failure #9307 is about.
    total_neuron_count: z
      .int()
      .optional()
      .describe(
        "How many neurons the snapshot holds before `hotkeys`/`active`/" +
          "`min_incentive`/`limit` were applied. Present only when one of " +
          "them removed rows; its absence means `neuron_count` is the whole " +
          "snapshot.",
      ),
    captured_at: z.string().nullable().optional(),
    block_number: z.int().nullable().optional(),
    // Typed from the route's own NeuronSchema (#9797), PARTIAL because this
    // tool advertises `fields`: a caller who projects the row must still
    // satisfy the schema the tool publishes, which is the contract #9884
    // restored after the derivation in #9855/#9859 broke it. Verified against
    // production 2026-08-07, whole and projected.
    neurons: z.array(NeuronSchema.partial()),
  })
  .strict();
export type GetSubnetMetagraphOutput = z.infer<
  typeof GetSubnetMetagraphOutputSchema
>;

// GET /api/v1/subnets/{netuid}/mechanisms (#13162; #13161, epic #13142).
// One subnet's mechanism (sub-subnet) registry, served live from
// app.subnet_mechanisms (migration 0044) through the native store seam. The
// burn tick's Gamma capture (src/chain-gamma-capture.ts) fills it from
// MechanismCountCurrent, MechanismEmissionSplit and SubnetEpochConsensus, so
// until a store is bound and a capture observed this route serves the
// schema-stable decline below, never a fabricated zero-mechanism subnet.
import { z } from "zod";

export const SubnetMechanismSchema = z
  .object({
    mechid: z
      .int()
      .min(0)
      .describe(
        "The mechanism (sub-subnet) id within this subnet; 0 is the original mechanism every subnet has.",
      ),
    emission_split: z
      .number()
      .min(0)
      .max(1)
      .nullable()
      .describe(
        "This mechanism's share of the subnet's emission (0..1), as the runtime splits it: its SubtensorModule.MechanismEmissionSplit part over u16::MAX, or an even share when the subnet stores no split for its mechanism count. Null when not captured -- never fabricated as 0, which would claim a measured zero share.",
      ),
    consensus_mode: z
      .string()
      .nullable()
      .describe(
        "The consensus this mechanism's epoch runs, spelled as the chain spells it: the subnet's SubtensorModule.SubnetEpochConsensus (`yuma` or `null`), which every mechanism of the subnet runs. Null when not captured.",
      ),
    captured_at: z.string().nullable(),
  })
  .strict()
  .describe(
    "One mechanism (sub-subnet) of a subnet: its id, emission split, consensus mode and capture stamp.",
  );

export const SubnetMechanismsArtifactSchema = z
  .object({
    schema_version: z.int(),
    netuid: z.int().min(0),
    /**
     * NULL IS THE DECLINE, and 0 is deliberately not expressible. Every subnet
     * has at least mechanism 0, so "zero mechanisms" is never a measurement --
     * it is what an unbound or unfilled store looks like, and publishing it as
     * a count would be the confident-zero failure the neuron surfaces' own
     * comments are about. An empty `mechanisms` with a null count reads as
     * "not captured", which is today's truthful answer everywhere.
     */
    mechanism_count: z
      .int()
      .min(1)
      .nullable()
      .describe(
        "How many mechanisms this subnet has -- `mechanisms.length`. NULL when the mechanism registry holds no rows for this subnet (store unbound, or the per-mechanism capture has not run): every subnet has at least mechanism 0, so a zero count is never a measurement and is not published.",
      ),
    captured_at: z.string().nullable(),
    mechanisms: z
      .array(SubnetMechanismSchema)
      .describe("The subnet's mechanisms, ordered by mechid."),
  })
  .strict()
  .describe(
    "One subnet's mechanism (sub-subnet) registry (#13162). Empty with a null mechanism_count until a mechanism capture is observed. Mirrors GET /api/v1/subnets/{netuid}/mechanisms.",
  );

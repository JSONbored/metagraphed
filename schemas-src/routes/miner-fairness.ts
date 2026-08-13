// GET /api/v1/subnets/{netuid}/miner-fairness (#10931).
//
// The served shape of src/miner-fairness.ts. THE ONE SCHEMA — REST publishes it
// through openapi.json, the MCP tool's outputSchema IS this artifact schema by
// identity, and the GraphQL type is generated from it.
//
// TWO THINGS THE DESCRIPTIONS HAVE TO CARRY, because a reader of the OpenAPI
// alone will not have the module header:
//
//   1. THE SERIES IS THE POINT. `emission_tao` on one day is a per-tempo rate,
//      so a UID paid on a different tempo reads as a zero that day. Every
//      figure here is over the window, and `days_covered` says how much window
//      there was. "Earned on 0 of 31 days" and "earned on 3 of 31" are the two
//      facts a snapshot collapses into one.
//   2. THERE IS NO SCORE, DELIBERATELY. A high Gini on a subnet whose task
//      genuinely has one best answer is not misconduct. The distribution is the
//      product; a grade would be an opinion this data cannot defend per subnet.
//
// The concentration lenses reuse the shared ConcentrationMetricsSchema rather
// than re-declaring gini/hhi/nakamoto — the same reason the builder imports
// computeConcentration instead of reimplementing it.
import { z } from "zod";
import {
  ConcentrationMetricsSchema,
  FieldSourcesSchema,
  subnetHistoryArtifactSchema,
} from "../shared.ts";

const MinerFairnessPointSchema = z
  .object({
    snapshot_date: z.string(),
    miner_count: z.int().min(0).meta({
      description:
        "Non-validator UIDs registered on this day. This is the number every leaderboard publishes as 'miners'.",
    }),
    earning_miner_count: z.int().min(0).meta({
      description:
        "How many of them recorded emission above zero. Against `miner_count` this is the fact a miner count alone hides — on the median subnet almost none of the registered miners earn on a given day.",
    }),
    zero_emission_pct: z.number().nullable().optional().meta({
      description:
        "Fraction of this day's miner UIDs that earned nothing. Null — never 0 — on a day with no miner UIDs at all, because 0% over an empty population reads as 'everybody earned'. A SINGLE DAY OVERSTATES this: emission is a per-tempo rate and a UID paid on a different tempo reads as a zero here. Use the persistence block for the durable version.",
    }),
  })
  .strict();

const PersistenceSchema = z
  .object({
    never_earned_count: z.int().min(0).meta({
      description:
        "Miner UIDs that earned on ZERO days of the window. Distinct from the daily zero rate: this is the population that is not in the game at all, rather than the one that missed a tempo.",
    }),
    earned_every_day_count: z.int().min(0).meta({
      description:
        "Miner UIDs that earned on every day they were registered for.",
    }),
    median_earning_days: z.number().nullable().optional().meta({
      description:
        "The typical miner's earning days across the window. Null on an empty population — the median of nothing is not zero, and zero would read as 'the typical miner earned on no days'.",
    }),
    max_earning_days: z.number().nullable().optional(),
  })
  .strict();

const FairnessConcentrationSchema = z
  .object({
    entity: ConcentrationMetricsSchema.optional().meta({
      description:
        "THE HEADLINE LENS: emission concentration across controlling entities (coldkeys), with each entity's UIDs summed. A subnet with three operators behind 256 UIDs is not diverse, and the per-UID lens alone hides exactly that.",
    }),
    uid: ConcentrationMetricsSchema.optional().meta({
      description:
        "The same measures per UID, published beside the entity lens rather than instead of it. Where the two diverge, several UIDs share an operator.",
    }),
  })
  .strict();

export const SubnetMinerFairnessArtifactSchema = subnetHistoryArtifactSchema(
  MinerFairnessPointSchema,
)
  .extend({
    days_covered: z.int().min(0).meta({
      description:
        "How many days the series actually covers. Published beside every distribution figure: a distribution over 3 days and one over 31 are not the same claim, and `neuron_daily` is only ~27-33 days deep, so a 90d window is answered with the depth found rather than refused.",
    }),
    miner_uid_count: z.int().min(0).meta({
      description:
        "Distinct non-validator UIDs seen anywhere in the window — the denominator for the persistence block.",
    }),
    persistence: PersistenceSchema.optional(),
    entity_count: z.int().min(0).meta({
      description:
        "Distinct controlling addresses behind those UIDs, keyed on the `coldkey` field. A UID with no owner recorded counts as its own entity, so this never under-counts unknown owners — merging them would make a subnet look more concentrated than it is.",
    }),
    uids_per_entity: z.number().nullable().optional().meta({
      description:
        "Miner UIDs per controlling entity. 1.0 = every UID a distinct owner; higher = fewer operators each running many hotkeys. The network median is ~3.08 and the maximum ~21.3, so '256 miners' is routinely far fewer operators.",
    }),
    concentration: FairnessConcentrationSchema.optional(),
    field_sources: FieldSourcesSchema.optional(),
  })
  .describe(
    "Whether a subnet's registered miners actually earn, measured over a 7d/30d/90d window rather than from a snapshot. Reports the daily zero-emission rate, how many days each miner UID earned on (persistent-zero and occasionally-zero are different facts a snapshot collapses), and emission concentration across controlling entities as the headline lens with the per-UID lens beside it. DESCRIPTIVE ONLY — there is no fairness score and no grade: a high Gini on a subnet whose task genuinely has one best answer is not misconduct, and that context is not in this data. A subnet with no daily rollup resolves to a schema-stable empty series (days_covered 0), never null. Mirrors GET /api/v1/subnets/{netuid}/miner-fairness.",
  );

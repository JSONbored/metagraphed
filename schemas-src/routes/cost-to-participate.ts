// GET /api/v1/subnets/{netuid}/cost-to-participate (#10932 phase 1).
//
// The served shape of src/cost-to-participate.ts. THE ONE SCHEMA -- REST
// publishes it through openapi.json, the MCP tool's outputSchema IS this
// artifact schema by identity, and the GraphQL type is generated from it. The
// GPU vocabulary and the evidence shape are IMPORTED from schemas-src/compute.ts
// rather than restated.
//
// THE DESCRIPTIONS CARRY THE ARGUMENT. This card sits one careless sentence
// away from "it costs $45/day to mine here", which is the claim the rescope of
// #10932 exists to stop being made: a declared minimum is the floor to RUN, and
// on a subnet where most miners earn nothing it is precisely the configuration
// that does not win.
import {
  DECLARATIONS_REQUIRING_A_GPU,
  MIN_COMPUTE_SURFACES_REGISTERED,
  SUBNETS_IN_REGISTRY,
  SUBNETS_WITHOUT_A_DECLARATION,
  SURFACES_ON_A_MOVING_REF,
} from "../../src/compute-declaration-figures.ts";
import { z } from "zod";
import {
  ComputeDeclarationEvidenceSchema,
  GpuRequirementSchema,
} from "../compute.ts";
import { FieldSourcesSchema } from "../shared.ts";

const DeclaredGpuSchema = z
  .object({
    requirement: GpuRequirementSchema.nullable().meta({
      description:
        "Does this role need a GPU, as the DECLARATION supports it? FOUR answers. `required` and `not-required` are what they say. `declared-inconsistently` is a declared `required: False` sitting beside a non-zero minimum VRAM, CUDA-core or GPU count — the shape an unedited template field takes beside an edited one, and never coerced to either boolean. `null` means no GPU stanza was declared at all, which is not a 'no'.",
    }),
    declared_required: z.boolean().nullable().optional().meta({
      description:
        "The file's own `required:` value, published verbatim so a reader can see why `requirement` is not a boolean rather than take our word for it.",
    }),
    declared_min_vram_gb: z.number().nullable().optional().meta({
      description:
        "The file's own `min_vram`, in the GB the template asks for. Not converted, not rounded — a declaration we alter is no longer the subnet's declaration.",
    }),
    declared_min_count: z.number().nullable().optional(),
    declared_model: z.string().nullable().optional().meta({
      description:
        "The file's own `recommended_gpu`. RECOMMENDED, not required: naming a card for a workload that does not need one is coherent, so this never moves `requirement` on its own.",
    }),
  })
  .strict();

const DeclaredRoleSpecSchema = z
  .object({
    gpu: DeclaredGpuSchema,
    cpu: z
      .object({
        min_cores: z.number().nullable().optional(),
        min_speed_ghz: z.number().nullable().optional(),
        architecture: z.string().nullable().optional(),
      })
      .strict(),
    memory: z
      .object({
        min_ram_gb: z.number().nullable().optional(),
        min_swap_gb: z.number().nullable().optional(),
      })
      .strict(),
    storage: z
      .object({
        min_space_gb: z.number().nullable().optional(),
        min_iops: z.number().nullable().optional(),
        type: z.string().nullable().optional(),
      })
      .strict(),
    network: z
      .object({
        min_download_speed_mbps: z.number().nullable().optional(),
        min_upload_speed_mbps: z.number().nullable().optional(),
      })
      .strict(),
  })
  .strict()
  .describe(
    "One role's DECLARED minimum, in the subnet's own numbers. Units are carried in the field names; nothing is converted or defaulted. This is the floor to RUN, never the spec to EARN.",
  );

const ServedDeclarationSchema = z
  .object({
    evidence: ComputeDeclarationEvidenceSchema.meta({
      description: `The citation. \`read_at_sha\` is the commit that was HEAD when the file was read — ${SURFACES_ON_A_MOVING_REF} of the ${MIN_COMPUTE_SURFACES_REGISTERED} registered surfaces point at \`main\`, which moves under the claim.`,
    }),
    found: z.boolean().meta({
      description:
        "Did the fetch yield a parseable compute_spec? `false` IS A MEASUREMENT — the file was read at that commit and declared nothing — and is distinct from a subnet that registers no min_compute surface at all, which has no declaration here.",
    }),
    miner: DeclaredRoleSpecSchema.nullable(),
    validator: DeclaredRoleSpecSchema.nullable(),
    unscoped: DeclaredRoleSpecSchema.nullable().meta({
      description:
        "Requirements this file declared WITHOUT saying whose they are — a flat `compute_spec` with no `miner`/`validator` split. Non-null only for a document that made no role distinction, in which case `miner` and `validator` are both null because that is true of the file. Same shape as the other two, so the four-valued GPU answer reads identically. Never a guess at which role was meant: attributing an unattributed requirement is the one thing this key exists to avoid.",
    }),
  })
  .strict();

export const SubnetCostToParticipateArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    netuid: z.int().min(0),
    entry_cost: z
      .object({
        registration_cost_tao: z.number().nullable().optional().meta({
          description:
            "What one registration costs on this subnet right now, from `subnet_burn_history` — the same value /api/v1/subnets/{netuid}/burn serves, re-served rather than recomputed. EXACT and on-chain. Null means not read; zero is a real price (netuid 76 reads a true zero), so the two are never conflated.",
        }),
        validator_permit_floor_tao: z.number().nullable().optional().meta({
          description:
            "The stake that would currently buy a validator permit, from /api/v1/subnets/{netuid}/validator-economics. A permit is not income — see the earning floor beside it.",
        }),
        validator_earning_floor_tao: z.number().nullable().optional().meta({
          description:
            "The stake at which a validator actually starts earning dividends here. Differs from the permit floor by a median of ~7x across subnets.",
        }),
      })
      .strict()
      .describe(
        "What the CHAIN charges to enter. Exact, measured, and the only hard numbers in this card.",
      ),
    declarations_read: z
      .int()
      .min(0)
      .meta({
        description: `How many of this subnet's registered min_compute declarations have been read. ZERO IS THE IMPORTANT VALUE: ${SUBNETS_WITHOUT_A_DECLARATION} of ${SUBNETS_IN_REGISTRY} subnets register none, and a card with \`declarations_read: 0\` makes no claim about what running here takes.`,
      }),
    declared_compute: z
      .object({
        miner: DeclaredRoleSpecSchema.nullable(),
        validator: DeclaredRoleSpecSchema.nullable(),
        unscoped: DeclaredRoleSpecSchema.nullable(),
        evidence: ComputeDeclarationEvidenceSchema.nullable(),
      })
      .strict()
      .describe(
        "The headline declaration: the first read that found a spec. Miner and validator are kept apart because a subnet whose validator needs a GPU and whose miner does not is ordinary, and one answer for both would be wrong for one of them. A file that draws no such distinction publishes under `unscoped` instead, with both roles null — read all three, because which one carries the answer is a property of the document rather than of the subnet.",
      ),
    declarations: z.array(ServedDeclarationSchema).meta({
      description:
        "Every declaration read for this subnet. A subnet registering two files that disagree keeps both here rather than being collapsed to whichever was read last.",
    }),
    earnings: z
      .object({
        days_covered: z.number().nullable().optional().meta({
          description:
            "How many days the distribution beside it was measured over. A zero-rate over 3 days and one over 31 are not the same claim.",
        }),
        miner_uid_count: z.number().nullable().optional(),
        zero_emission_pct: z.number().nullable().optional().meta({
          description:
            "The share of this subnet's miner UIDs that earned nothing on the most recent day, as a fraction. The network median is 0.992.",
        }),
        never_earned_count: z.number().nullable().optional(),
        median_earning_days: z.number().nullable().optional(),
      })
      .strict()
      .nullable()
      .describe(
        "What miners here actually earned, projected from /api/v1/subnets/{netuid}/miner-fairness — never recomputed. Present so a floor-to-run can never sit on the page without the distribution that says whether running is worth it. Deliberately carries NO mean earning: that would invite exactly the cost-minus-revenue arithmetic these numbers do not support.",
      ),
    not_modelled: z.array(z.string()).meta({
      description:
        "What this card does NOT account for, served in the payload rather than left on a docs page — so an agent quoting the numbers carries the caveats with them.",
    }),
    field_sources: FieldSourcesSchema.optional(),
  })
  .strict()
  .describe(
    `What one subnet says it takes to participate, and what the chain charges to enter. Three kinds of number, not interchangeable: \`entry_cost\` is measured on chain and exact; \`declared_compute\` is what the subnet's own min_compute file SAYS, from a template that is filled in inconsistently; \`earnings\` is what miners there actually earned. NO COST PER DAY IS PUBLISHED — of the ${MIN_COMPUTE_SURFACES_REGISTERED} registered declarations ${DECLARATIONS_REQUIRING_A_GPU} ask for a GPU, so crossing the fleet with a rental rate priced hardware most subnets never asked for. A declared minimum is the floor to RUN, not the spec to EARN. Mirrors GET /api/v1/subnets/{netuid}/cost-to-participate.`,
  );

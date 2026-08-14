// #10932: how a surface is allowed to talk about what it costs to participate
// in a subnet.
//
// Sibling of schemas-src/treasury.ts. The vocabulary lives here so the route
// schema, the builder and the MCP tool all import one statement of it rather
// than three that can drift.
//
// ## THE GPU ANSWER IS NOT A BOOLEAN
//
// All 17 registered min_compute surfaces, fetched 2026-08-13: ONE declares
// `required: True`. Seven declare `required: False`, and several of those
// declare it beside `min_vram: 8`, `cuda_cores: 1024` and
// `recommended_gpu: "NVIDIA A100"` -- which is not a subnet contradicting
// itself so much as the upstream template's own default values left unedited
// next to an edited one.
//
// That is why the third state exists and why it is not a hedge. Coercing it to
// `false` publishes "this subnet needs no GPU" on the strength of a field
// nobody touched; coercing it to `true` prices an A100 the subnet never asked
// for, which is exactly the error the original issue's worked table made on
// two of its four rows. The honest answer is that the declaration does not
// say, and the payload carries both declared values so a reader can see why.
import { z } from "zod";
import { FieldSourcesSchema } from "./shared.ts";

/**
 * Whether a role needs a GPU, as the DECLARATION supports it.
 *
 * FOUR answers, because `null` is a fourth: no declaration has been read at
 * all, which is the state 111 of 128 subnets are in and must never render as
 * "no GPU needed".
 */
export const GPU_REQUIREMENT_STATES = [
  "required",
  "not-required",
  "declared-inconsistently",
] as const;
export const GpuRequirementSchema = z.enum(GPU_REQUIREMENT_STATES);

/**
 * The citation for one reading.
 *
 * `read_at_sha` is required, for the same reason it is on a treasury reading:
 * 14 of the 17 registered surfaces point at `main`, a branch moves under the
 * claim, and what makes a reading checkable is the commit that was HEAD when
 * it was taken.
 */
export const ComputeDeclarationEvidenceSchema = z
  .object({
    source_url: z.string().meta({
      description:
        "The registered min_compute surface that was read. Points at a branch, correctly — a human clicks this and wants the current file. The pinned half is `read_at_sha`.",
    }),
    read_at_sha: z.string().min(7).meta({
      description:
        "The commit that was HEAD when the file was read. THE CITATION: it is what a re-read diffs against to know the declaration moved.",
    }),
    spec_version: z.string().nullable().optional().meta({
      description:
        "The file's own `version:` key. Worth seeing beside the spec: a subnet that has bumped it has revisited the declaration, one still on the template's default has not.",
    }),
    observed_at: z.string().meta({
      description:
        "When this reading was taken. A declared minimum with no date cannot be aged out.",
    }),
    first_seen: z.string().nullable().optional().meta({
      description: "When this file was first read, preserved across re-reads.",
    }),
  })
  .strict();

/**
 * What is NOT in this card, published IN the payload rather than only in the
 * docs (requirement 5 of #10932).
 *
 * Every entry is something a reader would otherwise assume the numbers already
 * account for. The list is served, so an agent quoting the card carries the
 * caveats with it instead of leaving them behind on a docs page.
 */
export const COST_TO_PARTICIPATE_NOT_MODELLED = [
  "A declared minimum is the floor to RUN, not the spec to EARN. On a subnet where most miners earn nothing, the minimum spec is precisely the configuration that does not win.",
  "No hardware pricing. Rental rates, ownership cost, depreciation and the difference between them are a separate decision (#10932 phase 2) and are not modelled here.",
  "No electricity, bandwidth, colocation or engineering time.",
  "No data, API or model-inference costs, which on several subnets exceed the hardware.",
  "The registration burn is the price of ONE entry at the moment it was read; it moves with demand and a deregistered UID does not get it back.",
] as const;

/**
 * One role's declared floor, reduced to the numbers a screen can sort on
 * (#11097).
 *
 * FOUR fields, not the six the issue asked for. `bare_metal_required` and
 * `static_ip_required` are absent because the template standardizes neither and
 * not one of the 39 published files carries either key (nor any spelling of
 * them): a null column for a question nobody was asked reads as "we looked and
 * they don't need it", which is the same overclaim the tri-state above exists
 * to prevent. These four are what the template asks for and the files answer.
 *
 * Units are in the names and the numbers are the file's own -- no conversion,
 * no rounding, no defaulting.
 */
export const ComputeRoleRequirementsSchema = z
  .object({
    gpu_required: GpuRequirementSchema.nullable().meta({
      description:
        "Whether this role needs a GPU, as the declaration supports it. Null means the role declared no `gpu.required` at all -- a fourth answer, and NOT a no.",
    }),
    min_vram_gb: z.number().nullable().meta({
      description:
        "Declared `gpu.min_vram`. Present beside a `not-required` GPU on several subnets, which is what makes the requirement tri-state.",
    }),
    min_ram_gb: z.number().nullable().meta({
      description: "Declared `memory.min_ram`.",
    }),
    min_storage_gb: z.number().nullable().meta({
      description: "Declared `storage.min_space`.",
    }),
    min_cores: z.number().nullable().meta({
      description: "Declared `cpu.min_cores`.",
    }),
  })
  .strict();

/**
 * The served facet: what one subnet's own min_compute file says it takes to
 * run, with the commit it was read at.
 *
 * Read from the resolved SOURCE REPO at build time, which covers 39 repos
 * against the 18 that register the file as a surface. `/cost-to-participate`
 * remains the full card for registered surfaces, read hourly into Neon; both
 * run one parser and one tri-state, so where they read the same file they agree.
 */
export const SubnetComputeRequirementsSchema = z
  .object({
    found: z.boolean().meta({
      description:
        "The file was fetched AND carried a parseable `compute_spec`. False is a reading: we opened it at that commit and it declared nothing readable. A subnet whose repo publishes no file has no facet at all (null), which is a different answer.",
    }),
    miner: ComputeRoleRequirementsSchema.nullable(),
    validator: ComputeRoleRequirementsSchema.nullable(),
    evidence: z
      .object({
        source_url: z.string().meta({
          description:
            "The raw file that was read. Points at a branch, so a human clicking it gets the current file; the pinned half is `read_at_sha`.",
        }),
        read_at_sha: z.string().min(7).meta({
          description:
            "The commit that last touched THIS PATH when the file was read -- not the branch head, so the citation moves when the declaration moves and not when the repo does.",
        }),
        path: z.string().meta({
          description:
            "Which candidate path answered. 38 of 39 repos publish `min_compute.yml`; one publishes `compute.min.yaml`.",
        }),
        spec_version: z.string().nullable().meta({
          description:
            "The file's own `version:` key. A subnet that has bumped it has revisited the declaration; one still on the template's default has not.",
        }),
        observed_at: z.string().meta({
          description: "When this reading was taken.",
        }),
      })
      .strict(),
    field_sources: FieldSourcesSchema.optional(),
  })
  .strict();

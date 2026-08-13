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

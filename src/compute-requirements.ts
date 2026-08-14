// #11097: the hardware floor a subnet declares, as a SCREENING field.
//
// ## WHY THIS EXISTS BESIDE /cost-to-participate
//
// #10932 already serves the full declaration for the subnets that REGISTER a
// min_compute surface -- 18 of 129. The hourly lane reads those, the card shows
// both roles, and none of it helps someone screening the fleet, because the
// answer is not on the bulk row and 111 subnets have no answer at all.
//
// Probing the resolved SOURCE REPO instead of the registered surface more than
// doubles the coverage: 39 of the 119 repos publish `min_compute.yml` at their
// default branch (probed 2026-08-14, every path/branch pair recorded), against
// 18 registered surfaces. A subnet does not have to register the file for us to
// be able to read what it says.
//
// ## ONE INTERPRETATION, NOT TWO
//
// The tri-state -- `required` / `not-required` / `declared-inconsistently` --
// is NOT restated here. `gpuRequirement` is imported from the module that owns
// it, so a subnet declaring `required: False` beside `min_vram: 8` gets the same
// answer on the screening row that it gets on the card, and improving that
// judgement improves both. tests/compute-requirements.test.ts asserts the two
// surfaces agree on one spec rather than trusting the import.
//
// ## WHAT THE TEMPLATE DOES NOT STANDARDIZE
//
// The issue asked for `bare_metal_required` and `static_ip_required`. Neither
// key exists in ANY of the 39 files (nor `bare_metal`, `static_ip`, or a
// spelling of either): the Bittensor template standardizes cpu / gpu / memory /
// storage / os, and 28 files carry `os` while a single one carries `docker`. So
// those two fields are not published -- inventing a null column for a question
// no subnet was asked would read as "we looked and they don't need it".
//
// The four that ARE published are the ones the template asks for and the files
// answer: gpu.min_vram (19), memory.min_ram (27), storage.min_space (28),
// cpu.min_cores (27).
import { gpuRequirement } from "./cost-to-participate.ts";
import type { ParsedComputeSpec } from "./compute-declarations-lane.ts";
import { GPU_REQUIREMENT_STATES } from "../schemas-src/compute.ts";

type Row = Record<string, unknown>;
type GpuRequirement = (typeof GPU_REQUIREMENT_STATES)[number];

/**
 * The file names actually observed across the fleet, in probe order.
 *
 * `min_compute.yml` covers 38 of the 39 repos and `compute.min.yaml` the other
 * (SN81, which spells it differently and registers it that way too). The `.yaml`
 * and `docs/` spellings have no hit today and are probed anyway: a set drawn
 * only from what has been seen goes blind the moment one repo renames its file,
 * and a 404 costs one request on a lane that runs daily.
 */
export const MIN_COMPUTE_REPO_PATHS = [
  "min_compute.yml",
  "min_compute.yaml",
  "compute.min.yaml",
  "docs/min_compute.yml",
] as const;

/** Both default-branch names. Nothing resolves the repo's real default branch
 * first because that is an api.github.com request per repo to save a raw 404
 * that costs nothing and is not rate limited. */
export const MIN_COMPUTE_BRANCHES = ["main", "master"] as const;

/** A response larger than this is not a compute spec -- same cap the registered
 * -surface lane uses, for the same reason. */
export const MIN_COMPUTE_MAX_BYTES = 256 * 1024;

export interface ComputeProbeTarget {
  url: string;
  branch: string;
  path: string;
}

/**
 * Every raw URL worth trying for one repo, branch-major.
 *
 * Branch-major because a repo on `master` answers 404 for all four paths on
 * `main` first; that ordering costs at most three extra requests on the repos
 * that use it, and keeps the common case (`main/min_compute.yml`) first.
 */
export function computeProbeTargets(
  owner: string,
  repo: string,
): ComputeProbeTarget[] {
  const targets: ComputeProbeTarget[] = [];
  for (const branch of MIN_COMPUTE_BRANCHES) {
    for (const path of MIN_COMPUTE_REPO_PATHS) {
      targets.push({
        url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`,
        branch,
        path,
      });
    }
  }
  return targets;
}

/** The declared floor for ONE role. Every field is the file's own number, in
 * the unit the template names it in -- nothing is converted, defaulted or
 * rounded, because a declaration we altered is no longer the subnet's. */
export interface ComputeRoleRequirements {
  gpu_required: GpuRequirement | null;
  min_vram_gb: number | null;
  min_ram_gb: number | null;
  min_storage_gb: number | null;
  min_cores: number | null;
}

export interface ComputeRequirementsEvidence {
  source_url: string;
  read_at_sha: string;
  path: string;
  spec_version: string | null;
  observed_at: string;
}

export interface ComputeRequirements {
  /** The file was fetched AND carried a parseable `compute_spec`. False is a
   * reading: we opened it and it declared nothing we could read. */
  found: boolean;
  miner: ComputeRoleRequirements | null;
  validator: ComputeRoleRequirements | null;
  evidence: ComputeRequirementsEvidence;
}

function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function child(parent: Row | null, key: string): Row | null {
  const value = parent?.[key];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : null;
}

/**
 * One role's stanza reduced to the five screening numbers.
 *
 * Returns null when the role was not declared at all, which is a different
 * answer from a role declaring no GPU: 9 of the 35 parseable files carry no
 * `gpu.required` for the miner, and their `gpu_required` is null rather than
 * "not-required".
 */
export function roleRequirements(
  role: Row | null | undefined,
): ComputeRoleRequirements | null {
  if (!role || typeof role !== "object" || Array.isArray(role)) return null;
  const spec = role as Row;
  const gpu = child(spec, "gpu");
  const memory = child(spec, "memory");
  const storage = child(spec, "storage");
  const cpu = child(spec, "cpu");
  return {
    // IMPORTED, never re-derived -- see the header. This is the same call the
    // /cost-to-participate card makes on the same stanza.
    gpu_required: gpuRequirement(gpu),
    min_vram_gb: finite(gpu?.min_vram),
    min_ram_gb: finite(memory?.min_ram),
    min_storage_gb: finite(storage?.min_space),
    min_cores: finite(cpu?.min_cores),
  };
}

/**
 * One repo's reading, from the parsed document and its citation.
 *
 * A `null` spec (the document is not a mapping, or carries no `compute_spec`)
 * still yields a record: we READ the file at that commit and it declared
 * nothing, which is a measurement worth publishing. A file nobody could fetch
 * yields no record at all -- the caller never gets here.
 */
export function summariseComputeRequirements(
  spec: ParsedComputeSpec | null,
  evidence: Omit<ComputeRequirementsEvidence, "spec_version">,
): ComputeRequirements {
  return {
    found: spec !== null,
    miner: roleRequirements(spec?.miner),
    validator: roleRequirements(spec?.validator),
    evidence: { ...evidence, spec_version: spec?.spec_version ?? null },
  };
}

/**
 * What the served facet says about where each number came from.
 *
 * `measured` for the declared numbers -- they are copied out of a file we
 * fetched at a named commit -- and `reconstructed` for the tri-state, which is
 * this repo's judgement about a self-contradicting declaration and not
 * something any subnet wrote.
 */
export const SUBNET_COMPUTE_REQUIREMENTS_FIELD_SOURCES = {
  "miner.min_vram_gb": { kind: "measured", storage: "min_compute.yml" },
  "miner.min_ram_gb": { kind: "measured", storage: "min_compute.yml" },
  "miner.min_storage_gb": { kind: "measured", storage: "min_compute.yml" },
  "miner.min_cores": { kind: "measured", storage: "min_compute.yml" },
  "miner.gpu_required": { kind: "reconstructed", storage: null },
  "validator.gpu_required": { kind: "reconstructed", storage: null },
} as const;

/**
 * The two screening fields the bulk row carries, from a subnet's facet.
 *
 * ONE declaration because the bulk row and any future screen must agree on
 * which role's floor `gpu_required` means: the MINER's. A validator floor on a
 * row labelled `gpu_required` would answer a question nobody asked -- validating
 * is a stake decision, not a hardware one.
 */
export function minerScreeningFields(
  facet: ComputeRequirements | null | undefined,
): { gpu_required: GpuRequirement | null; min_vram_gb: number | null } {
  const miner = facet?.miner ?? null;
  return {
    gpu_required: miner?.gpu_required ?? null,
    min_vram_gb: miner?.min_vram_gb ?? null,
  };
}

/**
 * The served section, or null.
 *
 * ONE composer for the facet's served shape, so the `field_sources` block
 * cannot be attached on one surface and forgotten on the next -- the failure
 * mode where a reader sees a tri-state number with nothing saying it is our
 * judgement rather than the subnet's declaration.
 */
export function computeRequirementsSection(
  facet: ComputeRequirements | null | undefined,
):
  | (ComputeRequirements & {
      field_sources: typeof SUBNET_COMPUTE_REQUIREMENTS_FIELD_SOURCES;
    })
  | null {
  if (!facet) return null;
  return { ...facet, field_sources: SUBNET_COMPUTE_REQUIREMENTS_FIELD_SOURCES };
}

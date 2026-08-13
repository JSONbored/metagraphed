// #10932 phase 1: what a subnet says it takes to participate, and what the
// chain charges to enter.
//
// ## WHY THIS PUBLISHES NO COST PER DAY
//
// The original framing crossed the registered `min_compute` declarations with a
// GPU rental feed to produce a cost/day per subnet. Fetching all 17 declarations
// (2026-08-13) killed it: ONE subnet declares `required: True`. Seven declare
// `required: False`, eight carry no parseable GPU stanza, one 404s. Two rows of
// that issue's own worked table priced an A100 for subnets that do not ask for
// one.
//
// So this card answers the question that the data can support -- what is
// DECLARED, and what is EXACTLY CHARGED -- and stops. Hardware pricing is
// phase 2 and applies to the subnets that actually declare a GPU requirement.
//
// ## THE THREE KINDS OF NUMBER HERE, AND THEY ARE NOT INTERCHANGEABLE
//
//   entry_cost         MEASURED on chain, exact, and already served elsewhere.
//                      Re-served here, never recomputed: the registration burn
//                      comes from subnet_burn_history and the validator floors
//                      from buildSubnetValidatorEconomicsPayload, the same
//                      values /subnets/{n}/burn and /validator-economics show.
//   declared_compute   What the subnet's own file SAYS. Not a measurement of
//                      anything, and the file is a template that is filled in
//                      inconsistently.
//   earnings           What miners on this subnet actually earned, from #10931,
//                      so a floor-to-run can never sit on the page without the
//                      distribution that says whether running is worth it.
//
// ## THE FOURTH STATE IS `null`, AND IT IS THE COMMON ONE
//
// 111 of 128 subnets register no min_compute surface. They publish null
// throughout -- distinguishable from a subnet read with no GPU stanza, and from
// one that declares it needs no GPU. A CPU-only subnet reports NO GPU COST
// rather than a zero, because those are different claims (requirement 2).
//
// Pure shaping only: rows arrive from the store, so the same rows always
// produce the same payload.
import {
  COST_TO_PARTICIPATE_NOT_MODELLED,
  GPU_REQUIREMENT_STATES,
} from "../schemas-src/compute.ts";

type Row = Record<string, unknown>;

/**
 * One `compute_declarations` row as the store returns it.
 *
 * Hand-written rather than taken from generated/db/types.ts for exactly as long
 * as it has to be: those types are introspected from the LIVE schema, so they
 * cannot know about a table this PR is creating. Replaced by the generated
 * `ComputeDeclarations` once the migration lands and the snapshot refreshes,
 * the way TreasuryReadingRow was.
 *
 * `miner` and `validator` are JSONB and are deliberately `unknown`: their shape
 * is the subnet's, not ours, and the CHECK constraint promises only that they
 * are objects.
 */
export interface ComputeDeclarationRow {
  netuid: number;
  source_url: string;
  read_at_sha: string;
  observed_at: number | string;
  first_seen: number | string;
  found: boolean;
  spec_version: string | null;
  miner: unknown;
  validator: unknown;
}

/** The served vocabulary, taken from the schema rather than restated, so a
 * typo in a returned literal fails `tsc` instead of publishing a fourth state
 * the enum has never heard of. */
type GpuRequirement = (typeof GPU_REQUIREMENT_STATES)[number];

export const SUBNET_COST_TO_PARTICIPATE_FIELD_SOURCES = {
  "entry_cost.registration_cost_tao": {
    kind: "measured",
    storage: "SubtensorModule.Burn",
  },
  "entry_cost.validator_permit_floor_tao": {
    kind: "measured",
    storage: "SubtensorModule.Alpha",
  },
  "declared_compute.miner": {
    kind: "measured",
    storage: "compute_declarations",
  },
  "declared_compute.validator": {
    kind: "measured",
    storage: "compute_declarations",
  },
  "declared_compute.miner.gpu.requirement": {
    kind: "reconstructed",
    storage: null,
  },
  "earnings.zero_emission_pct": { kind: "measured", storage: "neuron_daily" },
} as const;

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function finite(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Millis to ISO, or null. A citation with an unreadable date is not a
 * citation, so a bad cell nulls the field rather than inventing "now". */
function isoOrNull(value: unknown): string | null {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** A JSONB column arrives as an object from Postgres and as a JSON string from
 * the SQLite-backed double. Anything else -- a list, a scalar, the `null` the
 * CHECK constraint allows -- is not a stanza and answers null rather than
 * being indexed into. */
function stanza(value: unknown): Row | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
        ? (parsed as Row)
        : null;
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Row)
    : null;
}

/** A named sub-stanza. `parent` is never null -- roleSpec returns early when
 * the spec itself is not an object -- so this only has to decide whether the
 * NAMED key is a stanza. */
function child(parent: Row, key: string): Row | null {
  return stanza(parent[key]);
}

/**
 * YAML `True`/`False` as this ecosystem's files really write them.
 *
 * The template is Python-flavoured, so a value reaches the store as a real
 * boolean, as the string "True", or as 1/0 depending on which YAML parser the
 * extractor used. Anything else -- including absent -- is not a declaration,
 * which is a different answer from a declared `false`.
 */
export function declaredBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "yes") return true;
    if (v === "false" || v === "no") return false;
  }
  return null;
}

/**
 * The GPU answer for one role, from its declared `gpu` stanza.
 *
 * THE TRI-STATE IS THE POINT (requirement 1 of #10932). `required: False`
 * declared beside `min_vram: 8`, `cuda_cores: 1024` and
 * `recommended_gpu: "NVIDIA A100"` is not a subnet contradicting itself so much
 * as the upstream template's default values left unedited next to an edited
 * one -- and the two subnets that do this, CliqueAI and TPN, are exactly the
 * two the original issue's worked table priced an A100 for.
 *
 * Neither coercion is defensible:
 *
 *   -> `false` publishes "needs no GPU" on the strength of a field nobody
 *      touched, on a subnet naming a specific accelerator.
 *   -> `true` prices hardware the subnet never asked for.
 *
 * So it answers `declared-inconsistently` and the caller publishes both
 * declared values beside it. `null` means no `gpu` stanza was declared at all,
 * which is a fourth answer and not a "no".
 *
 * A `required: True` is never called inconsistent, however sparse the rest of
 * the stanza: naming a requirement and then not detailing it is under-specified,
 * not contradictory.
 */
export function gpuRequirement(gpu: Row | null): GpuRequirement | null {
  if (!gpu) return null;
  const required = declaredBoolean(gpu.required);
  if (required === null) return null;
  if (required) return "required";
  // The corroborating fields, any one of which contradicts a declared `false`.
  // `recommended_*` are excluded on purpose -- recommending a GPU for a
  // workload that does not need one is coherent, and only the MINIMA speak to
  // whether it is required.
  const contradicts =
    (finite(gpu.min_vram) ?? 0) > 0 ||
    (finite(gpu.cuda_cores) ?? 0) > 0 ||
    (finite(gpu.min_amount) ?? 0) > 0 ||
    (finite(gpu.min_compute_capability) ?? 0) > 0;
  return contradicts ? "declared-inconsistently" : "not-required";
}

/**
 * One role's declared spec, normalised only in NAMING -- never in value.
 *
 * Units are carried in the field names (`_gb`, `_ghz`, `_mbps`) and the numbers
 * are the file's own. No conversion, no rounding, no defaulting: a declaration
 * we alter is no longer the subnet's declaration, and the tri-state above
 * exists precisely because these files cannot be trusted to be internally
 * consistent.
 */
function roleSpec(raw: unknown): Row | null {
  const spec = stanza(raw);
  if (!spec) return null;
  const cpu = child(spec, "cpu");
  const gpu = child(spec, "gpu");
  const memory = child(spec, "memory");
  const storage = child(spec, "storage");
  const network = child(spec, "network");
  const requirement = gpuRequirement(gpu);
  return {
    gpu: {
      requirement,
      // BOTH declared values, always, when the answer is inconsistent -- the
      // reader has to be able to see WHY it is not a boolean rather than take
      // our word for it.
      declared_required: gpu ? declaredBoolean(gpu.required) : null,
      declared_min_vram_gb: gpu ? finite(gpu.min_vram) : null,
      declared_min_count: gpu ? finite(gpu.min_amount) : null,
      declared_model: gpu ? text(gpu.recommended_gpu) : null,
    },
    cpu: {
      min_cores: cpu ? finite(cpu.min_cores) : null,
      min_speed_ghz: cpu ? finite(cpu.min_speed) : null,
      architecture: cpu ? text(cpu.architecture) : null,
    },
    memory: {
      min_ram_gb: memory ? finite(memory.min_ram) : null,
      min_swap_gb: memory ? finite(memory.min_swap) : null,
    },
    storage: {
      min_space_gb: storage ? finite(storage.min_space) : null,
      min_iops: storage ? finite(storage.min_iops) : null,
      type: storage ? text(storage.type) : null,
    },
    network: {
      min_download_speed_mbps: network
        ? finite(network.min_download_speed)
        : null,
      min_upload_speed_mbps: network ? finite(network.min_upload_speed) : null,
    },
  };
}

/** One stored declaration projected to its served shape. */
function declarationRow(row: Row): Row {
  const found = Boolean(row?.found);
  return {
    evidence: {
      source_url: text(row?.source_url),
      read_at_sha: text(row?.read_at_sha),
      spec_version: text(row?.spec_version),
      observed_at: isoOrNull(row?.observed_at),
      first_seen: isoOrNull(row?.first_seen),
    },
    // FALSE IS A MEASUREMENT: the file was fetched at that commit and carried
    // no parseable compute_spec. A subnet nobody has read has no row here at
    // all, and the card reports that as `declarations_read: 0`.
    found,
    miner: found ? roleSpec(row?.miner) : null,
    validator: found ? roleSpec(row?.validator) : null,
  };
}

export interface CostToParticipateInputs {
  /** The `/validator-economics` payload, whole. Three fields are projected out
   * of it and nothing is recomputed — see entryCostFrom. */
  economics?: Row | null;
  /** The #10931 miner-fairness card, whole. Five fields are projected out of
   * it; nothing is recomputed. */
  minerFairness?: Row | null;
}

/**
 * The entry costs, projected from the `/validator-economics` payload.
 *
 * THE ONE PLACE THIS SHAPE IS BUILT, because three surfaces need it. The REST
 * handler, the MCP tool and the GraphQL resolver each reach the Neon tier
 * separately, and each has to merge the same three fields on top — so a copy
 * per surface is three chances for one of them to serve a poorer card than the
 * other two without anything noticing.
 *
 * Every field is RE-SERVED, never recomputed: `buildSubnetValidatorEconomicsPayload`
 * is the exact composer /api/v1/subnets/{netuid}/validator-economics answers
 * with, so these are the same numbers that route publishes rather than a second
 * derivation off the same tables.
 */
export function entryCostFrom(economics: Row | null | undefined): Row {
  return {
    // Null is "not read", never "free". Netuid 76 reads a true burn of zero, so
    // a zero here is a price and a null is an absence.
    registration_cost_tao: finite(economics?.registration_cost_tao),
    validator_permit_floor_tao: finite(economics?.permit_floor_cost_tao),
    validator_earning_floor_tao: finite(economics?.earning_floor_cost_tao),
  };
}

/**
 * The earnings side, projected from the shipped miner-fairness card.
 *
 * REQUIRED BESIDE THE COST (requirement 4 of #10932), and deliberately not
 * recomputed: `buildSubnetMinerFairness` owns this arithmetic and a second copy
 * here is how two surfaces start disagreeing about one subnet. `days_covered`
 * rides along because a zero-rate over 3 days and one over 31 are not the same
 * claim.
 *
 * NEVER A BARE MEAN (requirement 3). Only the share on zero and the median
 * earning-day count cross over; a mean earning would invite exactly the
 * cost-minus-revenue arithmetic these numbers do not support.
 */
function earningsFrom(card: Row | null | undefined): Row | null {
  if (!card) return null;
  const points = Array.isArray(card.points) ? (card.points as Row[]) : [];
  const persistence = stanza(card.persistence);
  const latest = stanza(points[0]);
  return {
    days_covered: finite(card.days_covered),
    miner_uid_count: finite(card.miner_uid_count),
    zero_emission_pct: latest ? finite(latest.zero_emission_pct) : null,
    never_earned_count: persistence
      ? finite(persistence.never_earned_count)
      : null,
    median_earning_days: persistence
      ? finite(persistence.median_earning_days)
      : null,
  };
}

/**
 * Build one subnet's cost-to-participate card.
 *
 * Null-safe: a cold store yields `declarations_read: 0` with null specs, which
 * is the correct answer for the 111 subnets that register no min_compute
 * surface and is distinguishable from a subnet read with nothing found.
 */
export function buildSubnetCostToParticipate(
  rows: readonly (Row | ComputeDeclarationRow)[] | null | undefined,
  netuid: unknown,
  { economics, minerFairness }: CostToParticipateInputs = {},
): Row {
  const list: Row[] = Array.isArray(rows) ? (rows as Row[]) : [];
  const declarations = list.map(declarationRow);
  // The headline spec is the first declaration that actually found something.
  // Subnets registering two files that disagree keep BOTH in `declarations`
  // rather than being collapsed to whichever was read last.
  const primary = declarations.find((d) => d.found === true) ?? null;

  return {
    schema_version: 1,
    netuid,
    // Exact, on-chain, and re-served rather than recomputed. The Neon tier
    // cannot reach the composer that owns these, so it builds the card with
    // them null and each serving surface merges the real values on top.
    entry_cost: entryCostFrom(economics),
    // "Have we read this subnet's declaration, and how many of them." ZERO is
    // the important value: it means nobody has looked, which is not the same
    // as looking and finding no requirements.
    declarations_read: declarations.length,
    declared_compute: {
      miner: (primary?.miner as Row | null) ?? null,
      validator: (primary?.validator as Row | null) ?? null,
      evidence: (primary?.evidence as Row | null) ?? null,
    },
    declarations,
    earnings: earningsFrom(minerFairness),
    // Served, not left on a docs page, so an agent quoting this card carries
    // the caveats with it.
    not_modelled: [...COST_TO_PARTICIPATE_NOT_MODELLED],
    field_sources: SUBNET_COST_TO_PARTICIPATE_FIELD_SOURCES,
  };
}

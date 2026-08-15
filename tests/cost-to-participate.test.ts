// #10932 phase 1: the cost-to-participate card.
//
// THE ASSERTIONS THAT MATTER HERE ARE THE ONES ABOUT WHAT IS **NOT** SAID. The
// whole rescope of #10932 was that the fleet has nothing in common, so most of
// this file pins the four-valued GPU answer and the difference between "no
// requirement" and "nobody has looked" -- the two collapses that would put a
// wrong number in front of somebody deciding where to spend money.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubnetCostToParticipate,
  declaredBoolean,
  entryCostFrom,
  gpuRequirement,
} from "../src/cost-to-participate.ts";
import { SubnetCostToParticipateArtifactSchema } from "../schemas-src/routes/cost-to-participate.ts";
import {
  COST_TO_PARTICIPATE_NOT_MODELLED,
  GPU_REQUIREMENT_STATES,
} from "../schemas-src/compute.ts";

type Row = Record<string, unknown>;

const OBSERVED = Date.parse("2026-08-13T09:00:00.000Z");

/** Templar's real miner stanza, the ONE subnet of 17 that declares a GPU. */
const TEMPLAR_MINER = {
  cpu: { min_cores: 64, min_speed: 3.5, architecture: "x86_64" },
  gpu: {
    required: true,
    min_vram: 192,
    cuda_cores: 16896,
    recommended_gpu: "NVIDIA B200",
    min_amount: 8,
  },
  memory: { min_ram: 1200, min_swap: 600 },
  storage: { min_space: 1000, min_iops: 95000, type: "SSD" },
};

/** CliqueAI's real miner stanza: `required: False` beside a named A100 and a
 * non-zero minimum VRAM. The shape the original issue's worked table priced an
 * A100 for. */
const CLIQUEAI_MINER = {
  cpu: { min_cores: 4, min_speed: 2.5, architecture: "x86_64" },
  gpu: {
    required: false,
    min_vram: 8,
    cuda_cores: 1024,
    recommended_gpu: "NVIDIA A100",
    min_compute_capability: 6.0,
  },
  memory: { min_ram: 16, min_swap: 4 },
  storage: { min_space: 10, min_iops: 1000, type: "SSD" },
};

/** BitAds: a genuinely CPU-only declaration — no gpu stanza at all. */
const CPU_ONLY_MINER = {
  cpu: { min_cores: 1, min_speed: 2.0, architecture: "x86_64" },
  memory: { min_ram: 2 },
  storage: { min_space: 10, type: "SSD" },
};

function declarationRow(overrides: Row = {}): Row {
  return {
    netuid: 3,
    source_url: "https://raw.githubusercontent.com/o/r/main/min_compute.yml",
    read_at_sha: "abc1234def",
    observed_at: OBSERVED,
    first_seen: OBSERVED,
    found: true,
    spec_version: "0.3.6",
    miner: TEMPLAR_MINER,
    validator: TEMPLAR_MINER,
    ...overrides,
  };
}

describe("gpuRequirement", () => {
  test("a declared True is `required`, however sparse the rest of the stanza", () => {
    assert.equal(gpuRequirement({ required: true }), "required");
    assert.equal(gpuRequirement(TEMPLAR_MINER.gpu), "required");
    // Python-flavoured YAML reaches the store in three shapes depending on the
    // parser; all three are the same declaration.
    assert.equal(gpuRequirement({ required: "True" }), "required");
    assert.equal(gpuRequirement({ required: 1 }), "required");
  });

  test("a declared False beside a minimum is `declared-inconsistently`, never a boolean", () => {
    assert.equal(gpuRequirement(CLIQUEAI_MINER.gpu), "declared-inconsistently");
    // Each corroborating minimum on its own is enough.
    for (const field of [
      "min_vram",
      "cuda_cores",
      "min_amount",
      "min_compute_capability",
    ]) {
      assert.equal(
        gpuRequirement({ required: false, [field]: 8 }),
        "declared-inconsistently",
        `${field} contradicts a declared false and must not be coerced away`,
      );
    }
  });

  test("a RECOMMENDED gpu alone never contradicts a declared False", () => {
    // Recommending a card for a workload that does not need one is coherent.
    // Only the MINIMA speak to whether it is required — if `recommended_gpu`
    // moved the answer, every subnet that left the template's model string in
    // place would report inconsistent and the state would mean nothing.
    assert.equal(
      gpuRequirement({
        required: false,
        recommended_gpu: "NVIDIA A100",
        recommended_vram: 24,
      }),
      "not-required",
    );
  });

  test("a clean False is `not-required`, and no stanza at all is null", () => {
    assert.equal(gpuRequirement({ required: false }), "not-required");
    assert.equal(
      gpuRequirement({ required: false, min_vram: 0 }),
      "not-required",
    );
    // THE FOURTH ANSWER. No gpu stanza, or one that declares no `required`, is
    // not a "no" — it is nobody having said.
    assert.equal(gpuRequirement(null), null);
    assert.equal(gpuRequirement({ min_vram: 8 }), null);
  });

  test("every answer it can give is in the published vocabulary", () => {
    // The negative direction of the enum: a state the schema has never heard
    // of would serialise fine and fail only at a consumer.
    const answers = [
      gpuRequirement({ required: true }),
      gpuRequirement({ required: false }),
      gpuRequirement({ required: false, min_vram: 8 }),
    ];
    assert.equal(answers.length, GPU_REQUIREMENT_STATES.length);
    for (const answer of answers) {
      assert.ok(
        (GPU_REQUIREMENT_STATES as readonly string[]).includes(answer!),
        `${answer} is served but not declared`,
      );
    }
  });
});

describe("declaredBoolean", () => {
  test("absent, unparseable and out-of-range values are not declarations", () => {
    assert.equal(declaredBoolean(undefined), null);
    assert.equal(declaredBoolean("maybe"), null);
    assert.equal(declaredBoolean(2), null);
    assert.equal(declaredBoolean(null), null);
    assert.equal(declaredBoolean(" no "), false);
    assert.equal(declaredBoolean("YES"), true);
    assert.equal(declaredBoolean(0), false);
  });
});

describe("entryCostFrom", () => {
  test("projects the validator-economics payload's own field names", () => {
    assert.deepEqual(
      entryCostFrom({
        registration_cost_tao: 0.5,
        permit_floor_cost_tao: 1200,
        earning_floor_cost_tao: 8400,
        // Everything else on that payload stays there.
        validator_headroom: 3,
      }),
      {
        registration_cost_tao: 0.5,
        validator_permit_floor_tao: 1200,
        validator_earning_floor_tao: 8400,
      },
    );
  });

  test("a zero burn is a price and a missing one is an absence", () => {
    // Netuid 76 really does read a burn of zero. Collapsing the two would
    // publish "free to register here" for every subnet nobody has read.
    assert.equal(
      entryCostFrom({ registration_cost_tao: 0 }).registration_cost_tao,
      0,
    );
    assert.equal(entryCostFrom({}).registration_cost_tao, null);
    assert.equal(entryCostFrom(null).registration_cost_tao, null);
  });
});

describe("buildSubnetCostToParticipate", () => {
  test("a cold store claims nothing about the subnet", () => {
    const card = buildSubnetCostToParticipate(null, 42);
    assert.equal(card.declarations_read, 0);
    assert.deepEqual(card.declarations, []);
    assert.deepEqual(card.declared_compute, {
      miner: null,
      validator: null,
      evidence: null,
    });
    // The state most subnets are in. Every one of these must be null
    // rather than a zero or a false: "nobody has looked" is not "needs
    // nothing".
    assert.equal(card.earnings, null);
    assert.equal(
      (card.entry_cost as Row).registration_cost_tao,
      null,
      "an unread entry cost is not a free one",
    );
  });

  test("a read that found nothing is EVIDENCE, and distinct from an unread subnet", () => {
    const card = buildSubnetCostToParticipate(
      [declarationRow({ found: false, miner: null, validator: null })],
      3,
    );
    // declarations_read: 1 with found: false — the file WAS fetched at that
    // commit and declared nothing. An unread subnet reports 0 and has no
    // declaration at all.
    assert.equal(card.declarations_read, 1);
    const [declaration] = card.declarations as Row[];
    assert.equal(declaration.found, false);
    assert.equal(declaration.miner, null);
    assert.equal(
      (declaration.evidence as Row).read_at_sha,
      "abc1234def",
      "a non-finding still carries the citation that makes it checkable",
    );
  });

  test("a CPU-only declaration reports no GPU requirement, not a zero", () => {
    const card = buildSubnetCostToParticipate(
      [declarationRow({ miner: CPU_ONLY_MINER, validator: CPU_ONLY_MINER })],
      16,
    );
    const gpu = ((card.declared_compute as Row).miner as Row).gpu as Row;
    // Requirement 2. `null` here is "the declaration names no GPU"; every
    // declared value beside it is null too, so nothing reads as a zero-cost
    // GPU.
    assert.equal(gpu.requirement, null);
    assert.equal(gpu.declared_min_vram_gb, null);
    assert.equal(gpu.declared_model, null);
    assert.equal(
      ((card.declared_compute as Row).miner as Row).cpu &&
        (((card.declared_compute as Row).miner as Row).cpu as Row).min_cores,
      1,
      "the CPU side is still published in the subnet's own numbers",
    );
  });

  test("the inconsistent declaration publishes BOTH declared values", () => {
    const card = buildSubnetCostToParticipate(
      [declarationRow({ netuid: 83, miner: CLIQUEAI_MINER })],
      83,
    );
    const gpu = ((card.declared_compute as Row).miner as Row).gpu as Row;
    assert.equal(gpu.requirement, "declared-inconsistently");
    // The falsifiable outcome named in the issue: a reader must be able to see
    // WHY it is not a boolean rather than take our word for it.
    assert.equal(gpu.declared_required, false);
    assert.equal(gpu.declared_min_vram_gb, 8);
    assert.equal(gpu.declared_model, "NVIDIA A100");
  });

  test("miner and validator stay apart, and units are the file's own", () => {
    const card = buildSubnetCostToParticipate(
      [declarationRow({ miner: TEMPLAR_MINER, validator: CPU_ONLY_MINER })],
      3,
    );
    const compute = card.declared_compute as Row;
    assert.equal(((compute.miner as Row).gpu as Row).requirement, "required");
    assert.equal(((compute.validator as Row).gpu as Row).requirement, null);
    // 192 GB as declared — not converted, not rounded. A declaration we alter
    // is no longer the subnet's declaration.
    assert.equal(((compute.miner as Row).gpu as Row).declared_min_vram_gb, 192);
    assert.equal(((compute.miner as Row).memory as Row).min_ram_gb, 1200);
  });

  test("two declarations that disagree are both kept", () => {
    const card = buildSubnetCostToParticipate(
      [
        declarationRow({ source_url: "https://a/min_compute.yml" }),
        declarationRow({
          source_url: "https://b/min_compute.yml",
          miner: CPU_ONLY_MINER,
        }),
      ],
      3,
    );
    assert.equal(card.declarations_read, 2);
    // The headline is the first that found something; the disagreement is
    // visible rather than collapsed to whichever was read last.
    assert.equal(
      (((card.declared_compute as Row).miner as Row).gpu as Row).requirement,
      "required",
    );
    assert.equal((card.declarations as Row[]).length, 2);
  });

  test("a found:true row whose stanzas are junk does not throw or invent", () => {
    // The CHECK constraint allows a stanza that is any JSON object; a list, a
    // scalar or a string reaching the column means the extractor read the
    // wrong node, and every reader below would otherwise index into it.
    for (const junk of [["a"], 7, "not json", '"a string"', null]) {
      const card = buildSubnetCostToParticipate(
        [declarationRow({ miner: junk, validator: junk })],
        3,
      );
      assert.equal(((card.declarations as Row[])[0] as Row).miner, null);
    }
    // A JSON STRING is how the SQLite-backed double returns a JSONB column, so
    // it must parse rather than null out.
    const card = buildSubnetCostToParticipate(
      [declarationRow({ miner: JSON.stringify(TEMPLAR_MINER) })],
      3,
    );
    assert.equal(
      (((card.declarations as Row[])[0].miner as Row).gpu as Row).requirement,
      "required",
    );
  });

  test("a bare spec with no sub-stanzas publishes nulls, never zeros", () => {
    // Every `min_*` here is absent rather than zero, and the difference is the
    // whole point of the card: a subnet that declares no minimum RAM has not
    // declared that it needs none.
    const card = buildSubnetCostToParticipate(
      [declarationRow({ miner: {}, validator: {} })],
      3,
    );
    const miner = (card.declared_compute as Row).miner as Row;
    for (const [group, field] of [
      ["cpu", "min_cores"],
      ["cpu", "min_speed_ghz"],
      ["cpu", "architecture"],
      ["memory", "min_ram_gb"],
      ["memory", "min_swap_gb"],
      ["storage", "min_space_gb"],
      ["storage", "min_iops"],
      ["storage", "type"],
      ["network", "min_download_speed_mbps"],
      ["network", "min_upload_speed_mbps"],
    ] as const) {
      assert.equal(
        (miner[group] as Row)[field],
        null,
        `${group}.${field} must be absent, not zero`,
      );
    }
    assert.equal((miner.gpu as Row).requirement, null);
  });

  test("numbers the file quotes are still numbers, and junk is not", () => {
    // A YAML author quoting a value ("min_vram": "8") is ordinary, and the
    // extractor stores the stanza verbatim — so the read side has to accept a
    // numeric string without accepting `"lots"`.
    const card = buildSubnetCostToParticipate(
      [
        declarationRow({
          miner: {
            cpu: { min_cores: "8", min_speed: "  ", architecture: "" },
            gpu: { required: "False", min_vram: "16" },
            memory: { min_ram: "lots" },
            storage: { min_space: "500" },
            network: { min_download_speed: "100", min_upload_speed: 50 },
          },
        }),
      ],
      3,
    );
    const miner = (card.declared_compute as Row).miner as Row;
    assert.equal((miner.cpu as Row).min_cores, 8);
    assert.equal((miner.cpu as Row).min_speed_ghz, null);
    assert.equal((miner.cpu as Row).architecture, null);
    assert.equal((miner.memory as Row).min_ram_gb, null);
    assert.equal((miner.storage as Row).min_space_gb, 500);
    assert.equal((miner.network as Row).min_download_speed_mbps, 100);
    assert.equal((miner.network as Row).min_upload_speed_mbps, 50);
    // A quoted minimum still contradicts a quoted False.
    assert.equal((miner.gpu as Row).requirement, "declared-inconsistently");
  });

  test("a non-finite number is not a declaration", () => {
    const card = buildSubnetCostToParticipate(
      [declarationRow({ miner: { memory: { min_ram: Number.NaN } } })],
      3,
    );
    assert.equal(
      (((card.declared_compute as Row).miner as Row).memory as Row).min_ram_gb,
      null,
    );
  });

  test("a row array that is not an array claims nothing", () => {
    assert.equal(
      buildSubnetCostToParticipate("not rows" as never, 3).declarations_read,
      0,
    );
  });

  test("declarations that all found nothing leave the headline empty", () => {
    const card = buildSubnetCostToParticipate(
      [declarationRow({ found: false, miner: null, validator: null })],
      3,
    );
    assert.equal((card.declared_compute as Row).miner, null);
    assert.equal((card.declared_compute as Row).evidence, null);
  });

  test("an unreadable observed_at nulls the date rather than stamping 1970", () => {
    const card = buildSubnetCostToParticipate(
      [declarationRow({ observed_at: 0, first_seen: "junk" })],
      3,
    );
    const evidence = (card.declarations as Row[])[0].evidence as Row;
    assert.equal(evidence.observed_at, null);
    assert.equal(evidence.first_seen, null);
    // A finite but out-of-range epoch makes new Date(ms).toISOString() throw a
    // RangeError, which would tear the whole card down over one corrupt cell.
    assert.equal(
      (
        (
          buildSubnetCostToParticipate(
            [declarationRow({ observed_at: 8.65e15 })],
            3,
          ).declarations as Row[]
        )[0].evidence as Row
      ).observed_at,
      null,
    );
  });

  test("the earnings side is projected, never recomputed, and carries no mean", () => {
    const card = buildSubnetCostToParticipate([declarationRow()], 3, {
      minerFairness: {
        days_covered: 8,
        miner_uid_count: 247,
        points: [{ snapshot_date: "2026-08-13", zero_emission_pct: 0.96 }],
        persistence: { never_earned_count: 237, median_earning_days: 0 },
      },
    });
    const earnings = card.earnings as Row;
    assert.equal(earnings.zero_emission_pct, 0.96);
    assert.equal(earnings.days_covered, 8);
    assert.equal(earnings.never_earned_count, 237);
    // Requirement 3: never a bare mean. A mean earning beside a cost is an
    // invitation to subtract one from the other, which is the arithmetic these
    // numbers do not support.
    assert.equal(
      Object.keys(earnings).some((k) => k.includes("mean")),
      false,
    );
  });

  test("a spec whose sub-stanzas are junk yields nulls, not throws", () => {
    // `child` is reached with a parent that IS an object but whose named key is
    // not — a list `cpu:` or a scalar `storage:` in the YAML. Each has to null
    // out on its own rather than being indexed into.
    const card = buildSubnetCostToParticipate(
      [
        declarationRow({
          miner: { cpu: ["4 cores"], gpu: 7, memory: "16GB", storage: null },
        }),
      ],
      3,
    );
    const miner = (card.declared_compute as Row).miner as Row;
    assert.equal((miner.cpu as Row).min_cores, null);
    assert.equal((miner.gpu as Row).requirement, null);
    assert.equal((miner.memory as Row).min_ram_gb, null);
  });

  test("a miner-fairness card with no points or persistence still shapes", () => {
    // The fairness card is null-safe by construction (days_covered 0 on a cold
    // subnet), so the projection has to be too rather than assuming the shapes
    // it usually gets.
    const card = buildSubnetCostToParticipate([declarationRow()], 3, {
      minerFairness: { days_covered: 0, persistence: null },
    });
    const earnings = card.earnings as Row;
    assert.equal(earnings.zero_emission_pct, null);
    assert.equal(earnings.never_earned_count, null);
    assert.equal(earnings.median_earning_days, null);
    assert.equal(earnings.days_covered, 0);
  });

  test("what is not modelled is served, not left on a docs page", () => {
    const card = buildSubnetCostToParticipate([declarationRow()], 3);
    assert.deepEqual(card.not_modelled, [...COST_TO_PARTICIPATE_NOT_MODELLED]);
    assert.ok(
      (card.not_modelled as string[]).some((line) =>
        /floor to RUN/i.test(line),
      ),
      "the floor-to-run caveat is the one an agent must carry with any answer",
    );
  });
});

// --- the contract ------------------------------------------------------------
//
// The builder returns Record<string, unknown>, so nothing checks the payload
// against the schema unless a test does. Both a POPULATED and a COLD payload
// are parsed: they take different branches, and the cold one is the answer
// served for the majority of subnets.
describe("the contract", () => {
  test("a populated card satisfies its own artifact schema", () => {
    const parsed = SubnetCostToParticipateArtifactSchema.safeParse(
      buildSubnetCostToParticipate(
        [
          declarationRow(),
          declarationRow({
            source_url: "https://b/min_compute.yml",
            miner: CLIQUEAI_MINER,
            validator: null,
          }),
        ],
        3,
        {
          economics: {
            registration_cost_tao: 0.5,
            permit_floor_cost_tao: 1200,
            earning_floor_cost_tao: 8400,
          },
          minerFairness: {
            days_covered: 8,
            miner_uid_count: 247,
            points: [{ snapshot_date: "2026-08-13", zero_emission_pct: 0.96 }],
            persistence: { never_earned_count: 237, median_earning_days: 0 },
          },
        },
      ),
    );
    assert.equal(
      parsed.success,
      true,
      JSON.stringify(parsed.error?.issues?.slice(0, 3)),
    );
  });

  test("the cold card satisfies it too", () => {
    const parsed = SubnetCostToParticipateArtifactSchema.safeParse(
      buildSubnetCostToParticipate([], 42),
    );
    assert.equal(
      parsed.success,
      true,
      JSON.stringify(parsed.error?.issues?.slice(0, 3)),
    );
  });
});

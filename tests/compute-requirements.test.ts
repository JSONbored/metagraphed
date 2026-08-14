// #11097: the hardware-requirements facet -- the parser, the screening
// projection, and the two things that would make it a lie:
//   - a tri-state that disagrees with the card already serving the same file;
//   - a bad capture run that shrinks coverage without saying so.
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  computeProbeTargets,
  computeRequirementsSection,
  minerScreeningFields,
  roleRequirements,
  summariseComputeRequirements,
  MIN_COMPUTE_REPO_PATHS,
  MIN_COMPUTE_BRANCHES,
  SUBNET_COMPUTE_REQUIREMENTS_FIELD_SOURCES,
} from "../src/compute-requirements.ts";
import { parseComputeSpec } from "../src/compute-declarations-lane.ts";
import { buildSubnetCostToParticipate } from "../src/cost-to-participate.ts";
import {
  captureComputeRequirements,
  computeRequirementsForRepoUrl,
  retainsPreviousReading,
  COMPUTE_REQUIREMENTS_RETENTION_MS,
} from "../scripts/compute-requirements.ts";
import { SubnetComputeRequirementsSchema } from "../schemas-src/compute.ts";

// SN3 Templar's file, trimmed to the stanzas this facet reads. A real
// `required: True` with a real 192 GB floor -- the top of the fleet.
const GPU_SPEC = `version: '0.3.6'
compute_spec:
  miner:
    cpu:
      min_cores: 64
    gpu:
      required: True
      min_vram: 192
    memory:
      min_ram: 1200
    storage:
      min_space: 1000
  validator:
    gpu:
      required: True
      min_vram: 80
`;

// The shape that makes the tri-state necessary: a declared `False` sitting
// beside a real VRAM floor, which is the template's default left unedited
// next to an edited one.
const INCONSISTENT_SPEC = `version: '1.1'
compute_spec:
  miner:
    gpu:
      required: False
      min_vram: 16
`;

describe("min_compute probe targets", () => {
  it("covers every path on every branch, common case first", () => {
    const targets = computeProbeTargets("one-covenant", "templar");
    expect(targets).toHaveLength(
      MIN_COMPUTE_REPO_PATHS.length * MIN_COMPUTE_BRANCHES.length,
    );
    expect(targets[0].url).toBe(
      "https://raw.githubusercontent.com/one-covenant/templar/main/min_compute.yml",
    );
    // Branch-major: every `main` path is tried before the first `master` one.
    const firstMaster = targets.findIndex((t) => t.branch === "master");
    expect(firstMaster).toBe(MIN_COMPUTE_REPO_PATHS.length);
  });
});

describe("roleRequirements", () => {
  it("reads the four declared numbers and the tri-state", () => {
    const spec = parseComputeSpec(GPU_SPEC);
    expect(roleRequirements(spec?.miner)).toEqual({
      gpu_required: "required",
      min_vram_gb: 192,
      min_ram_gb: 1200,
      min_storage_gb: 1000,
      min_cores: 64,
    });
  });

  it("answers null for a role that was never declared", () => {
    expect(roleRequirements(undefined)).toBeNull();
    expect(roleRequirements(null)).toBeNull();
    // A list is not a role stanza.
    expect(
      roleRequirements([] as unknown as Record<string, unknown>),
    ).toBeNull();
  });

  it("declares nulls -- never zeros -- for a stanza with no numbers", () => {
    expect(roleRequirements({ gpu: { required: true } })).toEqual({
      gpu_required: "required",
      min_vram_gb: null,
      min_ram_gb: null,
      min_storage_gb: null,
      min_cores: null,
    });
  });

  it("reads a quoted number, and refuses a value that is not one", () => {
    // YAML quoting is a per-file habit -- `min_ram: '16'` and `min_ram: 16`
    // are both in the fleet -- so a quoted floor is a number. A unit suffix is
    // not: "16GB" reads as no declared value rather than as 16.
    expect(
      roleRequirements({
        gpu: { min_vram: "16" },
        memory: { min_ram: "16GB" },
        storage: { min_space: "" },
        cpu: { min_cores: Number.NaN },
      }),
    ).toEqual({
      gpu_required: null,
      min_vram_gb: 16,
      min_ram_gb: null,
      min_storage_gb: null,
      min_cores: null,
    });
  });

  it("keeps a declared GPU floor as null when the role declares no gpu stanza", () => {
    // 13 of the 39 captured repos are in this state: `gpu_required: null` is a
    // FOURTH answer and must never render as "no GPU needed".
    expect(
      roleRequirements({ cpu: { min_cores: 8 } })?.gpu_required,
    ).toBeNull();
  });
});

describe("the screening tri-state matches the card serving the same file", () => {
  // The point of importing gpuRequirement rather than restating it. If someone
  // re-derives the judgement here, these two answers stop matching.
  it.each([
    ["a declared requirement", GPU_SPEC, "required"],
    [
      "a False beside a VRAM floor",
      INCONSISTENT_SPEC,
      "declared-inconsistently",
    ],
  ])("agrees on %s", (_label, yaml, expected) => {
    const parsed = parseComputeSpec(yaml);
    const facet = roleRequirements(parsed?.miner);
    const card = buildSubnetCostToParticipate(
      [
        {
          netuid: 3,
          source_url: "https://example.test/min_compute.yml",
          read_at_sha: "abcdef1234567",
          observed_at: 1_760_000_000_000,
          first_seen: 1_760_000_000_000,
          found: true,
          spec_version: "0.3.6",
          miner: parseYaml(yaml).compute_spec.miner,
          validator: null,
        },
      ],
      3,
    );
    const cardRequirement = (
      (
        (card.declared_compute as Record<string, unknown>).miner as Record<
          string,
          unknown
        >
      ).gpu as Record<string, unknown>
    ).requirement;
    expect(facet?.gpu_required).toBe(expected);
    expect(cardRequirement).toBe(expected);
  });
});

describe("summariseComputeRequirements", () => {
  const evidence = {
    source_url: "https://raw.githubusercontent.com/o/r/main/min_compute.yml",
    read_at_sha: "1818765c1b59c01de89489ee601758dde8deb5a7",
    path: "min_compute.yml",
    observed_at: "2026-08-14T04:36:17.498Z",
  };

  it("records a reading that found a spec, with its citation", () => {
    const record = summariseComputeRequirements(
      parseComputeSpec(GPU_SPEC),
      evidence,
    );
    expect(record.found).toBe(true);
    expect(record.evidence.spec_version).toBe("0.3.6");
    expect(record.validator?.min_vram_gb).toBe(80);
    // The served section validates against its own published schema.
    expect(() =>
      SubnetComputeRequirementsSchema.parse(computeRequirementsSection(record)),
    ).not.toThrow();
  });

  it("records a file we read that declared nothing -- not an absence", () => {
    // A document with no compute_spec is a MEASUREMENT: we opened it at that
    // commit. A subnet nobody could read has no record at all.
    const record = summariseComputeRequirements(parseComputeSpec("name: x\n"), {
      ...evidence,
    });
    expect(record.found).toBe(false);
    expect(record.miner).toBeNull();
    expect(record.evidence.read_at_sha).toBe(evidence.read_at_sha);
  });
});

describe("minerScreeningFields", () => {
  it("carries the miner floor onto the bulk row", () => {
    const record = summariseComputeRequirements(parseComputeSpec(GPU_SPEC), {
      source_url: "https://example.test/min_compute.yml",
      read_at_sha: "abcdef1234567",
      path: "min_compute.yml",
      observed_at: "2026-08-14T04:36:17.498Z",
    });
    expect(minerScreeningFields(record)).toEqual({
      gpu_required: "required",
      min_vram_gb: 192,
    });
  });

  it("is null-valued -- never false -- for a subnet with no reading", () => {
    expect(minerScreeningFields(null)).toEqual({
      gpu_required: null,
      min_vram_gb: null,
    });
  });
});

describe("computeRequirementsSection", () => {
  it("attaches field_sources so the tri-state is never mistaken for a declaration", () => {
    const section = computeRequirementsSection({
      found: true,
      miner: null,
      validator: null,
      evidence: {
        source_url: "https://example.test/min_compute.yml",
        read_at_sha: "abcdef1234567",
        path: "min_compute.yml",
        spec_version: null,
        observed_at: "2026-08-14T04:36:17.498Z",
      },
    });
    expect(section?.field_sources).toBe(
      SUBNET_COMPUTE_REQUIREMENTS_FIELD_SOURCES,
    );
    expect(
      SUBNET_COMPUTE_REQUIREMENTS_FIELD_SOURCES["miner.gpu_required"].kind,
    ).toBe("reconstructed");
  });

  it("is null for a subnet with no reading", () => {
    expect(computeRequirementsSection(null)).toBeNull();
    expect(computeRequirementsSection(undefined)).toBeNull();
  });
});

describe("computeRequirementsForRepoUrl", () => {
  const facet = {
    found: true,
    miner: null,
    validator: null,
    evidence: {
      source_url: "https://example.test/min_compute.yml",
      read_at_sha: "abcdef1234567",
      path: "min_compute.yml",
      spec_version: null,
      observed_at: "2026-08-14T04:36:17.498Z",
    },
  };
  const byRepo = new Map([["one-covenant/templar", facet]]);

  it("resolves through the row's own source_repo, case-insensitively", () => {
    expect(
      computeRequirementsForRepoUrl(
        byRepo,
        "https://github.com/One-Covenant/Templar",
      ),
    ).toBe(facet);
  });

  it("answers null for a subnet with no GitHub repo, and for an unread one", () => {
    expect(computeRequirementsForRepoUrl(byRepo, null)).toBeNull();
    expect(
      computeRequirementsForRepoUrl(byRepo, "https://gitlab.com/x/y"),
    ).toBeNull();
    expect(
      computeRequirementsForRepoUrl(byRepo, "https://github.com/other/repo"),
    ).toBeNull();
  });
});

describe("a capture run that cannot reach GitHub", () => {
  const previous = new Map([
    [
      "one-covenant/templar",
      {
        found: true,
        miner: {
          gpu_required: "required" as const,
          min_vram_gb: 192,
          min_ram_gb: 1200,
          min_storage_gb: 1000,
          min_cores: 64,
        },
        validator: null,
        evidence: {
          source_url:
            "https://raw.githubusercontent.com/one-covenant/templar/main/min_compute.yml",
          read_at_sha: "55bd03042426485326612ce2b302b0df835beeb4",
          path: "min_compute.yml",
          spec_version: "0.3.6",
          observed_at: "2026-08-10T00:00:00.000Z",
        },
      },
    ],
  ]);
  const repos = [{ owner: "one-covenant", repo: "templar" }];
  const rateLimited = () =>
    Promise.resolve(new Response("rate limited", { status: 403 }));

  it("keeps the last-good reading instead of shrinking the facet", async () => {
    const artifact = await captureComputeRequirements(repos, {
      fetchImpl: rateLimited as unknown as typeof fetch,
      previousByRepo: previous,
      capturedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(artifact.requirements).toHaveLength(1);
    expect(artifact.summary.retained).toBe(1);
    expect(artifact.summary.uncited).toBe(0);
    expect(artifact.requirements[0].evidence.read_at_sha).toBe(
      "55bd03042426485326612ce2b302b0df835beeb4",
    );
  });

  it("drops a reading nobody has been able to re-read for 30 days", async () => {
    const artifact = await captureComputeRequirements(repos, {
      fetchImpl: rateLimited as unknown as typeof fetch,
      previousByRepo: previous,
      // One millisecond past the window, measured from the retained reading.
      capturedAt: new Date(
        Date.parse("2026-08-10T00:00:00.000Z") +
          COMPUTE_REQUIREMENTS_RETENTION_MS +
          1,
      ).toISOString(),
    });
    expect(artifact.requirements).toHaveLength(0);
    expect(artifact.summary.retained).toBe(0);
    expect(artifact.summary.uncited).toBe(1);
  });

  it("does not retain a reading whose date cannot be read", () => {
    expect(retainsPreviousReading(undefined, Date.now())).toBe(false);
    expect(
      retainsPreviousReading(
        {
          found: true,
          miner: null,
          validator: null,
          evidence: {
            source_url: "https://example.test/min_compute.yml",
            read_at_sha: "abcdef1234567",
            path: "min_compute.yml",
            spec_version: null,
            observed_at: "not a date",
          },
        },
        Date.now(),
      ),
    ).toBe(false);
  });
});

describe("a capture run that reaches GitHub", () => {
  const repos = [{ owner: "one-covenant", repo: "templar" }];
  const fetchImpl = ((url: string) => {
    if (url.startsWith("https://api.github.com/")) {
      return Promise.resolve(
        new Response(JSON.stringify([{ sha: "a".repeat(40) }]), {
          status: 200,
        }),
      );
    }
    return Promise.resolve(
      url.endsWith("/main/min_compute.yml")
        ? new Response(GPU_SPEC, { status: 200 })
        : new Response("not found", { status: 404 }),
    );
  }) as unknown as typeof fetch;

  it("reads the file, cites the commit, and counts the run", async () => {
    const artifact = await captureComputeRequirements(repos, {
      fetchImpl,
      capturedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(artifact.summary).toEqual({
      repos_probed: 1,
      files_found: 1,
      specs_parsed: 1,
      read_without_spec: 0,
      uncited: 0,
      retained: 0,
    });
    expect(artifact.requirements[0].miner?.min_vram_gb).toBe(192);
    expect(artifact.requirements[0].evidence.observed_at).toBe(
      "2026-08-14T00:00:00.000Z",
    );
  });

  it("preserves the previous observation date when the commit has not moved", async () => {
    const previousByRepo = new Map([
      [
        "one-covenant/templar",
        {
          found: true,
          miner: null,
          validator: null,
          evidence: {
            source_url:
              "https://raw.githubusercontent.com/one-covenant/templar/main/min_compute.yml",
            read_at_sha: "a".repeat(40),
            path: "min_compute.yml",
            spec_version: "0.3.6",
            observed_at: "2026-07-01T00:00:00.000Z",
          },
        },
      ],
    ]);
    const artifact = await captureComputeRequirements(repos, {
      fetchImpl,
      capturedAt: "2026-08-14T00:00:00.000Z",
      previousByRepo,
    });
    // The declaration did not move, so neither does the date -- which is what
    // keeps the committed seed's daily diff content-only.
    expect(artifact.requirements[0].evidence.observed_at).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });

  it("counts a file that carries no compute_spec as read, not missing", async () => {
    const noSpec = ((url: string) =>
      url.startsWith("https://api.github.com/")
        ? Promise.resolve(
            new Response(JSON.stringify([{ sha: "b".repeat(40) }]), {
              status: 200,
            }),
          )
        : Promise.resolve(
            url.endsWith("/main/min_compute.yml")
              ? new Response("name: not-a-spec\n", { status: 200 })
              : new Response("not found", { status: 404 }),
          )) as unknown as typeof fetch;
    const artifact = await captureComputeRequirements(repos, {
      fetchImpl: noSpec,
      capturedAt: "2026-08-14T00:00:00.000Z",
    });
    expect(artifact.summary.read_without_spec).toBe(1);
    expect(artifact.summary.specs_parsed).toBe(0);
    expect(artifact.requirements[0].found).toBe(false);
  });
});

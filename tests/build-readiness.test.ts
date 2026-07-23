import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { OPERATIONAL_SURFACE_KINDS } from "../src/health-probe-core.ts";
import {
  READINESS_VERSION,
  COVERAGE_DEPTH_VERSION,
  COVERAGE_DEPTH_WEIGHTS,
  COVERAGE_DEPTH_QUEUE_LIMIT,
  COVERAGE_DEPTH_SEVERITY_RANK,
  readinessTier,
  subnetIntegrationReadiness,
  buildAgentReadiness,
  summarizeAgentReadinessBlockers,
  coverageDepthTier,
  addCoverageDepthGap,
  sortCoverageDepthGaps,
  scoreCoverageDepthDimensions,
  coverageDepthPriorityScore,
  buildCoverageDepthArtifact,
} from "../scripts/lib/build-readiness.ts";
import type { Row } from "./row-type.ts";

// --- test helpers -----------------------------------------------------------

function mockService(overrides = {}) {
  return {
    kind: "subnet-api",
    schema_artifact: null,
    auth_required: false,
    auth_schemes: [],
    eligibility: { callable: true },
    fixture_status: { status: "missing" },
    ...overrides,
  };
}

function mockSubnet(overrides = {}) {
  return {
    netuid: 1,
    slug: "sn-1",
    name: "Subnet One",
    lifecycle: "active",
    source_repo: null,
    docs_url: null,
    subnet_type: "application",
    ...overrides,
  };
}

function mockProfile(overrides = {}) {
  return {
    subnet_type: "application",
    completeness_score: 50,
    curation_level: "community",
    profile_level: "basic",
    ...overrides,
  };
}

function mapOf<T>(entries: [number, T][] = []): Map<number, T> {
  return new Map(entries);
}

function buildCoverageDepthInput({
  subnets = [mockSubnet()] as Row[],
  profiles = [] as [number, Row][],
  surfaces = [] as [number, Row[]][],
  services = [] as [number, Row[]][],
  candidates = [] as [number, Row[]][],
  readiness = [] as [number, Row][],
  agentReadiness = [] as [number, Row][],
  examples = [] as [number, Row[]][],
} = {}) {
  return {
    subnets,
    profileByNetuid: mapOf(profiles),
    surfacesByNetuid: mapOf(surfaces),
    servicesByNetuid: mapOf(services),
    candidatesByNetuid: mapOf(candidates),
    readinessByNetuid: mapOf(readiness),
    agentReadinessByNetuid: mapOf(agentReadiness),
    examplesByNetuid: mapOf(examples),
    generatedAt: "2026-06-25T00:00:00.000Z",
    contractVersion: "test-contract",
  };
}

function fullCallableStack(netuid = 1) {
  const service = mockService({
    schema_artifact: "schemas/sn-1/openapi.json",
    fixture_status: { status: "available" },
  });
  const subnet = mockSubnet({
    netuid,
    slug: `sn-${netuid}`,
    name: `Subnet ${netuid}`,
    source_repo: "https://github.com/example/repo",
    docs_url: "https://docs.example.com",
  });
  const profile = mockProfile({
    completeness_score: 85,
    curation_level: "maintainer-reviewed",
  });
  const surface = {
    kind: "subnet-api",
    authority: "official",
  };
  const readiness = subnetIntegrationReadiness({
    services: [service],
    lifecycle: "active",
    completenessScore: 85,
    sourceRepo: subnet.source_repo,
    docsUrl: subnet.docs_url,
    candidates: [],
  });
  const agentReadiness = buildAgentReadiness({
    subnet,
    profile,
    services: [service],
    readiness,
    callableCount: 1,
  });
  return { subnet, profile, service, surface, readiness, agentReadiness };
}

// --- readinessTier ----------------------------------------------------------

describe("readinessTier", () => {
  test("returns buildable when has_callable_api is true", () => {
    assert.equal(readinessTier({ has_callable_api: true }), "buildable");
    assert.equal(
      readinessTier({
        has_callable_api: true,
        has_candidate_api: true,
        has_public_docs: true,
        has_source_repo: true,
        active_lifecycle: true,
      }),
      "buildable",
    );
  });

  test("returns emerging when candidate api or public docs without callable api", () => {
    assert.equal(
      readinessTier({
        has_callable_api: false,
        has_candidate_api: true,
      }),
      "emerging",
    );
    assert.equal(
      readinessTier({
        has_callable_api: false,
        has_public_docs: true,
      }),
      "emerging",
    );
    assert.equal(
      readinessTier({
        has_callable_api: false,
        has_candidate_api: true,
        has_public_docs: true,
        has_source_repo: true,
        active_lifecycle: true,
      }),
      "emerging",
    );
  });

  test("returns identity-only when source repo or active lifecycle without api signals", () => {
    assert.equal(
      readinessTier({
        has_callable_api: false,
        has_candidate_api: false,
        has_public_docs: false,
        has_source_repo: true,
      }),
      "identity-only",
    );
    assert.equal(
      readinessTier({
        has_callable_api: false,
        has_candidate_api: false,
        has_public_docs: false,
        has_source_repo: false,
        active_lifecycle: true,
      }),
      "identity-only",
    );
    assert.equal(
      readinessTier({
        has_callable_api: false,
        has_source_repo: true,
        active_lifecycle: true,
      }),
      "identity-only",
    );
  });

  test("returns dormant when no positive signals are present", () => {
    assert.equal(
      readinessTier({
        has_callable_api: false,
        has_candidate_api: false,
        has_public_docs: false,
        has_source_repo: false,
        active_lifecycle: false,
      }),
      "dormant",
    );
    assert.equal(readinessTier({}), "dormant");
  });

  test("tier priority: callable api beats all other signals", () => {
    for (const tier of ["emerging", "identity-only", "dormant"]) {
      const base =
        tier === "emerging"
          ? { has_candidate_api: true }
          : tier === "identity-only"
            ? { has_source_repo: true }
            : {};
      assert.equal(
        readinessTier({ ...base, has_callable_api: true }),
        "buildable",
        `callable api must beat ${tier}`,
      );
    }
  });
});

// --- subnetIntegrationReadiness ---------------------------------------------

describe("subnetIntegrationReadiness", () => {
  test("exports READINESS_VERSION on every result", () => {
    const result = subnetIntegrationReadiness({
      services: [],
      lifecycle: "inactive",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    assert.equal(result.readiness_version, READINESS_VERSION);
    assert.equal(READINESS_VERSION, 2);
  });

  test("empty subnet scores zero and is dormant", () => {
    const result = subnetIntegrationReadiness({
      services: [],
      lifecycle: "inactive",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    assert.equal(result.score, 0);
    assert.equal(result.readiness_tier, "dormant");
    assert.deepEqual(result.components, {
      has_callable_api: false,
      documented: false,
      auth_clarity: false,
      callable_now: false,
      active_lifecycle: false,
      profile_complete: false,
      has_source_repo: false,
      has_public_docs: false,
      has_candidate_api: false,
    });
  });

  test("fully built-out callable subnet reaches 100", () => {
    const services = [
      mockService({
        schema_artifact: "openapi.json",
        auth_required: true,
        auth_schemes: ["bearer"],
        eligibility: { callable: true },
      }),
    ];
    const result = subnetIntegrationReadiness({
      services,
      lifecycle: "active",
      completenessScore: 90,
      sourceRepo: "https://github.com/x/y",
      docsUrl: "https://docs.example.com",
      candidates: [{ kind: "subnet-api" }],
    });
    assert.equal(result.score, 100);
    assert.equal(result.readiness_tier, "buildable");
    assert.equal(result.components.has_callable_api, true);
    assert.equal(result.components.documented, true);
    assert.equal(result.components.auth_clarity, true);
    assert.equal(result.components.callable_now, true);
    assert.equal(result.components.active_lifecycle, true);
    assert.equal(result.components.profile_complete, true);
    assert.equal(result.components.has_source_repo, true);
    assert.equal(result.components.has_public_docs, true);
    assert.equal(result.components.has_candidate_api, true);
  });

  test("score matrix: individual component weights", () => {
    const base = {
      services: [],
      lifecycle: "inactive",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    };
    assert.equal(
      subnetIntegrationReadiness({
        ...base,
        services: [mockService({ eligibility: { callable: false } })],
      }).score,
      45,
      "has_callable_api plus vacuous auth_clarity when no callable services",
    );
    assert.equal(
      subnetIntegrationReadiness({
        ...base,
        services: [
          mockService({
            schema_artifact: "x.json",
            eligibility: { callable: false },
          }),
        ],
      }).score,
      70,
      "documented plus catalogued service baseline",
    );
    assert.equal(
      subnetIntegrationReadiness({
        ...base,
        services: [
          mockService({
            auth_required: true,
            auth_schemes: ["apiKey"],
            eligibility: { callable: true },
          }),
        ],
      }).score,
      60,
      "auth_clarity + callable",
    );
    assert.equal(
      subnetIntegrationReadiness({ ...base, lifecycle: "active" }).score,
      10,
      "active_lifecycle",
    );
    assert.equal(
      subnetIntegrationReadiness({ ...base, completenessScore: 70 }).score,
      5,
      "profile_complete at threshold",
    );
    assert.equal(
      subnetIntegrationReadiness({ ...base, completenessScore: 69 }).score,
      0,
      "profile_complete below threshold",
    );
    assert.equal(
      subnetIntegrationReadiness({
        ...base,
        sourceRepo: "https://github.com/a/b",
      }).score,
      4,
      "has_source_repo",
    );
    assert.equal(
      subnetIntegrationReadiness({
        ...base,
        docsUrl: "https://docs.example.com",
      }).score,
      3,
      "has_public_docs",
    );
    assert.equal(
      subnetIntegrationReadiness({
        ...base,
        candidates: [{ kind: "subnet-api" }],
      }).score,
      4,
      "has_candidate_api",
    );
  });

  test("auth_clarity requires schemes when auth_required", () => {
    const unclear = subnetIntegrationReadiness({
      services: [
        mockService({
          auth_required: true,
          auth_schemes: [],
          eligibility: { callable: true },
        }),
      ],
      lifecycle: "active",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    assert.equal(unclear.components.auth_clarity, false);
    const clear = subnetIntegrationReadiness({
      services: [
        mockService({
          auth_required: true,
          auth_schemes: ["bearer"],
          eligibility: { callable: true },
        }),
      ],
      lifecycle: "active",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    assert.equal(clear.components.auth_clarity, true);
  });

  test("auth_clarity is vacuously true when no auth_required services", () => {
    const result = subnetIntegrationReadiness({
      services: [
        mockService({
          auth_required: false,
          auth_schemes: [],
          eligibility: { callable: true },
        }),
      ],
      lifecycle: "active",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    assert.equal(result.components.auth_clarity, true);
  });

  test("callable_now requires eligibility.callable", () => {
    const notCallable = subnetIntegrationReadiness({
      services: [mockService({ eligibility: { callable: false } })],
      lifecycle: "active",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    assert.equal(notCallable.components.callable_now, false);
    const callable = subnetIntegrationReadiness({
      services: [mockService({ eligibility: { callable: true } })],
      lifecycle: "active",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    assert.equal(callable.components.callable_now, true);
  });

  test("has_candidate_api only counts operational surface kinds", () => {
    for (const kind of OPERATIONAL_SURFACE_KINDS) {
      const withOp = subnetIntegrationReadiness({
        services: [],
        lifecycle: "inactive",
        completenessScore: 0,
        sourceRepo: null,
        docsUrl: null,
        candidates: [{ kind }],
      });
      assert.equal(
        withOp.components.has_candidate_api,
        true,
        `${kind} should count`,
      );
      assert.equal(withOp.readiness_tier, "emerging");
    }
    const nonOperational = subnetIntegrationReadiness({
      services: [],
      lifecycle: "inactive",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [{ kind: "website" }, { kind: "docs" }],
    });
    assert.equal(nonOperational.components.has_candidate_api, false);
  });

  test("score is capped at 100 even when all bonuses apply", () => {
    const result = subnetIntegrationReadiness({
      services: [
        mockService({
          schema_artifact: "x",
          auth_required: true,
          auth_schemes: ["bearer"],
          eligibility: { callable: true },
        }),
      ],
      lifecycle: "active",
      completenessScore: 100,
      sourceRepo: "https://github.com/a/b",
      docsUrl: "https://docs.example.com",
      candidates: [{ kind: "subnet-api" }, { kind: "sse" }],
    });
    assert.equal(result.score, 100);
  });

  test("docs-only subnet is emerging with score 3", () => {
    const result = subnetIntegrationReadiness({
      services: [],
      lifecycle: "inactive",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: "https://docs.example.com",
      candidates: [],
    });
    assert.equal(result.score, 3);
    assert.equal(result.readiness_tier, "emerging");
  });

  test("source-repo-only active subnet is identity-only", () => {
    const result = subnetIntegrationReadiness({
      services: [],
      lifecycle: "active",
      completenessScore: 0,
      sourceRepo: "https://github.com/a/b",
      docsUrl: null,
      candidates: [],
    });
    assert.equal(result.score, 14);
    assert.equal(result.readiness_tier, "identity-only");
  });
});

// --- buildAgentReadiness ----------------------------------------------------

describe("buildAgentReadiness", () => {
  test("callable subnet with complete profile has no blockers", () => {
    const stack = fullCallableStack();
    const result = buildAgentReadiness({
      subnet: stack.subnet,
      profile: stack.profile,
      services: [stack.service],
      readiness: stack.readiness,
      callableCount: 1,
    });
    assert.equal(result.status, "callable");
    assert.equal(result.blocker_level, "none");
    assert.equal(result.blockers.length, 0);
    assert.deepEqual(result.missing_fields, []);
  });

  test("root subnet is base-layer with hard blocker", () => {
    const subnet = mockSubnet({ netuid: 0, subnet_type: "root" });
    const profile = mockProfile({ subnet_type: "root" });
    const readiness = subnetIntegrationReadiness({
      services: [],
      lifecycle: "active",
      completenessScore: 80,
      sourceRepo: "https://github.com/a/b",
      docsUrl: "https://docs.example.com",
      candidates: [],
    });
    const result = buildAgentReadiness({
      subnet,
      profile,
      services: [],
      readiness,
      callableCount: 0,
    });
    assert.equal(result.status, "base-layer");
    assert.equal(result.blocker_level, "hard-blocked");
    assert.ok(
      result.blockers.some(
        (blocker: Row) => blocker.code === "base-layer-only",
      ),
    );
    assert.equal(
      result.blockers.find((b: Row) => b.code === "base-layer-only").severity,
      "hard",
    );
  });

  test("inactive lifecycle adds hard blocker", () => {
    const subnet = mockSubnet({ lifecycle: "inactive" });
    const readiness = subnetIntegrationReadiness({
      services: [],
      lifecycle: "inactive",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    const result = buildAgentReadiness({
      subnet,
      profile: mockProfile(),
      services: [],
      readiness,
      callableCount: 0,
    });
    assert.ok(
      result.blockers.some(
        (blocker: Row) => blocker.code === "inactive-lifecycle",
      ),
    );
    assert.equal(
      result.blockers.find((b: Row) => b.code === "inactive-lifecycle")
        .severity,
      "hard",
    );
  });

  test("missing services adds missing-callable-service blocker", () => {
    const readiness = subnetIntegrationReadiness({
      services: [],
      lifecycle: "active",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    const result = buildAgentReadiness({
      subnet: mockSubnet(),
      profile: mockProfile(),
      services: [],
      readiness,
      callableCount: 0,
    });
    assert.equal(result.status, "blocked");
    assert.ok(
      result.blockers.some(
        (blocker: Row) => blocker.code === "missing-callable-service",
      ),
    );
    assert.ok(result.missing_fields.includes("surfaces"));
  });

  test("non-callable services add service-not-callable hard blocker", () => {
    const service = mockService({ eligibility: { callable: false } });
    const readiness = subnetIntegrationReadiness({
      services: [service],
      lifecycle: "active",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    const result = buildAgentReadiness({
      subnet: mockSubnet(),
      profile: mockProfile(),
      services: [service],
      readiness,
      callableCount: 0,
    });
    assert.ok(
      result.blockers.some(
        (blocker: Row) => blocker.code === "service-not-callable",
      ),
    );
    assert.equal(result.blocker_level, "hard-blocked");
  });

  test("candidate api without callable services is candidate status", () => {
    const readiness = subnetIntegrationReadiness({
      services: [],
      lifecycle: "active",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [{ kind: "subnet-api" }],
    });
    const result = buildAgentReadiness({
      subnet: mockSubnet(),
      profile: mockProfile(),
      services: [],
      readiness,
      callableCount: 0,
    });
    assert.equal(result.status, "candidate");
    assert.equal(result.blocker_level, "needs-review");
    assert.ok(
      result.blockers.some(
        (blocker: Row) => blocker.code === "candidate-api-needs-review",
      ),
    );
  });

  test("no candidate api adds no-candidate-api missing-data blocker", () => {
    const readiness = subnetIntegrationReadiness({
      services: [],
      lifecycle: "active",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    const result = buildAgentReadiness({
      subnet: mockSubnet(),
      profile: mockProfile(),
      services: [],
      readiness,
      callableCount: 0,
    });
    assert.ok(
      result.blockers.some(
        (blocker: Row) => blocker.code === "no-candidate-api",
      ),
    );
  });

  test("callable without schema adds missing-schema blocker", () => {
    const service = mockService({ schema_artifact: null });
    const readiness = subnetIntegrationReadiness({
      services: [service],
      lifecycle: "active",
      completenessScore: 80,
      sourceRepo: "https://github.com/a/b",
      docsUrl: "https://docs.example.com",
      candidates: [],
    });
    const result = buildAgentReadiness({
      subnet: mockSubnet({
        source_repo: "https://github.com/a/b",
        docs_url: "https://docs.example.com",
      }),
      profile: mockProfile({ completeness_score: 80 }),
      services: [service],
      readiness,
      callableCount: 1,
    });
    assert.ok(
      result.blockers.some((blocker: Row) => blocker.code === "missing-schema"),
    );
    assert.ok(result.missing_fields.includes("schemas"));
  });

  test("callable with unclear auth adds unclear-auth blocker", () => {
    const service = mockService({
      schema_artifact: "x.json",
      auth_required: true,
      auth_schemes: [],
    });
    const readiness = subnetIntegrationReadiness({
      services: [service],
      lifecycle: "active",
      completenessScore: 80,
      sourceRepo: "https://github.com/a/b",
      docsUrl: "https://docs.example.com",
      candidates: [],
    });
    const result = buildAgentReadiness({
      subnet: mockSubnet({
        source_repo: "https://github.com/a/b",
        docs_url: "https://docs.example.com",
      }),
      profile: mockProfile({ completeness_score: 80 }),
      services: [service],
      readiness,
      callableCount: 1,
    });
    assert.ok(
      result.blockers.some((blocker: Row) => blocker.code === "unclear-auth"),
    );
  });

  test("missing docs and source repo blockers", () => {
    const service = mockService({ schema_artifact: "x.json" });
    const readiness = subnetIntegrationReadiness({
      services: [service],
      lifecycle: "active",
      completenessScore: 80,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    const result = buildAgentReadiness({
      subnet: mockSubnet(),
      profile: mockProfile({ completeness_score: 80 }),
      services: [service],
      readiness,
      callableCount: 1,
    });
    assert.ok(result.blockers.some((b: Row) => b.code === "missing-docs"));
    assert.ok(
      result.blockers.some((b: Row) => b.code === "missing-source-repo"),
    );
    assert.ok(result.missing_fields.includes("docs_url"));
    assert.ok(result.missing_fields.includes("source_repo"));
  });

  test("profile-incomplete blocker when completeness below 70", () => {
    const stack = fullCallableStack();
    stack.profile.completeness_score = 50;
    stack.readiness = subnetIntegrationReadiness({
      services: [stack.service],
      lifecycle: "active",
      completenessScore: 50,
      sourceRepo: stack.subnet.source_repo,
      docsUrl: stack.subnet.docs_url,
      candidates: [],
    });
    const result = buildAgentReadiness({
      subnet: stack.subnet,
      profile: stack.profile,
      services: [stack.service],
      readiness: stack.readiness,
      callableCount: 1,
    });
    assert.ok(
      result.blockers.some(
        (blocker: Row) => blocker.code === "profile-incomplete",
      ),
    );
    assert.equal(result.blocker_level, "missing-data");
  });

  test("needs-evidence status when docs or repo without callable or candidate", () => {
    const readiness = subnetIntegrationReadiness({
      services: [],
      lifecycle: "active",
      completenessScore: 0,
      sourceRepo: "https://github.com/a/b",
      docsUrl: null,
      candidates: [],
    });
    const result = buildAgentReadiness({
      subnet: mockSubnet({ source_repo: "https://github.com/a/b" }),
      profile: mockProfile(),
      services: [],
      readiness,
      callableCount: 0,
    });
    assert.equal(result.status, "needs-evidence");
  });

  test("missing_fields deduplicates and sorts", () => {
    const readiness = subnetIntegrationReadiness({
      services: [],
      lifecycle: "inactive",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    const result = buildAgentReadiness({
      subnet: mockSubnet(),
      profile: mockProfile(),
      services: [],
      readiness,
      callableCount: 0,
    });
    const fields = result.missing_fields;
    assert.deepEqual(fields, [...fields].sort());
    assert.equal(fields.length, new Set(fields).size);
  });

  test("subnet_type falls back from profile then subnet", () => {
    const readiness = subnetIntegrationReadiness({
      services: [],
      lifecycle: "active",
      completenessScore: 0,
      sourceRepo: null,
      docsUrl: null,
      candidates: [],
    });
    const fromProfile = buildAgentReadiness({
      subnet: mockSubnet({ subnet_type: "application" }),
      profile: mockProfile({ subnet_type: "root" }),
      services: [],
      readiness,
      callableCount: 0,
    });
    assert.ok(
      fromProfile.blockers.some((b: Row) => b.code === "base-layer-only"),
    );
    const fromSubnet = buildAgentReadiness({
      subnet: mockSubnet({ subnet_type: "root" }),
      profile: null,
      services: [],
      readiness,
      callableCount: 0,
    });
    assert.ok(
      fromSubnet.blockers.some((b: Row) => b.code === "base-layer-only"),
    );
  });
});

// --- summarizeAgentReadinessBlockers ----------------------------------------

describe("summarizeAgentReadinessBlockers", () => {
  test("aggregates status, level, severity, and code counts", () => {
    const blockedSubnets = [
      {
        agent_readiness: {
          status: "blocked",
          blocker_level: "missing-data",
          blockers: [
            { code: "missing-callable-service", severity: "missing-data" },
            { code: "no-candidate-api", severity: "missing-data" },
          ],
        },
      },
      {
        agent_readiness: {
          status: "base-layer",
          blocker_level: "hard-blocked",
          blockers: [{ code: "base-layer-only", severity: "hard" }],
        },
      },
      {
        agent_readiness: {
          status: "candidate",
          blocker_level: "needs-review",
          blockers: [
            { code: "candidate-api-needs-review", severity: "needs-review" },
            { code: "missing-docs", severity: "missing-data" },
          ],
        },
      },
    ];
    const summary = summarizeAgentReadinessBlockers(blockedSubnets);
    assert.equal(summary.by_status.blocked, 1);
    assert.equal(summary.by_status["base-layer"], 1);
    assert.equal(summary.by_status.candidate, 1);
    assert.equal(summary.by_level["missing-data"], 1);
    assert.equal(summary.by_level["hard-blocked"], 1);
    assert.equal(summary.by_level["needs-review"], 1);
    assert.equal(summary.by_severity["missing-data"], 3);
    assert.equal(summary.by_severity.hard, 1);
    assert.equal(summary.by_severity["needs-review"], 1);
    assert.equal(summary.by_code["missing-callable-service"], 1);
    assert.equal(summary.by_code["base-layer-only"], 1);
  });

  test("handles missing agent_readiness as unknown", () => {
    const summary = summarizeAgentReadinessBlockers([
      {},
      { agent_readiness: null },
    ]);
    assert.equal(summary.by_status.unknown, 2);
    assert.equal(summary.by_level.unknown, 2);
    assert.deepEqual(summary.by_severity, {});
    assert.deepEqual(summary.by_code, {});
  });

  test("count keys are lexicographically sorted", () => {
    const summary = summarizeAgentReadinessBlockers([
      {
        agent_readiness: {
          status: "blocked",
          blocker_level: "missing-data",
          blockers: [
            { code: "zebra", severity: "missing-data" },
            { code: "alpha", severity: "hard" },
          ],
        },
      },
    ]);
    assert.deepEqual(Object.keys(summary.by_code), ["alpha", "zebra"]);
    assert.deepEqual(Object.keys(summary.by_severity), [
      "hard",
      "missing-data",
    ]);
  });
});

// --- coverageDepthTier ------------------------------------------------------

describe("coverageDepthTier", () => {
  test("hard-blocked when agent blocker_level is hard-blocked", () => {
    assert.equal(
      coverageDepthTier({
        agentReadiness: { blocker_level: "hard-blocked" },
        dimensions: { callable_service_count: 5 },
        gaps: [],
        score: 95,
      }),
      "hard-blocked",
    );
  });

  test("agent-ready requires callable, no blockers, no gaps, score >= 80", () => {
    assert.equal(
      coverageDepthTier({
        agentReadiness: { blocker_level: "none", status: "callable" },
        dimensions: {
          callable_service_count: 1,
          candidate_operational_count: 0,
        },
        gaps: [],
        score: 80,
      }),
      "agent-ready",
    );
    assert.equal(
      coverageDepthTier({
        agentReadiness: { blocker_level: "none", status: "callable" },
        dimensions: {
          callable_service_count: 1,
          candidate_operational_count: 0,
        },
        gaps: [{ code: "x" }],
        score: 90,
      }),
      "machine-usable",
    );
    assert.equal(
      coverageDepthTier({
        agentReadiness: { blocker_level: "none", status: "callable" },
        dimensions: {
          callable_service_count: 1,
          candidate_operational_count: 0,
        },
        gaps: [],
        score: 79,
      }),
      "machine-usable",
    );
  });

  test("machine-usable when callable services exist but not agent-ready", () => {
    assert.equal(
      coverageDepthTier({
        agentReadiness: { blocker_level: "missing-data", status: "callable" },
        dimensions: {
          callable_service_count: 2,
          candidate_operational_count: 0,
        },
        gaps: [{ code: "missing-fixture" }],
        score: 60,
      }),
      "machine-usable",
    );
  });

  test("candidate-review for candidate status or operational candidates", () => {
    assert.equal(
      coverageDepthTier({
        agentReadiness: { blocker_level: "needs-review", status: "candidate" },
        dimensions: {
          callable_service_count: 0,
          candidate_operational_count: 0,
        },
        gaps: [],
        score: 10,
      }),
      "candidate-review",
    );
    assert.equal(
      coverageDepthTier({
        agentReadiness: { blocker_level: "missing-data", status: "blocked" },
        dimensions: {
          callable_service_count: 0,
          candidate_operational_count: 1,
        },
        gaps: [],
        score: 5,
      }),
      "candidate-review",
    );
  });

  test("needs-evidence status maps to needs-evidence tier", () => {
    assert.equal(
      coverageDepthTier({
        agentReadiness: {
          blocker_level: "missing-data",
          status: "needs-evidence",
        },
        dimensions: {
          callable_service_count: 0,
          candidate_operational_count: 0,
        },
        gaps: [],
        score: 5,
      }),
      "needs-evidence",
    );
  });

  test("missing-interface is the default fallback", () => {
    assert.equal(
      coverageDepthTier({
        agentReadiness: { blocker_level: "missing-data", status: "blocked" },
        dimensions: {
          callable_service_count: 0,
          candidate_operational_count: 0,
        },
        gaps: [],
        score: 0,
      }),
      "missing-interface",
    );
  });
});

// --- addCoverageDepthGap / sortCoverageDepthGaps ----------------------------

describe("addCoverageDepthGap", () => {
  test("deduplicates gaps by code", () => {
    const gaps: Row[] = [];
    const seen = new Set<string>();
    addCoverageDepthGap(gaps, seen, {
      code: "missing-fixture",
      severity: "missing-data",
    });
    addCoverageDepthGap(gaps, seen, {
      code: "missing-fixture",
      severity: "hard",
    });
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].severity, "missing-data");
  });
});

describe("sortCoverageDepthGaps", () => {
  test("sorts by severity rank then code", () => {
    const sorted = sortCoverageDepthGaps([
      { code: "zebra", severity: "missing-data" },
      { code: "alpha", severity: "needs-review" },
      { code: "beta", severity: "hard" },
      { code: "gamma", severity: "missing-data" },
    ]);
    assert.deepEqual(
      sorted.map((gap) => gap.code),
      ["beta", "alpha", "gamma", "zebra"],
    );
  });

  test("unknown severities sort last", () => {
    const sorted = sortCoverageDepthGaps([
      { code: "a", severity: "unknown" },
      { code: "b", severity: "missing-data" },
    ]);
    assert.equal(sorted[0].code, "b");
    assert.equal(sorted[1].code, "a");
  });

  test("COVERAGE_DEPTH_SEVERITY_RANK matches expected ordering", () => {
    assert.equal(COVERAGE_DEPTH_SEVERITY_RANK.hard, 0);
    assert.equal(COVERAGE_DEPTH_SEVERITY_RANK["needs-review"], 1);
    assert.equal(COVERAGE_DEPTH_SEVERITY_RANK["missing-data"], 2);
  });
});

// --- scoreCoverageDepthDimensions -------------------------------------------

describe("scoreCoverageDepthDimensions", () => {
  const emptyDimensions = {
    callable_service_count: 0,
    candidate_operational_count: 0,
    schema_service_count: 0,
    fixture_available_count: 0,
    fixture_status_counts: {},
    example_count: 0,
    sdk_count: 0,
    official_surface_count: 0,
    provider_claimed_surface_count: 0,
    registry_observed_surface_count: 0,
  };

  test("zero score for empty dimensions", () => {
    assert.equal(
      scoreCoverageDepthDimensions({
        dimensions: emptyDimensions,
        agentReadiness: { blocker_level: "hard-blocked" },
        completenessScore: 0,
      }),
      0,
    );
  });

  test("full stack reaches high score", () => {
    const score = scoreCoverageDepthDimensions({
      dimensions: {
        callable_service_count: 2,
        candidate_operational_count: 0,
        schema_service_count: 2,
        fixture_available_count: 2,
        fixture_status_counts: { available: 2 },
        example_count: 1,
        sdk_count: 1,
        official_surface_count: 1,
        provider_claimed_surface_count: 0,
        registry_observed_surface_count: 0,
      },
      agentReadiness: { blocker_level: "none" },
      completenessScore: 100,
    });
    assert.equal(score, 100);
  });

  test("candidate-only callable coverage is 30% of weight", () => {
    const score = scoreCoverageDepthDimensions({
      dimensions: {
        ...emptyDimensions,
        candidate_operational_count: 1,
      },
      agentReadiness: { blocker_level: "hard-blocked" },
      completenessScore: 0,
    });
    assert.equal(
      score,
      Math.round(COVERAGE_DEPTH_WEIGHTS.callable_service * 0.3),
    );
  });

  test("partial schema coverage scales schema weight", () => {
    const score = scoreCoverageDepthDimensions({
      dimensions: {
        ...emptyDimensions,
        callable_service_count: 4,
        schema_service_count: 2,
        fixture_status_counts: { missing: 4 },
      },
      agentReadiness: { blocker_level: "missing-data" },
      completenessScore: 0,
    });
    const expected =
      COVERAGE_DEPTH_WEIGHTS.callable_service +
      COVERAGE_DEPTH_WEIGHTS.schema_availability * 0.5 +
      COVERAGE_DEPTH_WEIGHTS.fixture_state * 0.4 +
      COVERAGE_DEPTH_WEIGHTS.readiness_blockers * 0.65;
    assert.equal(score, Math.round(expected));
  });

  test("fixture coverage uses 0.4 when explicit absence recorded", () => {
    const score = scoreCoverageDepthDimensions({
      dimensions: {
        ...emptyDimensions,
        callable_service_count: 1,
        schema_service_count: 1,
        fixture_available_count: 0,
        fixture_status_counts: { missing: 1 },
      },
      agentReadiness: { blocker_level: "none" },
      completenessScore: 0,
    });
    const fixturePart = Math.round(COVERAGE_DEPTH_WEIGHTS.fixture_state * 0.4);
    assert.ok(score >= fixturePart);
  });

  test("provenance tiers: official > provider-claimed > registry-observed", () => {
    const official = scoreCoverageDepthDimensions({
      dimensions: { ...emptyDimensions, official_surface_count: 1 },
      agentReadiness: { blocker_level: "hard-blocked" },
      completenessScore: 0,
    });
    const provider = scoreCoverageDepthDimensions({
      dimensions: { ...emptyDimensions, provider_claimed_surface_count: 1 },
      agentReadiness: { blocker_level: "hard-blocked" },
      completenessScore: 0,
    });
    const registry = scoreCoverageDepthDimensions({
      dimensions: { ...emptyDimensions, registry_observed_surface_count: 1 },
      agentReadiness: { blocker_level: "hard-blocked" },
      completenessScore: 0,
    });
    assert.equal(official, COVERAGE_DEPTH_WEIGHTS.provenance);
    assert.equal(provider, Math.round(COVERAGE_DEPTH_WEIGHTS.provenance * 0.6));
    assert.equal(
      registry,
      Math.round(COVERAGE_DEPTH_WEIGHTS.provenance * 0.35),
    );
    assert.ok(official > provider);
    assert.ok(provider > registry);
  });

  test("readiness blocker level scales readiness_blockers weight", () => {
    const levels = {
      none: 1,
      "missing-data": 0.65,
      "needs-review": 0.45,
      "hard-blocked": 0,
    };
    for (const [level, factor] of Object.entries(levels)) {
      const score = scoreCoverageDepthDimensions({
        dimensions: {
          ...emptyDimensions,
          callable_service_count: 1,
          schema_service_count: 1,
          fixture_status_counts: { available: 1 },
          fixture_available_count: 1,
        },
        agentReadiness: { blocker_level: level },
        completenessScore: 0,
      });
      const readinessPart = Math.round(
        COVERAGE_DEPTH_WEIGHTS.readiness_blockers * factor,
      );
      assert.ok(
        score >= readinessPart,
        `${level} should contribute ${readinessPart}`,
      );
    }
  });

  test("profile completeness contributes up to profile_completeness weight", () => {
    const half = scoreCoverageDepthDimensions({
      dimensions: emptyDimensions,
      agentReadiness: { blocker_level: "hard-blocked" },
      completenessScore: 50,
    });
    assert.equal(
      half,
      Math.round(COVERAGE_DEPTH_WEIGHTS.profile_completeness * 0.5),
    );
  });

  test("COVERAGE_DEPTH_WEIGHTS sum to 100", () => {
    const sum = Object.values(COVERAGE_DEPTH_WEIGHTS).reduce(
      (a, b) => a + b,
      0,
    );
    assert.equal(sum, 100);
  });
});

// --- coverageDepthPriorityScore ---------------------------------------------

describe("coverageDepthPriorityScore", () => {
  function row(overrides = {}) {
    return {
      subnet_type: "application",
      score: 50,
      curation_level: "community",
      blocker_level: "missing-data",
      dimensions: {
        callable_service_count: 1,
        candidate_operational_count: 0,
      },
      ...overrides,
    };
  }

  test("root subnet always scores 0", () => {
    assert.equal(
      coverageDepthPriorityScore({
        row: row({ subnet_type: "root" }),
        gaps: [{ severity: "missing-data" }],
      }),
      0,
    );
  });

  test("no actionable gaps scores 0", () => {
    assert.equal(
      coverageDepthPriorityScore({
        row: row(),
        gaps: [{ severity: "hard" }],
      }),
      0,
    );
    assert.equal(
      coverageDepthPriorityScore({
        row: row(),
        gaps: [],
      }),
      0,
    );
  });

  test("callable base is higher than candidate base", () => {
    const callable = coverageDepthPriorityScore({
      row: row({
        dimensions: {
          callable_service_count: 1,
          candidate_operational_count: 0,
        },
      }),
      gaps: [{ severity: "missing-data" }],
    });
    const candidate = coverageDepthPriorityScore({
      row: row({
        dimensions: {
          callable_service_count: 0,
          candidate_operational_count: 1,
        },
      }),
      gaps: [{ severity: "missing-data" }],
    });
    const bare = coverageDepthPriorityScore({
      row: row({
        dimensions: {
          callable_service_count: 0,
          candidate_operational_count: 0,
        },
      }),
      gaps: [{ severity: "missing-data" }],
    });
    assert.ok(callable > candidate);
    assert.ok(candidate > bare);
  });

  test("needs-review gaps weigh more than missing-data gaps", () => {
    const review = coverageDepthPriorityScore({
      row: row(),
      gaps: [{ severity: "needs-review" }],
    });
    const missing = coverageDepthPriorityScore({
      row: row(),
      gaps: [{ severity: "missing-data" }],
    });
    assert.ok(review > missing);
  });

  test("maintainer-reviewed removes review weight", () => {
    const community = coverageDepthPriorityScore({
      row: row({ curation_level: "community" }),
      gaps: [{ severity: "missing-data" }],
    });
    const reviewed = coverageDepthPriorityScore({
      row: row({ curation_level: "maintainer-reviewed" }),
      gaps: [{ severity: "missing-data" }],
    });
    assert.ok(community > reviewed);
    assert.equal(community - reviewed, 6);
  });

  test("hard-blocked penalty reduces score", () => {
    const normal = coverageDepthPriorityScore({
      row: row({ blocker_level: "missing-data" }),
      gaps: [{ severity: "missing-data" }],
    });
    const blocked = coverageDepthPriorityScore({
      row: row({ blocker_level: "hard-blocked" }),
      gaps: [{ severity: "missing-data" }],
    });
    assert.equal(normal - blocked, 35);
  });

  test("score is clamped to 0-100", () => {
    const high = coverageDepthPriorityScore({
      row: row({ score: 0, blocker_level: "missing-data" }),
      gaps: [
        { severity: "needs-review" },
        { severity: "needs-review" },
        { severity: "missing-data" },
        { severity: "missing-data" },
      ],
    });
    assert.ok(high <= 100);
    assert.ok(high >= 0);
  });
});

// --- buildCoverageDepthArtifact ---------------------------------------------

describe("buildCoverageDepthArtifact", () => {
  test("empty input produces valid artifact shell", () => {
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({ subnets: [] }),
    );
    assert.equal(artifact.schema_version, 1);
    assert.equal(artifact.contract_version, "test-contract");
    assert.equal(artifact.generated_at, "2026-06-25T00:00:00.000Z");
    assert.equal(artifact.coverage_depth_version, COVERAGE_DEPTH_VERSION);
    assert.equal(artifact.subnet_count, 0);
    assert.deepEqual(artifact.rows, []);
    assert.deepEqual(artifact.ranked_queue, []);
    assert.equal(artifact.summary.row_count, 0);
    assert.equal(artifact.summary.average_score, 0);
    assert.equal(artifact.summary.queue_count, 0);
    assert.deepEqual(artifact.scoring.weights, COVERAGE_DEPTH_WEIGHTS);
  });

  test("rows are sorted by netuid ascending", () => {
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [
          mockSubnet({ netuid: 30 }),
          mockSubnet({ netuid: 5 }),
          mockSubnet({ netuid: 12 }),
        ],
      }),
    );
    assert.deepEqual(
      artifact.rows.map((row: Row) => row.netuid),
      [5, 12, 30],
    );
  });

  test("summary invariants reconcile with rows", () => {
    const stack = fullCallableStack(7);
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [stack.subnet, mockSubnet({ netuid: 31 })],
        profiles: [[7, stack.profile]],
        surfaces: [[7, [stack.surface]]],
        services: [[7, [stack.service]]],
        readiness: [[7, stack.readiness]],
        agentReadiness: [[7, stack.agentReadiness]],
        examples: [[7, [{ surface_id: "ex-1" }]]],
      }),
    );
    assert.equal(artifact.summary.row_count, artifact.rows.length);
    assert.equal(artifact.subnet_count, artifact.rows.length);
    assert.equal(artifact.summary.queue_count, artifact.ranked_queue.length);
    assert.equal(
      (Object.values(artifact.summary.tier_counts) as number[]).reduce(
        (a, b) => a + b,
        0,
      ),
      artifact.rows.length,
    );
    assert.equal(
      (Object.values(artifact.summary.blocker_level_counts) as number[]).reduce(
        (a, b) => a + b,
        0,
      ),
      artifact.rows.length,
    );
    const avg =
      artifact.rows.length === 0
        ? 0
        : Math.round(
            artifact.rows.reduce(
              (sum: number, row: Row) => sum + row.score,
              0,
            ) / artifact.rows.length,
          );
    assert.equal(artifact.summary.average_score, avg);
  });

  test("ranked_queue ordering: priority desc, score asc, netuid asc", () => {
    const makeRowSubnet = (netuid: number, priorityHints: Row) => {
      const service = mockService({
        schema_artifact: priorityHints.schema ? "x.json" : null,
        fixture_status: {
          status: priorityHints.fixture ? "available" : "missing",
        },
        eligibility: { callable: true },
      });
      const subnet = mockSubnet({
        netuid,
        slug: `sn-${netuid}`,
        source_repo: priorityHints.repo ? "https://github.com/a/b" : null,
        docs_url: priorityHints.docs ? "https://docs.example.com" : null,
      });
      const profile = mockProfile({
        completeness_score: priorityHints.complete ? 85 : 40,
      });
      const readiness = subnetIntegrationReadiness({
        services: [service],
        lifecycle: "active",
        completenessScore: profile.completeness_score,
        sourceRepo: subnet.source_repo,
        docsUrl: subnet.docs_url,
        candidates: [],
      });
      const agentReadiness = buildAgentReadiness({
        subnet,
        profile,
        services: [service],
        readiness,
        callableCount: 1,
      });
      return {
        subnet,
        profile,
        service,
        surface: { kind: "subnet-api", authority: "official" },
        readiness,
        agentReadiness,
      };
    };

    const low = makeRowSubnet(10, {
      schema: true,
      fixture: false,
      repo: true,
      docs: true,
      complete: true,
    });
    const high = makeRowSubnet(20, {
      schema: false,
      fixture: false,
      repo: false,
      docs: false,
      complete: false,
    });

    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [low.subnet, high.subnet],
        profiles: [
          [10, low.profile],
          [20, high.profile],
        ],
        surfaces: [
          [10, [low.surface]],
          [20, [high.surface]],
        ],
        services: [
          [10, [low.service]],
          [20, [high.service]],
        ],
        readiness: [
          [10, low.readiness],
          [20, high.readiness],
        ],
        agentReadiness: [
          [10, low.agentReadiness],
          [20, high.agentReadiness],
        ],
      }),
    );

    assert.ok(artifact.ranked_queue.length >= 1);
    for (let index = 1; index < artifact.ranked_queue.length; index += 1) {
      const prev = artifact.ranked_queue[index - 1];
      const curr = artifact.ranked_queue[index];
      assert.ok(
        prev.priority_score > curr.priority_score ||
          (prev.priority_score === curr.priority_score &&
            (prev.score < curr.score ||
              (prev.score === curr.score && prev.netuid < curr.netuid))),
      );
    }
    if (artifact.ranked_queue.length >= 2) {
      assert.ok(
        artifact.ranked_queue[0].priority_score >=
          artifact.ranked_queue[1].priority_score,
      );
    }
  });

  test("ranked_queue respects COVERAGE_DEPTH_QUEUE_LIMIT", () => {
    const subnets: Row[] = [];
    const profiles: [number, Row][] = [];
    const services: [number, Row[]][] = [];
    const readiness: [number, Row][] = [];
    const agentReadiness: [number, Row][] = [];
    for (
      let netuid = 1;
      netuid <= COVERAGE_DEPTH_QUEUE_LIMIT + 5;
      netuid += 1
    ) {
      const service = mockService({ schema_artifact: null });
      const subnet = mockSubnet({ netuid, slug: `sn-${netuid}` });
      const profile = mockProfile({ completeness_score: 40 });
      const ready = subnetIntegrationReadiness({
        services: [service],
        lifecycle: "active",
        completenessScore: 40,
        sourceRepo: null,
        docsUrl: null,
        candidates: [],
      });
      const agent = buildAgentReadiness({
        subnet,
        profile,
        services: [service],
        readiness: ready,
        callableCount: 1,
      });
      subnets.push(subnet);
      profiles.push([netuid, profile]);
      services.push([netuid, [service]]);
      readiness.push([netuid, ready]);
      agentReadiness.push([netuid, agent]);
    }
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets,
        profiles,
        services,
        readiness,
        agentReadiness,
      }),
    );
    assert.ok(artifact.ranked_queue.length <= COVERAGE_DEPTH_QUEUE_LIMIT);
  });

  test("emits missing-fixture gap when fixtures absent", () => {
    const service = mockService({
      schema_artifact: "x.json",
      fixture_status: { status: "missing" },
    });
    const subnet = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [mockSubnet({ netuid: 7 })],
        services: [[7, [service]]],
        agentReadiness: [
          [
            7,
            {
              status: "callable",
              blocker_level: "missing-data",
              blockers: [],
              missing_fields: [],
            },
          ],
        ],
      }),
    );
    const row = subnet.rows.find((entry: Row) => entry.netuid === 7);
    assert.ok(row.top_gap_codes.includes("missing-fixture"));
    assert.ok(subnet.summary.gap_code_counts["missing-fixture"] >= 1);
  });

  test("emits partial-schema-coverage when mixed schema state", () => {
    const withSchema = mockService({
      schema_artifact: "a.json",
      fixture_status: { status: "missing" },
    });
    const withoutSchema = mockService({
      schema_artifact: null,
      fixture_status: { status: "missing" },
    });
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [mockSubnet({ netuid: 3 })],
        services: [[3, [withSchema, withoutSchema]]],
        agentReadiness: [
          [
            3,
            {
              status: "callable",
              blocker_level: "missing-data",
              blockers: [],
              missing_fields: [],
            },
          ],
        ],
      }),
    );
    const row = artifact.rows[0];
    assert.ok(row.top_gap_codes.includes("partial-schema-coverage"));
  });

  test("emits missing-example-or-sdk when no examples or sdk surfaces", () => {
    const service = mockService({
      schema_artifact: "x.json",
      fixture_status: { status: "available" },
    });
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [mockSubnet({ netuid: 4 })],
        services: [[4, [service]]],
        surfaces: [[4, [{ kind: "subnet-api", authority: "official" }]]],
        agentReadiness: [
          [
            4,
            {
              status: "callable",
              blocker_level: "none",
              blockers: [],
              missing_fields: [],
            },
          ],
        ],
        examples: [[4, []]],
      }),
    );
    assert.ok(
      artifact.rows[0].top_gap_codes.includes("missing-example-or-sdk"),
    );
  });

  test("emits missing-official-provenance for non-official surfaces", () => {
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [mockSubnet({ netuid: 8 })],
        surfaces: [
          [
            8,
            [
              { kind: "website", authority: "registry-observed" },
              { kind: "docs", authority: "provider-claimed" },
            ],
          ],
        ],
      }),
    );
    assert.ok(
      artifact.rows[0].top_gap_codes.includes("missing-official-provenance"),
    );
  });

  test("agent blockers flow into top_gaps with deduplication", () => {
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [mockSubnet({ netuid: 9 })],
        agentReadiness: [
          [
            9,
            {
              status: "blocked",
              blocker_level: "missing-data",
              blockers: [
                {
                  code: "missing-callable:service",
                  severity: "missing-data",
                  message: "x",
                  field: "surfaces",
                  next_action: "y",
                },
                {
                  code: "missing-callable-service",
                  severity: "missing-data",
                  message: "dup",
                  field: "surfaces",
                  next_action: "z",
                },
              ],
              missing_fields: ["surfaces"],
            },
          ],
        ],
      }),
    );
    const codes = artifact.rows[0].top_gaps.map((gap: Row) => gap.code);
    assert.equal(
      codes.filter((c: string) => c === "missing-callable-service").length,
      1,
    );
  });

  test("root subnet excluded from ranked_queue (priority 0)", () => {
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [mockSubnet({ netuid: 0, subnet_type: "root" })],
        profiles: [[0, mockProfile({ subnet_type: "root" })]],
        agentReadiness: [
          [
            0,
            {
              status: "base-layer",
              blocker_level: "hard-blocked",
              blockers: [
                {
                  code: "base-layer-only",
                  severity: "hard",
                  message: "m",
                  field: "subnet_type",
                  next_action: "n",
                },
              ],
              missing_fields: [],
            },
          ],
        ],
      }),
    );
    assert.equal(artifact.rows[0].priority_score, 0);
    assert.equal(artifact.ranked_queue.length, 0);
    assert.equal(artifact.rows[0].tier, "hard-blocked");
  });

  test("recommended_next_action prefers first non-hard gap", () => {
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [mockSubnet({ netuid: 11 })],
        agentReadiness: [
          [
            11,
            {
              status: "blocked",
              blocker_level: "hard-blocked",
              blockers: [
                {
                  code: "inactive-lifecycle",
                  severity: "hard",
                  message: "hard",
                  field: "lifecycle",
                  next_action: "wait",
                },
                {
                  code: "missing-docs",
                  severity: "missing-data",
                  message: "docs",
                  field: "docs_url",
                  next_action: "add docs",
                },
              ],
              missing_fields: ["docs_url"],
            },
          ],
        ],
      }),
    );
    assert.equal(artifact.rows[0].recommended_next_action, "add docs");
  });

  test("ranked_queue entries carry rank starting at 1", () => {
    const stack = fullCallableStack(15);
    stack.service.schema_artifact = null;
    stack.service.fixture_status = { status: "missing" };
    stack.agentReadiness = buildAgentReadiness({
      subnet: stack.subnet,
      profile: stack.profile,
      services: [stack.service],
      readiness: stack.readiness,
      callableCount: 1,
    });
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [stack.subnet],
        profiles: [[15, stack.profile]],
        surfaces: [[15, [stack.surface]]],
        services: [[15, [stack.service]]],
        readiness: [[15, stack.readiness]],
        agentReadiness: [[15, stack.agentReadiness]],
      }),
    );
    if (artifact.ranked_queue.length > 0) {
      assert.equal(artifact.ranked_queue[0].rank, 1);
      assert.ok(artifact.ranked_queue[0].recommended_next_action);
    }
  });

  test("dimensions include service kinds and fixture status counts", () => {
    const s1 = mockService({
      kind: "subnet-api",
      schema_artifact: "a.json",
      fixture_status: { status: "available" },
    });
    const s2 = mockService({
      kind: "sse",
      schema_artifact: null,
      eligibility: { callable: true },
      fixture_status: { status: "missing" },
    });
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [mockSubnet({ netuid: 2 })],
        services: [[2, [s1, s2]]],
        surfaces: [
          [
            2,
            [
              { kind: "sdk", authority: "official" },
              { kind: "subnet-api", authority: "official" },
            ],
          ],
        ],
        candidates: [[2, [{ kind: "subnet-api" }, { kind: "website" }]]],
      }),
    );
    const dims = artifact.rows[0].dimensions;
    assert.equal(dims.callable_service_count, 2);
    assert.deepEqual(dims.service_kinds, ["sse", "subnet-api"]);
    assert.equal(dims.schema_service_count, 1);
    assert.equal(dims.schema_missing_count, 1);
    assert.equal(dims.fixture_available_count, 1);
    assert.equal(dims.sdk_count, 1);
    assert.equal(dims.candidate_count, 2);
    assert.equal(dims.candidate_operational_count, 1);
    assert.ok(dims.fixture_status_counts.available >= 1);
    assert.ok(dims.fixture_status_counts.missing >= 1);
  });

  test("capture-failed fixture status triggers missing-fixture gap", () => {
    const service = mockService({
      schema_artifact: "x.json",
      fixture_status: { status: "capture-failed" },
    });
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [mockSubnet({ netuid: 6 })],
        services: [[6, [service]]],
        agentReadiness: [
          [
            6,
            {
              status: "callable",
              blocker_level: "missing-data",
              blockers: [],
              missing_fields: [],
            },
          ],
        ],
      }),
    );
    assert.ok(artifact.rows[0].top_gap_codes.includes("missing-fixture"));
  });

  test("top_gaps limited to six entries", () => {
    const blockers = Array.from({ length: 10 }, (_, index) => ({
      code: `blocker-${String(index).padStart(2, "0")}`,
      severity: "missing-data",
      message: `m${index}`,
      field: `f${index}`,
      next_action: `a${index}`,
    }));
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [mockSubnet({ netuid: 99 })],
        agentReadiness: [
          [
            99,
            {
              status: "blocked",
              blocker_level: "missing-data",
              blockers,
              missing_fields: [],
            },
          ],
        ],
      }),
    );
    assert.equal(artifact.rows[0].top_gaps.length, 6);
    assert.equal(artifact.rows[0].top_gap_codes.length, 6);
  });

  test("end-to-end pipeline matches readiness + agent + coverage for callable subnet", () => {
    const stack = fullCallableStack(42);
    const artifact = buildCoverageDepthArtifact(
      buildCoverageDepthInput({
        subnets: [stack.subnet],
        profiles: [[42, stack.profile]],
        surfaces: [[42, [stack.surface]]],
        services: [[42, [stack.service]]],
        readiness: [[42, stack.readiness]],
        agentReadiness: [[42, stack.agentReadiness]],
        examples: [[42, [{ surface_id: "ex" }]]],
      }),
    );
    const row = artifact.rows[0];
    assert.equal(row.netuid, 42);
    assert.equal(row.agent_status, "callable");
    assert.equal(row.blocker_level, "none");
    assert.equal(row.readiness_score, stack.readiness.score);
    assert.equal(row.completeness_score, 85);
    assert.equal(row.tier, "agent-ready");
    assert.equal(row.score, 99);
    assert.equal(row.priority_score, 0);
    assert.equal(row.top_gaps.length, 0);
  });
});

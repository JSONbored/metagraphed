// Build-time integration + coverage-depth readiness, extracted verbatim from
// scripts/build-artifacts.mjs (#1901 maintainability decomposition). Pure +
// side-effect free: every function takes plain objects and returns plain objects,
// with no module state and no I/O, so the output is byte-identical to the in-
// build-artifacts.mjs originals. Imported directly by scripts/build-artifacts.mjs
// and unit-tested in tests/build-readiness.test.mjs.
import { OPERATIONAL_SURFACE_KINDS } from "../../src/health-probe-core.ts";

export const READINESS_VERSION = 2;

function countBy(items, keyOrFn) {
  return Object.fromEntries(
    Object.entries(
      items.reduce((accumulator, item) => {
        const key =
          typeof keyOrFn === "function" ? keyOrFn(item) : item[keyOrFn];
        accumulator[key] = (accumulator[key] || 0) + 1;
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}

// Codified, OBJECTIVE "can a developer build on this subnet today" score
// (0-100), composed only from deterministic build-time signals — never the live
// 15-minute prober — so it stays a reproducible committed value. The live "is it
// up right now" dimension is intentionally separate (get_subnet_health / the
// health overlay). Components are published so agents can re-weight to their own
// needs. Rubric: docs/integration-readiness.md.
// #356: a categorical readiness gradient that turns the API-less long tail into
// a ranked curation pipeline instead of a single 0-15 cliff. Derived purely from
// components (not the numeric score) so the tier stays stable if weights move.
export function readinessTier(components) {
  if (components.has_callable_api) return "buildable";
  if (components.has_candidate_api || components.has_public_docs)
    return "emerging";
  if (components.has_source_repo || components.active_lifecycle)
    return "identity-only";
  return "dormant";
}

export function subnetIntegrationReadiness({
  services,
  lifecycle,
  completenessScore,
  sourceRepo,
  docsUrl,
  candidates,
}) {
  const callable = services.filter((service) => service.eligibility.callable);
  const components = {
    has_callable_api: services.length > 0,
    documented: services.some((service) => Boolean(service.schema_artifact)),
    auth_clarity:
      services.length > 0 &&
      callable.every(
        (service) => !service.auth_required || service.auth_schemes.length > 0,
      ),
    callable_now: callable.length > 0,
    active_lifecycle: lifecycle === "active",
    profile_complete: (completenessScore ?? 0) >= 70,
    // #356: low-weight, NON-API signals so the ~99 API-less subnets stop
    // cliffing at one score and rank as a curation pipeline. has_public_docs is
    // any docs link (distinct from `documented`, which needs a verified schema);
    // has_candidate_api is an unverified community-flagged operational surface.
    has_source_repo: Boolean(sourceRepo),
    has_public_docs: Boolean(docsUrl),
    has_candidate_api: (candidates ?? []).some((candidate) =>
      OPERATIONAL_SURFACE_KINDS.includes(candidate.kind),
    ),
  };
  const score = Math.min(
    100,
    (components.has_callable_api ? 30 : 0) +
      (components.documented ? 25 : 0) +
      (components.auth_clarity ? 15 : 0) +
      (components.callable_now ? 15 : 0) +
      (components.active_lifecycle ? 10 : 0) +
      (components.profile_complete ? 5 : 0) +
      // Low-weight curation-pipeline signals (#356) — they spread the API-less
      // tail without disturbing the API-led top (the sum still caps at 100).
      (components.has_source_repo ? 4 : 0) +
      (components.has_candidate_api ? 4 : 0) +
      (components.has_public_docs ? 3 : 0),
  );
  return {
    score,
    readiness_tier: readinessTier(components),
    readiness_version: READINESS_VERSION,
    components,
  };
}

export function buildAgentReadiness({
  subnet,
  profile,
  services,
  readiness,
  callableCount,
}) {
  const components = readiness?.components || {};
  const subnetType = profile?.subnet_type || subnet.subnet_type || null;
  const blockers = [];
  const add = (code, severity, message, field, nextAction) => {
    blockers.push({
      code,
      severity,
      message,
      field,
      next_action: nextAction,
    });
  };

  if (subnetType === "root") {
    add(
      "base-layer-only",
      "hard",
      "Root/base-layer surfaces are not application-subnet APIs.",
      "subnet_type",
      "Use get_best_rpc_endpoint or /api/v1/rpc/endpoints for chain RPC access.",
    );
  }
  if (!components.active_lifecycle) {
    add(
      "inactive-lifecycle",
      "hard",
      "The subnet is not marked active in the registry snapshot.",
      "lifecycle",
      "Wait for an active mainnet subnet before recommending it for integrations.",
    );
  }
  if ((services || []).length === 0) {
    add(
      "missing-callable-service",
      "missing-data",
      "No public-safe callable service is catalogued for this subnet yet.",
      "surfaces",
      "Find and verify an official subnet-api, OpenAPI, SSE, or data-artifact surface.",
    );
  } else if (callableCount === 0) {
    add(
      "service-not-callable",
      "hard",
      "Catalogued services exist, but none are structurally callable.",
      "services.eligibility.callable",
      "Review unsafe/dead service classifications before recommending this subnet.",
    );
  }
  if (components.has_candidate_api && callableCount === 0) {
    add(
      "candidate-api-needs-review",
      "needs-review",
      "A candidate operational surface exists but has not been promoted into the callable catalog.",
      "registry.candidates",
      "Verify the candidate surface and promote it if it is public, safe, and subnet-owned.",
    );
  }
  if (!components.has_candidate_api && callableCount === 0) {
    add(
      "no-candidate-api",
      "missing-data",
      "No candidate API surface has been found for this subnet.",
      "registry.candidates",
      "Search official docs, source repos, and project sites for a public integration surface.",
    );
  }
  if (!components.documented && callableCount > 0) {
    add(
      "missing-schema",
      "missing-data",
      "At least one callable service exists, but no captured schema artifact is available.",
      "schemas",
      "Capture an official OpenAPI/Swagger/JSON Schema source or document that no schema exists.",
    );
  }
  if (!components.auth_clarity && callableCount > 0) {
    add(
      "unclear-auth",
      "missing-data",
      "Callable services exist, but auth requirements are not fully machine-readable.",
      "auth",
      "Declare auth_required/auth_schemes or capture auth metadata from the service schema.",
    );
  }
  if (!components.has_public_docs) {
    add(
      "missing-docs",
      "missing-data",
      "No public documentation link is recorded.",
      "docs_url",
      "Add an official docs URL or document that no public docs exist.",
    );
  }
  if (!components.has_source_repo) {
    add(
      "missing-source-repo",
      "missing-data",
      "No public source repository is recorded.",
      "source_repo",
      "Add an official source repo or document that no public repo exists.",
    );
  }
  if (!components.profile_complete) {
    add(
      "profile-incomplete",
      "missing-data",
      "The subnet profile is below the completeness threshold used by integration readiness.",
      "completeness_score",
      "Fill the missing required and operational registry fields for this subnet.",
    );
  }

  const status =
    callableCount > 0
      ? "callable"
      : subnetType === "root"
        ? "base-layer"
        : components.has_candidate_api
          ? "candidate"
          : components.has_public_docs || components.has_source_repo
            ? "needs-evidence"
            : "blocked";
  const blockerLevel = blockers.some((blocker) => blocker.severity === "hard")
    ? "hard-blocked"
    : blockers.some((blocker) => blocker.severity === "needs-review")
      ? "needs-review"
      : blockers.length > 0
        ? "missing-data"
        : "none";

  return {
    status,
    blocker_level: blockerLevel,
    blockers,
    missing_fields: [
      ...new Set(
        blockers
          .filter((blocker) => blocker.severity === "missing-data")
          .map((blocker) => blocker.field),
      ),
    ].sort(),
  };
}

export function summarizeAgentReadinessBlockers(blockedSubnets) {
  const blockers = blockedSubnets.flatMap(
    (subnet) => subnet.agent_readiness?.blockers || [],
  );
  return {
    by_status: countBy(
      blockedSubnets,
      (subnet) => subnet.agent_readiness?.status || "unknown",
    ),
    by_level: countBy(
      blockedSubnets,
      (subnet) => subnet.agent_readiness?.blocker_level || "unknown",
    ),
    by_severity: countBy(blockers, "severity"),
    by_code: countBy(blockers, "code"),
  };
}

export const COVERAGE_DEPTH_VERSION = 1;
export const COVERAGE_DEPTH_WEIGHTS = {
  callable_service: 25,
  schema_availability: 15,
  fixture_state: 10,
  examples_or_sdk: 10,
  provenance: 15,
  readiness_blockers: 15,
  profile_completeness: 10,
};
export const COVERAGE_DEPTH_QUEUE_LIMIT = 100;
export const COVERAGE_DEPTH_SEVERITY_RANK = {
  hard: 0,
  "needs-review": 1,
  "missing-data": 2,
};

export function coverageDepthTier({ agentReadiness, dimensions, gaps, score }) {
  if (agentReadiness?.blocker_level === "hard-blocked") {
    return "hard-blocked";
  }
  if (
    dimensions.callable_service_count > 0 &&
    agentReadiness?.blocker_level === "none" &&
    gaps.length === 0 &&
    score >= 80
  ) {
    return "agent-ready";
  }
  if (dimensions.callable_service_count > 0) {
    return "machine-usable";
  }
  if (
    agentReadiness?.status === "candidate" ||
    dimensions.candidate_operational_count > 0
  ) {
    return "candidate-review";
  }
  if (agentReadiness?.status === "needs-evidence") {
    return "needs-evidence";
  }
  return "missing-interface";
}

export function addCoverageDepthGap(gaps, seenCodes, gap) {
  if (seenCodes.has(gap.code)) return;
  seenCodes.add(gap.code);
  gaps.push(gap);
}

export function sortCoverageDepthGaps(gaps) {
  return [...gaps].sort((a, b) => {
    const severityDelta =
      (COVERAGE_DEPTH_SEVERITY_RANK[a.severity] ?? 9) -
      (COVERAGE_DEPTH_SEVERITY_RANK[b.severity] ?? 9);
    if (severityDelta !== 0) return severityDelta;
    return a.code.localeCompare(b.code);
  });
}

export function scoreCoverageDepthDimensions({
  dimensions,
  agentReadiness,
  completenessScore,
}) {
  const callableCoverage =
    dimensions.callable_service_count > 0
      ? 1
      : dimensions.candidate_operational_count > 0
        ? 0.3
        : 0;
  const schemaCoverage =
    dimensions.callable_service_count > 0
      ? dimensions.schema_service_count / dimensions.callable_service_count
      : 0;
  const explicitFixtureAbsenceCount = Object.values(
    dimensions.fixture_status_counts,
  ).reduce((sum, count) => sum + count, 0);
  const fixtureCoverage =
    dimensions.callable_service_count > 0
      ? dimensions.fixture_available_count > 0
        ? dimensions.fixture_available_count / dimensions.callable_service_count
        : explicitFixtureAbsenceCount > 0
          ? 0.4
          : 0
      : 0;
  const exampleSdkCoverage =
    dimensions.example_count + dimensions.sdk_count > 0 ? 1 : 0;
  const provenanceCoverage =
    dimensions.official_surface_count > 0
      ? 1
      : dimensions.provider_claimed_surface_count > 0
        ? 0.6
        : dimensions.registry_observed_surface_count > 0
          ? 0.35
          : 0;
  const readinessCoverage =
    agentReadiness?.blocker_level === "none"
      ? 1
      : agentReadiness?.blocker_level === "missing-data"
        ? 0.65
        : agentReadiness?.blocker_level === "needs-review"
          ? 0.45
          : 0;
  const profileCoverage = Math.max(
    0,
    Math.min(1, Number(completenessScore || 0) / 100),
  );

  return Math.round(
    COVERAGE_DEPTH_WEIGHTS.callable_service * callableCoverage +
      COVERAGE_DEPTH_WEIGHTS.schema_availability * schemaCoverage +
      COVERAGE_DEPTH_WEIGHTS.fixture_state * fixtureCoverage +
      COVERAGE_DEPTH_WEIGHTS.examples_or_sdk * exampleSdkCoverage +
      COVERAGE_DEPTH_WEIGHTS.provenance * provenanceCoverage +
      COVERAGE_DEPTH_WEIGHTS.readiness_blockers * readinessCoverage +
      COVERAGE_DEPTH_WEIGHTS.profile_completeness * profileCoverage,
  );
}

export function coverageDepthPriorityScore({ row, gaps }) {
  const actionableGaps = gaps.filter((gap) => gap.severity !== "hard");
  if (row.subnet_type === "root" || actionableGaps.length === 0) {
    return 0;
  }
  const severityWeight = actionableGaps.reduce((sum, gap) => {
    if (gap.severity === "needs-review") return sum + 18;
    return sum + 12;
  }, 0);
  const base =
    row.dimensions.callable_service_count > 0
      ? 42
      : row.dimensions.candidate_operational_count > 0
        ? 30
        : 14;
  const deficitWeight = Math.round((100 - row.score) * 0.25);
  const reviewWeight = row.curation_level === "maintainer-reviewed" ? 0 : 6;
  const hardBlockerPenalty = row.blocker_level === "hard-blocked" ? 35 : 0;
  return Math.max(
    0,
    Math.min(
      100,
      base +
        Math.min(32, severityWeight) +
        deficitWeight +
        reviewWeight -
        hardBlockerPenalty,
    ),
  );
}

export function buildCoverageDepthArtifact({
  subnets,
  profileByNetuid,
  surfacesByNetuid,
  servicesByNetuid,
  candidatesByNetuid,
  readinessByNetuid,
  agentReadinessByNetuid,
  examplesByNetuid,
  generatedAt,
  contractVersion,
}) {
  const rows = subnets
    .map((subnet) => {
      const profile = profileByNetuid.get(subnet.netuid) || null;
      const subnetSurfaces = surfacesByNetuid.get(subnet.netuid) || [];
      const services = servicesByNetuid.get(subnet.netuid) || [];
      const callableServices = services.filter(
        (service) => service.eligibility?.callable,
      );
      const candidatesForSubnet = candidatesByNetuid.get(subnet.netuid) || [];
      const agentReadiness = agentReadinessByNetuid.get(subnet.netuid) || {
        status: "blocked",
        blocker_level: "missing-data",
        blockers: [],
        missing_fields: [],
      };
      const readiness = readinessByNetuid.get(subnet.netuid) || {
        score: 0,
      };
      const examples = examplesByNetuid.get(subnet.netuid) || [];
      const sdkCount = subnetSurfaces.filter(
        (surface) => surface.kind === "sdk",
      ).length;
      const fixtureStatusCounts = countBy(
        callableServices,
        (service) => service.fixture_status?.status || "missing",
      );
      const dimensions = {
        surface_count: subnetSurfaces.length,
        official_surface_count: subnetSurfaces.filter(
          (surface) => surface.authority === "official",
        ).length,
        registry_observed_surface_count: subnetSurfaces.filter(
          (surface) => surface.authority === "registry-observed",
        ).length,
        provider_claimed_surface_count: subnetSurfaces.filter(
          (surface) => surface.authority === "provider-claimed",
        ).length,
        service_count: services.length,
        callable_service_count: callableServices.length,
        service_kinds: [
          ...new Set(callableServices.map((service) => service.kind)),
        ].sort(),
        schema_service_count: callableServices.filter(
          (service) => service.schema_artifact,
        ).length,
        schema_missing_count: callableServices.filter(
          (service) => !service.schema_artifact,
        ).length,
        fixture_available_count: callableServices.filter(
          (service) => service.fixture_status?.status === "available",
        ).length,
        fixture_status_counts: fixtureStatusCounts,
        example_count: examples.length,
        sdk_count: sdkCount,
        candidate_count: candidatesForSubnet.length,
        candidate_operational_count: candidatesForSubnet.filter((candidate) =>
          OPERATIONAL_SURFACE_KINDS.includes(candidate.kind),
        ).length,
        data_artifact_count: callableServices.filter(
          (service) => service.kind === "data-artifact",
        ).length,
        source_repo_present: Boolean(subnet.source_repo),
        docs_url_present: Boolean(subnet.docs_url),
      };
      const score = scoreCoverageDepthDimensions({
        dimensions,
        agentReadiness,
        completenessScore: profile?.completeness_score,
      });
      const gaps = [];
      const seenGapCodes = new Set();
      for (const blocker of agentReadiness.blockers || []) {
        addCoverageDepthGap(gaps, seenGapCodes, blocker);
      }
      if (
        dimensions.callable_service_count > 0 &&
        dimensions.schema_missing_count > 0 &&
        dimensions.schema_service_count > 0
      ) {
        addCoverageDepthGap(gaps, seenGapCodes, {
          code: "partial-schema-coverage",
          severity: "missing-data",
          message:
            "Some callable services have captured schemas, but at least one callable service is still schema-less.",
          field: "schemas",
          next_action:
            "Capture or explicitly mark schema absence for the remaining callable services.",
        });
      }
      if (
        dimensions.callable_service_count > 0 &&
        dimensions.fixture_available_count === 0 &&
        ((dimensions.fixture_status_counts.missing || 0) > 0 ||
          (dimensions.fixture_status_counts["capture-failed"] || 0) > 0)
      ) {
        addCoverageDepthGap(gaps, seenGapCodes, {
          code: "missing-fixture",
          severity: "missing-data",
          message:
            "Callable services exist, but no sanitized request/response fixture is available.",
          field: "fixtures",
          next_action:
            "Run fixture capture in write mode or document why the callable surface cannot publish a public sample.",
        });
      }
      if (
        dimensions.callable_service_count > 0 &&
        dimensions.example_count + dimensions.sdk_count === 0
      ) {
        addCoverageDepthGap(gaps, seenGapCodes, {
          code: "missing-example-or-sdk",
          severity: "missing-data",
          message:
            "Callable services exist, but no example or SDK surface is recorded.",
          field: "examples",
          next_action:
            "Add an official quickstart, SDK, or minimal code example for this subnet.",
        });
      }
      if (
        dimensions.surface_count > 0 &&
        dimensions.official_surface_count === 0
      ) {
        addCoverageDepthGap(gaps, seenGapCodes, {
          code: "missing-official-provenance",
          severity: "needs-review",
          message:
            "Surfaces are catalogued, but none are marked operator-official.",
          field: "authority",
          next_action:
            "Verify whether any recorded surface is first-party, or add official evidence.",
        });
      }
      const sortedGaps = sortCoverageDepthGaps(gaps);
      const row = {
        netuid: subnet.netuid,
        slug: subnet.slug,
        name: subnet.name,
        subnet_type: profile?.subnet_type || subnet.subnet_type || null,
        curation_level: profile?.curation_level || null,
        profile_level: profile?.profile_level || null,
        score,
        tier: coverageDepthTier({
          agentReadiness,
          dimensions,
          gaps: sortedGaps,
          score,
        }),
        priority_score: 0,
        agent_status: agentReadiness.status,
        blocker_level: agentReadiness.blocker_level,
        readiness_score: readiness.score,
        completeness_score: profile?.completeness_score ?? null,
        dimensions,
        top_gaps: sortedGaps.slice(0, 6),
        top_gap_codes: sortedGaps.slice(0, 6).map((gap) => gap.code),
        recommended_next_action:
          sortedGaps.find((gap) => gap.severity !== "hard")?.next_action ||
          sortedGaps[0]?.next_action ||
          null,
      };
      row.priority_score = coverageDepthPriorityScore({
        row,
        gaps: sortedGaps,
      });
      return row;
    })
    .sort((a, b) => a.netuid - b.netuid);

  const rankedQueue = rows
    .filter((row) => row.priority_score > 0 && row.top_gaps.length > 0)
    .sort((a, b) => {
      const priorityDelta = b.priority_score - a.priority_score;
      if (priorityDelta !== 0) return priorityDelta;
      const scoreDelta = a.score - b.score;
      if (scoreDelta !== 0) return scoreDelta;
      return a.netuid - b.netuid;
    })
    .slice(0, COVERAGE_DEPTH_QUEUE_LIMIT)
    .map((row, index) => {
      const primaryGap =
        row.top_gaps.find((gap) => gap.severity !== "hard") || row.top_gaps[0];
      return {
        rank: index + 1,
        netuid: row.netuid,
        slug: row.slug,
        name: row.name,
        tier: row.tier,
        score: row.score,
        priority_score: row.priority_score,
        severity: primaryGap.severity,
        top_gap_codes: row.top_gap_codes,
        recommended_next_action:
          row.recommended_next_action || primaryGap.next_action,
      };
    });
  const allTopGaps = rows.flatMap((row) => row.top_gaps);
  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    coverage_depth_version: COVERAGE_DEPTH_VERSION,
    subnet_count: rows.length,
    summary: {
      row_count: rows.length,
      agent_ready_count: rows.filter((row) => row.tier === "agent-ready")
        .length,
      callable_subnet_count: rows.filter(
        (row) => row.dimensions.callable_service_count > 0,
      ).length,
      blocked_subnet_count: rows.filter(
        (row) => row.blocker_level === "hard-blocked",
      ).length,
      queue_count: rankedQueue.length,
      average_score:
        rows.length === 0
          ? 0
          : Math.round(
              rows.reduce((sum, row) => sum + row.score, 0) / rows.length,
            ),
      tier_counts: countBy(rows, "tier"),
      blocker_level_counts: countBy(rows, "blocker_level"),
      severity_counts: countBy(allTopGaps, "severity"),
      gap_code_counts: countBy(allTopGaps, "code"),
    },
    scoring: {
      methodology:
        "Deterministic build-time score over callable services, schema coverage, fixture state, examples/SDKs, provenance, readiness blockers, and profile completeness. Live health is intentionally separate.",
      weights: COVERAGE_DEPTH_WEIGHTS,
    },
    rows,
    ranked_queue: rankedQueue,
  };
}

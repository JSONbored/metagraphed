interface ArtifactBudget {
  path: string;
  warn_bytes: number;
  fail_bytes: number;
}

export const ARTIFACT_SIZE_BUDGETS: ArtifactBudget[] = [
  budget("candidates.json", 4_500_000, 8_000_000),
  budget("review-queue.json", 4_500_000, 8_000_000),
  budget("verification/latest.json", 3_000_000, 5_000_000),
  // METAGRAPHED-9/A (#stale-publish-pipeline): the registry's organic growth (new
  // subnets/providers/endpoints from ongoing contributor PRs) pushed both actual
  // sizes past the old fail_bytes ceiling (endpoints.json 5,271,281 >= 5,000,000;
  // surfaces.json 4,020,869 >= 4,000,000), hard-failing publish-cloudflare.yml's
  // validate:artifact-budgets step on every run since ~2026-07-17 -- the whole
  // publish (R2 artifacts + the KV `latest` pointer) never reaches its upload
  // step, so the live site kept serving that stale run indefinitely (this budget
  // check has no partial-failure path; one over-budget artifact blocks every
  // artifact). Raised with real headroom above current size, not just enough to
  // clear it today, so ongoing registry growth doesn't reopen the same outage in
  // a few weeks; still bounded well below "no budget at all" so a genuinely
  // runaway artifact (a bug, not organic growth) still fails loudly.
  budget("surfaces.json", 5_500_000, 8_000_000),
  budget("endpoints.json", 6_500_000, 9_000_000),
  budget("providers/*/endpoints.json", 1_000_000, 3_000_000),
  budget("evidence-ledger.json", 2_500_000, 4_000_000),
  budget("health/history/*.json", 800_000, 1_500_000),
  // #8778: search.json was at 1,951,556 against a 2,000,000 FAIL line -- 97.6%
  // of the ceiling, one subnet away from hard-failing the publish, and
  // invisible because it was one warning among 44. That near-miss is the whole
  // argument for this issue.
  budget("search.json", 2_500_000, 4_000_000),
  budget("search-index.json", 1_500_000, 3_000_000),
  // #8698 documented the network-addressed form of every network-scoped route,
  // taking the spec from 202 to 278 paths and openapi.json from 2,198,245 to
  // 2,836,062 bytes -- past the old 2,500,000 fail ceiling. There was no way to
  // land it under that ceiling: 76 new paths cost ~638KB pretty-printed against
  // ~302KB of headroom, and even de-duplicating the by-network examples (each is
  // byte-identical to its base route's) only recovers ~180KB. Since
  // validate:artifact-budgets has no partial-failure path, leaving this ceiling
  // in place would fail publish-cloudflare.yml outright and freeze the live site
  // on stale artifacts -- the METAGRAPHED-9/A outage above, reopened. Raised with
  // real headroom for the route families still to come (testnet indexing, #8700)
  // rather than just enough to clear today, while staying low enough that a
  // runaway spec (a generator bug, not deliberate route growth) still fails.
  budget("openapi.json", 3_000_000, 4_500_000),
  // Per-surface schema snapshots now embed the full upstream OpenAPI document.
  budget("schemas/*.json", 1_500_000, 5_000_000),
  // #8778: 887,631 against a 1,000,000 fail line -- 88.8%, the second
  // near-miss the noise was hiding.
  budget("profiles.json", 1_200_000, 2_000_000),
  budget("review/profile-completeness.json", 350_000, 1_000_000),
  budget("review/enrichment-evidence.json", 500_000, 1_000_000),
  budget("review/enrichment-queue.json", 500_000, 1_000_000),
  budget("review/enrichment-targets.json", 1_100_000, 1_500_000),

  // #8778: the per-subnet detail families. 24 of the 44 chronic warnings were
  // these inheriting DEFAULT_BUDGET's 250,000 warn line, which never described
  // them -- a large subnet's detail artifact is LEGITIMATELY bigger than a
  // small one's, and SN49's is 792KB. Sized from the real maximum with warn at
  // roughly 1.25-1.5x it (so the largest one growing another quarter is a
  // signal) and fail at ~3x (so a generator bug still fails loudly).
  budget("subnets/*.json", 1_000_000, 2_500_000),
  budget("profiles/*.json", 700_000, 2_000_000),
  budget("agent-catalog/*.json", 600_000, 1_500_000),
  budget("endpoints/*.json", 400_000, 1_500_000),
  budget("surfaces/*.json", 400_000, 1_500_000),
  // Top-level artifacts that were also only ever matched by DEFAULT_BUDGET.
  // Same sizing rule; listed individually because they grow for unrelated
  // reasons and should not share one line.
  budget("subnets.json", 550_000, 1_500_000),
  // Per-NETWORK, not per-subnet: build-network-registry.ts writes
  // `${prefix}/subnets.json` for every non-default network, so the budget is
  // keyed the same way rather than naming testnet specifically. Sized from
  // testnet's 471KB, which is the largest today.
  budget("*/subnets.json", 650_000, 1_500_000),
  budget("api-index.json", 500_000, 1_500_000),
  budget("coverage-depth.json", 550_000, 1_500_000),
  budget("operational-surfaces.json", 600_000, 1_500_000),
  budget("metagraph/latest.json", 550_000, 1_500_000),
  budget("review/curation.json", 450_000, 1_500_000),
];

const DEFAULT_BUDGET = budget("*", 250_000, 1_000_000);

interface ArtifactSize {
  path: string;
  size_bytes: number;
}

interface ArtifactBudgetResult extends ArtifactSize {
  warn_bytes: number;
  fail_bytes: number;
  status: "ok" | "warn" | "fail";
}

export function evaluateArtifactBudgets(
  artifactSizes: ArtifactSize[],
): ArtifactBudgetResult[] {
  return artifactSizes.map((artifact) => {
    const configured = budgetForArtifact(artifact.path);
    const status =
      artifact.size_bytes >= configured.fail_bytes
        ? "fail"
        : artifact.size_bytes >= configured.warn_bytes
          ? "warn"
          : "ok";
    return {
      path: artifact.path,
      size_bytes: artifact.size_bytes,
      warn_bytes: configured.warn_bytes,
      fail_bytes: configured.fail_bytes,
      status,
    };
  });
}

export function summarizeArtifactBudgets(results: ArtifactBudgetResult[]): {
  fail_count: number;
  ok_count: number;
  warn_count: number;
} {
  return {
    fail_count: results.filter((result) => result.status === "fail").length,
    ok_count: results.filter((result) => result.status === "ok").length,
    warn_count: results.filter((result) => result.status === "warn").length,
  };
}

function budgetForArtifact(path: string): ArtifactBudget {
  return (
    ARTIFACT_SIZE_BUDGETS.find((entry) => budgetMatches(entry.path, path)) ||
    DEFAULT_BUDGET
  );
}

function budgetMatches(pattern: string, path: string): boolean {
  if (pattern === path) {
    return true;
  }
  if (!pattern.includes("*")) {
    return false;
  }
  // `*` is a single path-segment glob — it must not cross a `/`. A plain
  // prefix/suffix check let `schemas/*.json` swallow `schemas/sn-6/openapi.json`
  // and apply the wrong budget; anchor each `*` to one segment ([^/]*) so a
  // nested artifact falls back to the default budget, as the patterns intend.
  const regexSource = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${regexSource}$`).test(path);
}

function budget(
  path: string,
  warnBytes: number,
  failBytes: number,
): ArtifactBudget {
  return {
    path,
    warn_bytes: warnBytes,
    fail_bytes: failBytes,
  };
}

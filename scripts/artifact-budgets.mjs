export const ARTIFACT_SIZE_BUDGETS = [
  budget("candidates.json", 4_500_000, 8_000_000),
  budget("review-queue.json", 4_500_000, 8_000_000),
  budget("verification/latest.json", 3_000_000, 5_000_000),
  budget("surfaces.json", 1_500_000, 4_000_000),
  budget("endpoints.json", 2_500_000, 5_000_000),
  budget("providers/*/endpoints.json", 1_000_000, 3_000_000),
  budget("evidence-ledger.json", 1_000_000, 3_000_000),
  budget("health/history/*.json", 650_000, 1_250_000),
  budget("search.json", 750_000, 2_000_000),
  // Slim companion to search.json (same document set, fewer fields). Registry
  // growth pushed it past the default 1MB fail ceiling while main was already
  // red on Validate — give it its own budget instead of the "*" default.
  budget("search-index.json", 1_000_000, 1_500_000),
  budget("openapi.json", 1_800_000, 2_500_000),
  // Per-surface schema snapshots now embed the full upstream OpenAPI document.
  budget("schemas/*.json", 1_500_000, 5_000_000),
  budget("profiles.json", 700_000, 1_000_000),
  budget("review/profile-completeness.json", 350_000, 1_000_000),
  budget("review/enrichment-evidence.json", 500_000, 1_000_000),
  budget("review/enrichment-queue.json", 500_000, 1_000_000),
  budget("review/enrichment-targets.json", 1_100_000, 1_500_000),
];

const DEFAULT_BUDGET = budget("*", 250_000, 1_000_000);

export function evaluateArtifactBudgets(artifactSizes) {
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

export function summarizeArtifactBudgets(results) {
  return {
    fail_count: results.filter((result) => result.status === "fail").length,
    ok_count: results.filter((result) => result.status === "ok").length,
    warn_count: results.filter((result) => result.status === "warn").length,
  };
}

function budgetForArtifact(path) {
  return (
    ARTIFACT_SIZE_BUDGETS.find((entry) => budgetMatches(entry.path, path)) ||
    DEFAULT_BUDGET
  );
}

function budgetMatches(pattern, path) {
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

function budget(path, warnBytes, failBytes) {
  return {
    path,
    warn_bytes: warnBytes,
    fail_bytes: failBytes,
  };
}

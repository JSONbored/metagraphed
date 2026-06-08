export const ARTIFACT_SIZE_BUDGETS = [
  budget("candidates.json", 4_000_000, 8_000_000),
  budget("review-queue.json", 4_000_000, 8_000_000),
  budget("verification/latest.json", 3_000_000, 5_000_000),
  budget("surfaces.json", 1_500_000, 4_000_000),
  budget("endpoints.json", 1_750_000, 4_000_000),
  budget("providers/*/endpoints.json", 1_000_000, 3_000_000),
  budget("evidence-ledger.json", 1_000_000, 3_000_000),
  budget("health/latest.json", 1_000_000, 3_000_000),
  budget("health/history/*.json", 400_000, 1_000_000),
  budget("search.json", 750_000, 2_000_000),
  budget("openapi.json", 500_000, 1_000_000),
  budget("profiles.json", 500_000, 1_000_000),
  budget("review/enrichment-evidence.json", 500_000, 1_000_000),
  budget("review/enrichment-queue.json", 500_000, 1_000_000),
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
  const [prefix, suffix] = pattern.split("*");
  return path.startsWith(prefix) && path.endsWith(suffix);
}

function budget(path, warnBytes, failBytes) {
  return {
    path,
    warn_bytes: warnBytes,
    fail_bytes: failBytes,
  };
}

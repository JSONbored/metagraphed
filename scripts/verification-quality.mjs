export function preservePreviousGithubMetadata(result, previousByCandidate) {
  if (
    result.kind !== "source-repo" ||
    result.status !== "ok" ||
    !["live", "redirected"].includes(result.classification)
  ) {
    return result;
  }

  const currentSignals = result.quality_signals || {};
  const hasCurrentGithubMetadata =
    currentSignals.archived !== undefined ||
    currentSignals.has_default_branch !== undefined ||
    currentSignals.has_recent_push_metadata !== undefined;
  if (hasCurrentGithubMetadata) {
    return result;
  }

  const previous = previousByCandidate.get(result.candidate_id);
  if (
    !previous ||
    previous.status !== "ok" ||
    !["live", "redirected"].includes(previous.classification)
  ) {
    return result;
  }

  const previousSignals = previous.quality_signals || {};
  const preservedSignals = stripUndefined({
    archived: previousSignals.archived,
    has_default_branch: previousSignals.has_default_branch,
    has_recent_push_metadata: previousSignals.has_recent_push_metadata,
  });
  if (Object.keys(preservedSignals).length === 0) {
    return result;
  }

  return {
    ...result,
    confidence_score: Math.max(
      Number(result.confidence_score || 0),
      Number(previous.confidence_score || 0),
    ),
    quality_signals: {
      ...currentSignals,
      ...preservedSignals,
    },
  };
}

function stripUndefined(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  );
}

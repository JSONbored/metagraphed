type Row = Record<string, unknown>;

export function preservePreviousGithubMetadata(
  result: Row,
  previousByCandidate: Map<unknown, Row>,
): Row {
  const previous = previousByCandidate.get(result.candidate_id);
  if (isRetryableFailure(result) && isPreviouslyHealthy(previous)) {
    return {
      ...result,
      classification: previous.classification,
      confidence_score: Math.max(
        Number(result.confidence_score || 0),
        Number(previous.confidence_score || 0),
      ),
      content_type: previous.content_type ?? result.content_type,
      error: previous.error ?? null,
      private_redirect_blocked:
        previous.private_redirect_blocked ?? result.private_redirect_blocked,
      quality_signals: previous.quality_signals || result.quality_signals,
      redirect_target: previous.redirect_target ?? result.redirect_target,
      status: previous.status || result.status,
    };
  }

  if (
    result.kind !== "source-repo" ||
    result.status !== "ok" ||
    !["live", "redirected"].includes(result.classification as string)
  ) {
    return result;
  }

  const currentSignals = (result.quality_signals as Row | undefined) || {};
  const hasCurrentGithubMetadata =
    currentSignals.archived !== undefined ||
    currentSignals.has_default_branch !== undefined ||
    currentSignals.has_recent_push_metadata !== undefined;
  if (hasCurrentGithubMetadata) {
    return result;
  }

  if (
    !previous ||
    previous.status !== "ok" ||
    !["live", "redirected"].includes(previous.classification as string)
  ) {
    return result;
  }

  const previousSignals = (previous.quality_signals as Row | undefined) || {};
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

export function optionalHttpStatus(statusCode: unknown): number | undefined {
  return Number.isInteger(statusCode) ? (statusCode as number) : undefined;
}

function isRetryableFailure(result: Row): boolean {
  return ["rate-limited", "timeout", "transient"].includes(
    result?.classification as string,
  );
}

function isPreviouslyHealthy(previous: Row | undefined): previous is Row {
  return (
    previous?.status === "ok" &&
    ["live", "redirected"].includes(previous?.classification as string)
  );
}

function stripUndefined(value: Row): Row {
  return Object.fromEntries(
    Object.entries(value).filter(([, nested]) => nested !== undefined),
  );
}

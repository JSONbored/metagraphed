// Surface kinds a caller actually invokes programmatically (vs reference kinds
// like docs/website/source-repo). Drives the `callable` flag + readiness tier.
export const CALLABLE_READINESS_KINDS = new Set([
  "subnet-api",
  "openapi",
  "sse",
  "data-artifact",
  "subtensor-rpc",
  "subtensor-wss",
  "archive",
]);

// Pure, display-only integration-readiness projection for one curated surface.
// Composes the caller-actionable auth + rate-limit + schema fields into clarity
// sub-scores, a 0-100 readiness_score, and a tier — so a caller can see "which
// surfaces can I actually call, and how completely is the call documented" at a
// glance. Lives here (not in workers/api.mjs) so the GraphQL layer can import
// without creating an api.mjs → graphql.mjs → api.mjs circular dependency.
export function computeSurfaceReadiness(surface) {
  const auth = surface.auth ?? null;
  // auth clarity 0-3: scheme is required when auth is present, so its presence
  // alone is +1; +1 for a location; +1 for a name or value_format.
  let authClarityScore = 0;
  if (auth) {
    authClarityScore =
      1 + (auth.location ? 1 : 0) + (auth.name || auth.value_format ? 1 : 0);
  }
  const rateLimit = surface.rate_limit ?? null;
  // rate-limit clarity 0-2: requests+window are required when present, so a
  // structured block is +1; +1 when it also scopes the limit (per-key/ip/...).
  let rateLimitClarityScore = 0;
  if (rateLimit) {
    rateLimitClarityScore = 1 + (rateLimit.scope ? 1 : 0);
  }
  // schema clarity 0-2: a machine-readable spec is the strongest integration signal.
  const schemaClarityScore =
    surface.schema_status === "machine-readable"
      ? 2
      : surface.schema_status === "ui-only"
        ? 1
        : 0;

  const callable = CALLABLE_READINESS_KINDS.has(surface.kind);
  // Normalize the three clarity dims (max 3 + 2 + 2 = 7) to a 0-100 score.
  const readinessScore = Math.round(
    ((authClarityScore + rateLimitClarityScore + schemaClarityScore) / 7) * 100,
  );
  // A non-callable (reference) surface is never "ready to call"; a callable
  // one is graded by how completely its call is documented.
  let readinessTier;
  if (!callable) {
    readinessTier = "reference";
  } else if (readinessScore >= 70) {
    readinessTier = "ready";
  } else if (readinessScore >= 30) {
    readinessTier = "callable-unverified";
  } else {
    readinessTier = "blocked";
  }

  return {
    surface_id: surface.id,
    surface_key: surface.key ?? null,
    netuid: surface.netuid,
    subnet_slug: surface.subnet_slug ?? null,
    subnet_name: surface.subnet_name ?? null,
    kind: surface.kind,
    provider: surface.provider ?? null,
    authority: surface.authority ?? null,
    url: surface.url,
    auth_required: surface.auth_required ?? null,
    auth,
    rate_limit: rateLimit,
    schema_status: surface.schema_status ?? null,
    schema_url: surface.schema_url ?? null,
    stale: surface.stale ?? null,
    last_verified_at: surface.last_verified_at ?? null,
    callable,
    auth_clarity_score: authClarityScore,
    rate_limit_clarity_score: rateLimitClarityScore,
    schema_clarity_score: schemaClarityScore,
    readiness_score: readinessScore,
    readiness_tier: readinessTier,
  };
}

// The closed value sets a query FILTER accepts, shared by both published
// surfaces (#10131).
//
// These lived in `src/contracts.ts`, which meant an MCP tool could not read
// them: importing `contracts.ts` from `schemas-src/` is the dependency edge
// that failed the metagraphed-data-api Workers Build twice on #10121. So the
// tools restated the values instead -- and restating an enum is how
// `list_subnets.status` came to publish a bare `{"type":"string"}` while its
// route named `active | inactive`, leaving an agent to guess (#10115).
//
// Pure literals, zero imports, so any surface can read them. `contracts.ts`
// re-exports the symbol, so the 31 existing import sites are unchanged.

export const QUERY_ENUMS = {
  candidateState: [
    "schema-invalid",
    "schema-valid",
    "maintainer-review",
    "verified",
    "stale",
    "rejected",
  ],
  coverageLevel: ["native-only", "manifested", "probed"],
  curationLevel: [
    "native",
    "candidate-discovered",
    "community-seeded",
    "machine-verified",
    "maintainer-reviewed",
    "adapter-backed",
  ],
  healthClassification: [
    "auth-required",
    "content-mismatch",
    "dead",
    "live",
    "rate-limited",
    "redirected",
    "timeout",
    "transient",
    "unsupported",
    "unsafe",
    "wrong-chain",
  ],
  healthStatus: ["ok", "degraded", "failed", "unknown"],
  providerAuthority: [
    "community",
    "official",
    "provider-claimed",
    "registry-observed",
  ],
  providerKind: [
    "data-provider",
    "docs-provider",
    "infrastructure-provider",
    "registry",
    "subnet-team",
  ],
  profileLevel: [
    "directory-only",
    "identity-partial",
    "identity-complete",
    "operational",
    "adapter-backed",
  ],
  subnetStatus: ["active", "inactive"],
  subnetType: ["root", "application"],
  endpointLayer: [
    "bittensor-base",
    "data-provider",
    "docs-provider",
    "subnet-app",
  ],
  endpointPublicationState: [
    "candidate",
    "verified",
    "monitored",
    "pool-eligible",
    "disabled",
    "rejected",
  ],
  coverageDepthTier: [
    "agent-ready",
    "machine-usable",
    "candidate-review",
    "needs-evidence",
    "hard-blocked",
    "missing-interface",
  ],
  agentReadinessStatus: [
    "callable",
    "base-layer",
    "candidate",
    "needs-evidence",
    "blocked",
  ],
  agentBlockerLevel: ["none", "hard-blocked", "needs-review", "missing-data"],
  endpointIncidentSeverity: ["critical", "warning", "info"],
  endpointIncidentState: ["active", "resolved"],
  recommendedAdapterKind: [
    "custom-adapter",
    "data-artifact-adapter",
    "generic-openapi-or-custom",
    "stream-adapter",
  ],
  surfaceKind: [
    "archive",
    "dashboard",
    "data-artifact",
    "docs",
    "example",
    "openapi",
    "repo-registry",
    "sdk",
    "source-repo",
    "sse",
    "subnet-api",
    "subtensor-rpc",
    "subtensor-wss",
    "website",
  ],
};

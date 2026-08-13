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
//
// `as const` so a consumer can hand a member list straight to `z.enum()`
// (#10060). Without it these are `string[]`, which `z.enum` cannot take, and
// every consumer that wanted a schema wrote the values out again instead --
// which is how `surfaceKind` came to exist twice, in two orders, with the
// routes publishing one and the MCP tools the other.

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
  /**
   * Top-level sections of `/api/v1/subnets/{netuid}`, selectable via `sections=`
   * (#10600).
   *
   * A DIFFERENT UNIT FROM `fields`, which is why it is a different parameter.
   * `fields` picks columns out of the rows of a list, everywhere it appears;
   * this picks whole cards out of one composite document. Same idea, different
   * unit of selection -- and `fieldsSchema`'s published description says "row
   * field names", so overloading the name would have meant one parameter with
   * two meanings and nothing telling a caller which they got.
   *
   * WHY PAGING DOES NOT SUBSTITUTE. The route's 272,825 B is not one dominant
   * list: `endpoints`, `surfaces`, `verified_surfaces` and `candidate_surfaces`
   * are four parallel arrays over the same subject (76/76/76/16 on subnet 64).
   * A query collection pages ONE data_key, so declaring one here would narrow a
   * quarter of the payload and leave the rest -- a response that looks bounded
   * while staying fat.
   *
   * The ENVELOPE is not listed and is never projected away: schema_version,
   * contract_version, generated_at, operational_observed_at and health_source
   * identify what the caller is holding, and a document that cannot say what it
   * is or when it was built is not a smaller document, it is an anonymous one.
   */
  subnetDetailSection: [
    "subnet",
    "economics",
    "endpoints",
    "surfaces",
    "verified_surfaces",
    "candidate_surfaces",
    "candidates",
    "gaps",
    "notes",
  ],
  /** Top-level sections of `/api/v1/subnets/{netuid}/profile` (#10600). Its own
   * list rather than a shared one: the profile carries `profile` and no
   * `economics`/`candidates`/`verified_surfaces`, and a shared vocabulary would
   * let a caller ask this route for a section it can never return. */
  subnetProfileSection: [
    "subnet",
    "profile",
    "endpoints",
    "surfaces",
    "candidate_surfaces",
    "gaps",
    "notes",
  ],
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
} as const;

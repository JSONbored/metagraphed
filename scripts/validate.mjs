import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  backfilledIdentityUrl,
  flattenSurfaces,
  loadCandidates,
  loadVerification,
  loadNativeSnapshot,
  loadProviders,
  loadSubnets,
  isCredentialedUrl,
  isValidUrl,
  nativeDisplayName,
  nativeNameQuality,
  listJsonFilesRecursive,
  cleanDescription,
  deriveDomainTags,
  subnetLifecycle,
  publicMetagraphRoot,
  readJson,
  registrySurfaceKey,
  repoRoot,
  slugify,
  stableStringify,
} from "./lib.mjs";
import {
  R2_STAGING_RELATIVE_ROOT,
  artifactStorageTierForRelativePath,
} from "../src/artifact-storage.mjs";

const providerKinds = new Set([
  "subnet-team",
  "infrastructure-provider",
  "data-provider",
  "docs-provider",
  "registry",
]);

const authorities = new Set([
  "official",
  "provider-claimed",
  "community",
  "registry-observed",
]);

const subnetStatuses = new Set(["active", "inactive", "unknown"]);

const surfaceKinds = new Set([
  "archive",
  "subtensor-rpc",
  "subtensor-wss",
  "subnet-api",
  "openapi",
  "sse",
  "sdk",
  "example",
  "website",
  "source-repo",
  "dashboard",
  "repo-registry",
  "docs",
  "data-artifact",
]);

const probeMethods = new Set(["GET", "HEAD", "JSON-RPC", "WSS-RPC"]);
const probeExpectations = new Set(["json", "html", "sse", "any"]);
const coverageLevels = new Set(["native-only", "manifested", "probed"]);
const subnetTypes = new Set(["root", "application"]);
const nativeNameQualities = new Set(["chain", "placeholder", "empty"]);
const candidateStates = new Set([
  "schema-invalid",
  "schema-valid",
  "maintainer-review",
  "verified",
  "stale",
  "rejected",
]);
const curationLevels = new Set([
  "native",
  "candidate-discovered",
  "machine-verified",
  "maintainer-reviewed",
  "adapter-backed",
]);
const reviewStates = new Set([
  "unreviewed",
  "machine-generated",
  "maintainer-reviewed",
  "needs-review",
  "stale",
]);
const verificationClassifications = new Set([
  "live",
  "redirected",
  "auth-required",
  "dead",
  "unsafe",
  "unsupported",
  "rate-limited",
  "transient",
  "timeout",
  "content-mismatch",
]);
const reviewDecisions = new Set([
  "maintainer-reviewed",
  "needs-review",
  "stale",
]);

const slugPattern = /^[a-z0-9][a-z0-9-]*$/;

const errors = [];

function assert(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function validateProvider(provider) {
  assert(
    provider.schema_version === 1,
    `${provider.id || "provider"}: schema_version must be 1`,
  );
  assert(
    slugPattern.test(provider.id || ""),
    `${provider.id || "provider"}: invalid provider id`,
  );
  assert(Boolean(provider.name), `${provider.id}: name is required`);
  assert(
    providerKinds.has(provider.kind),
    `${provider.id}: invalid provider kind`,
  );
  assert(
    isValidUrl(provider.website_url),
    `${provider.id}: website_url must be a URL`,
  );
  for (const key of ["docs_url", "github_url", "team_url", "contact_url"]) {
    if (provider[key] === undefined) {
      continue;
    }
    assert(isValidUrl(provider[key]), `${provider.id}: ${key} must be a URL`);
  }
  assert(
    authorities.has(provider.authority),
    `${provider.id}: invalid authority`,
  );
}

function validateSubnet(
  subnet,
  providerIds,
  surfaceIds,
  surfaceLocators,
  registryVerificationEvidence,
) {
  assert(
    subnet.schema_version === 1,
    `${subnet.slug || "subnet"}: schema_version must be 1`,
  );
  assert(
    Number.isInteger(subnet.netuid) && subnet.netuid >= 0,
    `${subnet.slug}: netuid must be a non-negative integer`,
  );
  assert(Boolean(subnet.name), `${subnet.slug}: name is required`);
  assert(
    slugPattern.test(subnet.slug || ""),
    `${subnet.name || "subnet"}: invalid slug`,
  );
  assert(subnetStatuses.has(subnet.status), `${subnet.slug}: invalid status`);
  assert(
    Array.isArray(subnet.categories),
    `${subnet.slug}: categories must be an array`,
  );
  if (subnet.docs_url !== undefined) {
    assert(
      isValidUrl(subnet.docs_url),
      `${subnet.slug}: docs_url must be a URL`,
    );
  }
  for (const key of [
    "source_repo",
    "dashboard_url",
    "website_url",
    "logo_url",
  ]) {
    if (subnet[key] !== undefined && subnet[key] !== null) {
      assert(
        isValidUrl(subnet[key]),
        `${subnet.slug}: ${key} must be a URL or null`,
      );
    }
  }
  validateCuration(subnet.slug, subnet.curation);
  validateLinks(subnet.slug, subnet.links || []);
  assert(
    Array.isArray(subnet.surfaces),
    `${subnet.slug}: surfaces must be an array`,
  );

  for (const surface of subnet.surfaces || []) {
    const surfaceKey = `${subnet.slug}:${surface.id || "surface"}`;
    assert(
      slugPattern.test(surface.id || ""),
      `${surfaceKey}: invalid surface id`,
    );
    assert(
      !surfaceIds.has(surface.id),
      `${surfaceKey}: duplicate global surface id`,
    );
    surfaceIds.add(surface.id);
    const locator = registrySurfaceKey({
      ...surface,
      netuid: subnet.netuid,
    });
    assert(
      !surfaceLocators.has(locator),
      `${surfaceKey}: duplicate public surface locator ${locator}`,
    );
    surfaceLocators.add(locator);
    assert(Boolean(surface.name), `${surfaceKey}: name is required`);
    assert(surfaceKinds.has(surface.kind), `${surfaceKey}: invalid kind`);
    assert(isValidUrl(surface.url), `${surfaceKey}: url must be a URL`);
    assert(
      providerIds.has(surface.provider),
      `${surfaceKey}: unknown provider ${surface.provider}`,
    );
    assert(
      typeof surface.auth_required === "boolean",
      `${surfaceKey}: auth_required must be boolean`,
    );
    assert(
      authorities.has(surface.authority),
      `${surfaceKey}: invalid authority`,
    );
    assert(
      typeof surface.public_safe === "boolean",
      `${surfaceKey}: public_safe must be boolean`,
    );

    if (surface.schema_url !== undefined) {
      assert(
        isValidUrl(surface.schema_url),
        `${surfaceKey}: schema_url must be a URL`,
      );
    }
    if (surface.source_urls !== undefined) {
      assert(
        Array.isArray(surface.source_urls),
        `${surfaceKey}: source_urls must be an array`,
      );
      for (const sourceUrl of surface.source_urls || []) {
        assert(
          isValidUrl(sourceUrl),
          `${surfaceKey}: source_urls must contain URLs`,
        );
      }
    }
    if (surface.verification !== undefined) {
      validateVerification(`${surfaceKey}:verification`, surface.verification);
    }
    if (surface.authority === "registry-observed") {
      assert(
        Array.isArray(surface.source_urls) && surface.source_urls.length > 0,
        `${surfaceKey}: source_urls required`,
      );
      const verificationEvidence =
        registryVerificationEvidence.byCandidateId.get(surface.id) ||
        registryVerificationEvidence.byLocator.get(
          registrySurfaceKey({
            ...surface,
            netuid: subnet.netuid,
          }),
        );
      assert(
        verificationEvidence !== undefined,
        `${surfaceKey}: registry-observed surface requires verification evidence`,
      );
      if (verificationEvidence !== undefined) {
        validatePromotionEvidence(
          `${surfaceKey}:verification evidence`,
          verificationEvidence,
        );
        assert(
          verificationEvidence.candidate_id === undefined ||
            verificationEvidence.candidate_id === surface.id,
          `${surfaceKey}: verification evidence must match surface id`,
        );
        assert(
          verificationEvidence.provider === undefined ||
            verificationEvidence.provider === surface.provider,
          `${surfaceKey}: verification evidence must match provider`,
        );
        assert(
          ["live", "redirected"].includes(verificationEvidence.classification),
          `${surfaceKey}: promoted registry-observed surface must be live or redirected`,
        );
      }
    }

    if (surface.probe !== undefined) {
      assert(
        typeof surface.probe.enabled === "boolean",
        `${surfaceKey}: probe.enabled must be boolean`,
      );
      assert(
        probeMethods.has(surface.probe.method),
        `${surfaceKey}: invalid probe.method`,
      );
      assert(
        probeExpectations.has(surface.probe.expect),
        `${surfaceKey}: invalid probe.expect`,
      );
      if (surface.probe.timeout_ms !== undefined) {
        assert(
          Number.isInteger(surface.probe.timeout_ms) &&
            surface.probe.timeout_ms >= 1000 &&
            surface.probe.timeout_ms <= 30000,
          `${surfaceKey}: probe.timeout_ms must be between 1000 and 30000`,
        );
      }
    }

    if (surface.kind === "openapi") {
      assert(
        surface.schema_status === "machine-readable",
        `${surfaceKey}: openapi surfaces must reference a machine-readable schema`,
      );
      if (surface.authority === "registry-observed") {
        assert(
          isValidUrl(surface.schema_url || surface.url),
          `${surfaceKey}: registry-observed openapi surface must provide a schema URL`,
        );
      }
    }
  }
}

function validateCuration(key, curation) {
  assert(
    curation && typeof curation === "object",
    `${key}: curation is required`,
  );
  assert(curationLevels.has(curation?.level), `${key}: invalid curation.level`);
  assert(
    reviewStates.has(curation?.review_state),
    `${key}: invalid curation.review_state`,
  );
  assert(
    curation.reviewed_at === null ||
      curation.reviewed_at === undefined ||
      typeof curation.reviewed_at === "string",
    `${key}: reviewed_at must be string or null`,
  );
  assert(
    curation.verified_at === null ||
      curation.verified_at === undefined ||
      typeof curation.verified_at === "string",
    `${key}: verified_at must be string or null`,
  );
  assert(
    curation.source_count === undefined ||
      (Number.isInteger(curation.source_count) && curation.source_count >= 0),
    `${key}: curation.source_count must be non-negative integer`,
  );
  assert(
    Array.isArray(curation.gap_notes || []),
    `${key}: curation.gap_notes must be an array`,
  );
}

function validateLinks(key, links) {
  assert(Array.isArray(links), `${key}: links must be an array`);
  for (const [index, link] of links.entries()) {
    assert(Boolean(link.label), `${key}: links[${index}].label is required`);
    assert(isValidUrl(link.url), `${key}: links[${index}].url must be a URL`);
    if (link.source_url !== undefined) {
      assert(
        isValidUrl(link.source_url),
        `${key}: links[${index}].source_url must be a URL`,
      );
    }
  }
}

function validatePublicSafeJson(value, pathSegments = []) {
  if (Array.isArray(value)) {
    for (const [index, nested] of value.entries()) {
      validatePublicSafeJson(nested, [...pathSegments, index]);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      validatePublicSafeJson(nested, [...pathSegments, key]);
    }
    return;
  }

  if (typeof value === "string" && isCredentialedUrl(value)) {
    assert(
      false,
      `${pathSegments.join(".") || "value"}: must not expose credentialed URL query parameters`,
    );
  }
}

function validateVerification(key, verification) {
  assert(
    verification && typeof verification === "object",
    `${key}: verification must be an object`,
  );
  assert(
    verificationClassifications.has(verification.classification),
    `${key}: invalid classification`,
  );
  assert(
    typeof verification.verified_at === "string",
    `${key}: verified_at is required`,
  );
  if (
    verification.redirect_target !== undefined &&
    verification.redirect_target !== null
  ) {
    assert(
      isValidUrl(verification.redirect_target),
      `${key}: redirect_target must be a URL or null`,
    );
  }
  if (verification.homepage !== undefined && verification.homepage !== null) {
    assert(
      isValidUrl(verification.homepage),
      `${key}: homepage must be a URL or null`,
    );
  }
}

function validatePromotionEvidence(key, verification) {
  assert(
    verification && typeof verification === "object",
    `${key}: verification evidence must be an object`,
  );
  assert(
    verificationClassifications.has(verification.classification),
    `${key}: invalid classification`,
  );
  if (
    verification.redirect_target !== undefined &&
    verification.redirect_target !== null
  ) {
    assert(
      isValidUrl(verification.redirect_target),
      `${key}: redirect_target must be a URL or null`,
    );
  }
}

function validateNativeSnapshot(snapshot) {
  assert(
    snapshot.schema_version === 1,
    "native snapshot: schema_version must be 1",
  );
  assert(
    snapshot.network === "finney",
    "native snapshot: network must be finney",
  );
  assert(
    Boolean(snapshot.captured_at),
    "native snapshot: captured_at is required",
  );
  assert(
    snapshot.source?.kind === "bittensor-sdk",
    "native snapshot: source.kind must be bittensor-sdk",
  );
  assert(
    Array.isArray(snapshot.subnets),
    "native snapshot: subnets must be an array",
  );
  assert(
    snapshot.subnets.length > 0,
    "native snapshot: subnets must not be empty",
  );

  let previousNetuid = -1;
  const netuids = new Set();
  for (const subnet of snapshot.subnets || []) {
    const key = `native:${subnet.netuid}`;
    assert(
      Number.isInteger(subnet.netuid) && subnet.netuid >= 0,
      `${key}: netuid must be a non-negative integer`,
    );
    assert(
      subnet.netuid > previousNetuid,
      `${key}: native subnets must be unique and sorted by netuid`,
    );
    previousNetuid = subnet.netuid;
    netuids.add(subnet.netuid);
    assert(Boolean(subnet.name), `${key}: name is required`);
    assert(
      nativeNameQualities.has(subnet.native_name_quality || "chain"),
      `${key}: invalid native_name_quality`,
    );
    if (subnet.raw_name !== undefined && subnet.raw_name !== null) {
      assert(
        typeof subnet.raw_name === "string",
        `${key}: raw_name must be a string or null`,
      );
    }
    assert(
      typeof subnet.symbol === "string",
      `${key}: symbol must be a string`,
    );
    assert(
      subnet.status === "active",
      `${key}: status must be active in v1 snapshot`,
    );
    assert(subnetTypes.has(subnet.subnet_type), `${key}: invalid subnet_type`);
    assert(
      Number.isInteger(subnet.block) && subnet.block >= 0,
      `${key}: block must be a non-negative integer`,
    );
    assert(
      Number.isInteger(subnet.participant_count) &&
        subnet.participant_count >= 0,
      `${key}: participant_count must be a non-negative integer`,
    );
    assert(
      Number.isInteger(subnet.tempo) && subnet.tempo >= 0,
      `${key}: tempo must be a non-negative integer`,
    );
    assert(
      Number.isInteger(subnet.registered_at_block) &&
        subnet.registered_at_block >= 0,
      `${key}: registered_at_block must be a non-negative integer`,
    );
    assert(
      Number.isInteger(subnet.mechanism_count) && subnet.mechanism_count >= 1,
      `${key}: mechanism_count must be a positive integer`,
    );
  }

  const root = snapshot.subnets.find((subnet) => subnet.netuid === 0);
  assert(
    root?.subnet_type === "root",
    "native snapshot: netuid 0 must be labeled root",
  );
  return netuids;
}

function validateCandidate(candidate, nativeNetuids, providerIds) {
  const key = `candidate:${candidate.id || "unknown"}`;
  assert(candidate.schema_version === 1, `${key}: schema_version must be 1`);
  assert(slugPattern.test(candidate.id || ""), `${key}: invalid id`);
  assert(
    Number.isInteger(candidate.netuid) && candidate.netuid >= 0,
    `${key}: netuid must be a non-negative integer`,
  );
  assert(
    nativeNetuids.has(candidate.netuid),
    `${key}: candidate netuid is not in native snapshot`,
  );
  assert(candidateStates.has(candidate.state), `${key}: invalid state`);
  assert(Boolean(candidate.name), `${key}: name is required`);
  assert(surfaceKinds.has(candidate.kind), `${key}: invalid kind`);
  assert(isValidUrl(candidate.url), `${key}: url must be a URL`);
  assert(isValidUrl(candidate.source_url), `${key}: source_url must be a URL`);
  if (candidate.source_urls !== undefined) {
    assert(
      Array.isArray(candidate.source_urls),
      `${key}: source_urls must be an array`,
    );
    for (const sourceUrl of candidate.source_urls || []) {
      assert(isValidUrl(sourceUrl), `${key}: source_urls must contain URLs`);
    }
  }
  if (candidate.source_tier !== undefined) {
    assert(
      [
        "native-chain",
        "provider-claimed",
        "third-party-index",
        "community-docs",
      ].includes(candidate.source_tier),
      `${key}: invalid source_tier`,
    );
  }
  if (candidate.confidence !== undefined) {
    assert(
      ["low", "medium", "high"].includes(candidate.confidence),
      `${key}: invalid confidence`,
    );
  }
  if (candidate.verification !== undefined && candidate.verification !== null) {
    validateVerification(`${key}:verification`, candidate.verification);
  }
  assert(
    providerIds.has(candidate.provider),
    `${key}: unknown provider ${candidate.provider}`,
  );
  assert(
    typeof candidate.auth_required === "boolean",
    `${key}: auth_required must be boolean`,
  );
  assert(
    typeof candidate.public_safe === "boolean",
    `${key}: public_safe must be boolean`,
  );
}

function validateReviewDecision(decision, nativeNetuids) {
  const key = `review:${decision.netuid ?? "unknown"}`;
  assert(
    Number.isInteger(decision.netuid) && decision.netuid >= 0,
    `${key}: netuid must be a non-negative integer`,
  );
  assert(
    nativeNetuids.has(decision.netuid),
    `${key}: netuid is not in native snapshot`,
  );
  assert(slugPattern.test(decision.slug || ""), `${key}: invalid slug`);
  assert(reviewDecisions.has(decision.decision), `${key}: invalid decision`);
  assert(
    typeof decision.reviewed_at === "string",
    `${key}: reviewed_at is required`,
  );
  assert(
    ["low", "medium", "high"].includes(decision.confidence),
    `${key}: invalid confidence`,
  );
  assert(
    Array.isArray(decision.source_urls),
    `${key}: source_urls must be an array`,
  );
  for (const sourceUrl of decision.source_urls || []) {
    assert(isValidUrl(sourceUrl), `${key}: source_urls must contain URLs`);
  }
  assert(
    typeof decision.notes === "string" && decision.notes.length > 0,
    `${key}: notes are required`,
  );
}

function buildGeneratedArtifactGaps(surfaces, overlay) {
  const kinds = new Set(surfaces.map((surface) => surface.kind));
  if (overlay?.docs_url) {
    kinds.add("docs");
  }
  if (overlay?.source_repo) {
    kinds.add("source-repo");
  }
  if (overlay?.website_url) {
    kinds.add("website");
  }
  if (overlay?.dashboard_url) {
    kinds.add("dashboard");
  }
  const expectedKinds = [
    "docs",
    "source-repo",
    "website",
    "dashboard",
    "openapi",
    "subnet-api",
    "sse",
    "data-artifact",
  ];
  return {
    missing_kinds: expectedKinds.filter((kind) => !kinds.has(kind)),
    supported_kinds: [...kinds].sort(),
    gap_notes: overlay?.curation?.gap_notes || [],
  };
}

function buildExpectedGeneratedSubnet(nativeSnapshot, overlay, candidateCount) {
  const surfaceCount = overlay?.surfaces?.length || 0;
  const probedSurfaceCount =
    overlay?.surfaces?.filter((surface) => surface.probe?.enabled).length || 0;
  const coverageLevel =
    surfaceCount === 0
      ? "native-only"
      : probedSurfaceCount > 0
        ? "probed"
        : "manifested";
  const nativeSubnet = nativeSnapshot.subnet;
  const slug = overlay?.slug || `sn-${nativeSubnet.netuid}`;
  const nameQuality = nativeNameQuality(nativeSubnet);
  const nativeName =
    typeof nativeSubnet.raw_name === "string"
      ? nativeSubnet.raw_name
      : nativeSubnet.name || null;
  const displayName =
    overlay?.name ||
    nativeDisplayName(nativeSubnet, `Subnet ${nativeSubnet.netuid}`);
  const nativeSlug =
    nameQuality === "chain" && nativeName
      ? slugify(nativeName)
      : nativeSubnet.netuid === 0
        ? "root"
        : `sn-${nativeSubnet.netuid}`;

  const categories =
    overlay?.categories ||
    (nativeSubnet.netuid === 0 ? ["root", "system"] : ["native-only"]);
  return {
    block: nativeSubnet.block,
    candidate_count: candidateCount,
    categories,
    // Mirror mergeSubnet's derived domain tags (issue #345) so the per-subnet
    // detail artifact stays reproducible from registry inputs.
    derived_categories: deriveDomainTags({
      description: nativeSubnet.chain_identity?.description,
      additional: nativeSubnet.chain_identity?.additional,
      categories,
    }),
    coverage_level: coverageLevel,
    curation_level:
      overlay?.curation?.level || (overlay ? "candidate-discovered" : "native"),
    dashboard_url: overlay?.dashboard_url || null,
    description:
      cleanDescription(nativeSubnet.chain_identity?.description) ||
      cleanDescription(overlay?.description) ||
      null,
    docs_url: overlay?.docs_url || null,
    gaps: buildGeneratedArtifactGaps(overlay?.surfaces || [], overlay),
    mechanism_count: nativeSubnet.mechanism_count,
    name: displayName,
    native_name: nativeName,
    native_name_quality: nameQuality,
    native_slug: nativeSlug,
    netuid: nativeSubnet.netuid,
    notes: overlay?.notes || null,
    participant_count: nativeSubnet.participant_count,
    probed_surface_count: probedSurfaceCount,
    provenance: {
      existence: {
        authority: "native-chain",
        captured_at: nativeSnapshot.captured_at,
        method: nativeSnapshot.source.method,
        network: nativeSnapshot.network,
        source_kind: nativeSnapshot.source.kind,
      },
      identity: {
        display_name_source: overlay?.name
          ? "curated-overlay"
          : nameQuality === "chain"
            ? "native-chain"
            : "fallback",
        native_name_quality: nameQuality,
      },
      interface_metadata: overlay
        ? overlay.curation?.level || "curated-overlay"
        : "none",
    },
    lifecycle: subnetLifecycle(nativeSubnet),
    logo_url: backfilledIdentityUrl(
      overlay?.logo_url,
      nativeSubnet.chain_identity?.logo_url,
    ),
    registered_at_block: nativeSubnet.registered_at_block,
    slug,
    // Mirror mergeSubnet's display backfill (overlay wins, else chain
    // github_repo, junk-guarded) so the reproducibility check matches.
    source_repo: backfilledIdentityUrl(
      overlay?.source_repo,
      nativeSubnet.chain_identity?.github_repo,
    ),
    status: nativeSubnet.status,
    subnet_type: nativeSubnet.subnet_type,
    surface_count: surfaceCount,
    symbol: nativeSubnet.symbol,
    tempo: nativeSubnet.tempo,
    website_url: backfilledIdentityUrl(
      overlay?.website_url,
      nativeSubnet.chain_identity?.subnet_url,
    ),
    curation: overlay?.curation || {
      level: overlay ? "candidate-discovered" : "native",
      review_state: "unreviewed",
      reviewed_at: null,
      verified_at: null,
      source_count: 0,
      gap_notes: [],
    },
    links: overlay?.links || [],
  };
}

async function readArtifactJson(relativePath) {
  return readJson(artifactPathForRelative(relativePath));
}

function artifactPath(relativePath) {
  return artifactPathForRelative(relativePath);
}

function artifactPathForRelative(relativePath) {
  const tier = artifactStorageTierForRelativePath(relativePath);
  const r2Path = path.join(repoRoot, R2_STAGING_RELATIVE_ROOT, relativePath);
  if (tier === "r2" && existsSync(r2Path)) {
    return r2Path;
  }
  return path.join(repoRoot, "public/metagraph", relativePath);
}

async function validateR2OnlyArtifactsStayOutOfPublicGit() {
  const files = await listJsonFilesRecursive(publicMetagraphRoot);
  for (const filePath of files) {
    const relativePath = path
      .relative(publicMetagraphRoot, filePath)
      .replace(/\\/g, "/");
    assert(
      artifactStorageTierForRelativePath(relativePath) !== "r2",
      `${relativePath}: R2-only artifact must be staged under ${R2_STAGING_RELATIVE_ROOT}, not public/metagraph`,
    );
  }
}

async function validateGeneratedArtifacts(
  nativeSnapshot,
  overlays,
  candidates,
) {
  await validateR2OnlyArtifactsStayOutOfPublicGit();

  const providersArtifact = await readArtifactJson("providers.json");
  const subnetsArtifact = await readArtifactJson("subnets.json");
  const profilesArtifact = await readArtifactJson("profiles.json");
  const surfacesArtifact = await readArtifactJson("surfaces.json");
  const candidatesArtifact = await readArtifactJson("candidates.json");
  const curationArtifact = await readArtifactJson("curation.json");
  const gapsArtifact = await readArtifactJson("gaps.json");
  const reviewQueueArtifact = await readArtifactJson("review-queue.json");
  const verificationArtifact = await readArtifactJson(
    "verification/latest.json",
  );
  const coverageArtifact = await readArtifactJson("coverage.json");
  const contractsArtifact = await readArtifactJson("contracts.json");
  const apiIndexArtifact = await readArtifactJson("api-index.json");
  const changelogArtifact = await readArtifactJson("changelog.json");
  const searchArtifact = await readArtifactJson("search.json");
  const freshnessArtifact = await readArtifactJson("freshness.json");
  const sourceHealthArtifact = await readArtifactJson("source-health.json");
  const sourceSnapshotsArtifact = await readArtifactJson(
    "source-snapshots.json",
  );
  const evidenceLedgerArtifact = await readArtifactJson("evidence-ledger.json");
  const healthArtifact = await readArtifactJson("health/latest.json");
  const healthSummaryArtifact = await readArtifactJson("health/summary.json");
  const rpcEndpointsArtifact = await readArtifactJson("rpc-endpoints.json");
  const endpointsArtifact = await readArtifactJson("endpoints.json");
  const endpointPoolsArtifact = await readArtifactJson("rpc/pools.json");
  const r2ManifestArtifact = await readArtifactJson("r2-manifest.json");
  const schemaDriftArtifact = await readArtifactJson("schema-drift.json");
  const schemaIndexArtifact = await readArtifactJson("schemas/index.json");
  const reviewCurationArtifact = await readArtifactJson("review/curation.json");
  const reviewGapPrioritiesArtifact = await readArtifactJson(
    "review/gap-priorities.json",
  );
  const reviewAdapterCandidatesArtifact = await readArtifactJson(
    "review/adapter-candidates.json",
  );
  const reviewDecisionsArtifact = await readArtifactJson(
    "review/maintainer-decisions.json",
  );

  for (const [artifactName, artifact] of [
    ["public candidates", candidatesArtifact],
    ["public review queue", reviewQueueArtifact],
    ["public verification", verificationArtifact],
  ]) {
    validatePublicSafeJson(artifact, [artifactName]);
  }

  const nativeNetuids = nativeSnapshot.subnets.map((subnet) => subnet.netuid);
  const generatedNetuids = subnetsArtifact.subnets.map(
    (subnet) => subnet.netuid,
  );
  assert(
    JSON.stringify(generatedNetuids) === JSON.stringify(nativeNetuids),
    "generated subnets.json must have count/key parity with native snapshot",
  );

  const overlayByNetuid = new Map(
    overlays.map((overlay) => [overlay.netuid, overlay]),
  );
  const candidatesByNetuid = Map.groupBy(
    candidates,
    (candidate) => candidate.netuid,
  );
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  const activeNetuids = new Set(nativeNetuids);
  const activeOverlays = overlays.filter((overlay) =>
    activeNetuids.has(overlay.netuid),
  );
  const surfaces = flattenSurfaces(activeOverlays);
  const endpointsByNetuid = Map.groupBy(
    endpointsArtifact.endpoints || [],
    (endpoint) => endpoint.netuid,
  );
  const expectedSubnetsByNetuid = new Map(
    nativeSnapshot.subnets.map((nativeSubnet) => [
      nativeSubnet.netuid,
      buildExpectedGeneratedSubnet(
        {
          captured_at: nativeSnapshot.captured_at,
          network: nativeSnapshot.network,
          source: nativeSnapshot.source,
          subnet: nativeSubnet,
        },
        overlayByNetuid.get(nativeSubnet.netuid),
        candidatesByNetuid.get(nativeSubnet.netuid)?.length || 0,
      ),
    ]),
  );

  for (const subnet of subnetsArtifact.subnets) {
    assert(
      coverageLevels.has(subnet.coverage_level),
      `generated:${subnet.netuid}: invalid coverage_level`,
    );
    assert(
      subnet.coverage_level !== "native-only",
      `generated:${subnet.netuid}: active subnet must be curated`,
    );
    const detailPath = artifactPath(`subnets/${subnet.netuid}.json`);
    try {
      const detailArtifact = await readJson(detailPath);
      const subnetCandidates = candidatesByNetuid.get(subnet.netuid) || [];
      const subnetSurfaces = surfaces.filter(
        (surface) => surface.netuid === subnet.netuid,
      );
      const subnetEndpoints = endpointsByNetuid.get(subnet.netuid) || [];
      const expectedDetailArtifact = {
        schema_version: 1,
        generated_at: subnetsArtifact.generated_at,
        subnet: expectedSubnetsByNetuid.get(subnet.netuid),
        candidate_surfaces: subnetCandidates,
        candidates: subnetCandidates,
        endpoints: subnetEndpoints,
        gaps: expectedSubnetsByNetuid.get(subnet.netuid)?.gaps,
        surfaces: subnetSurfaces,
        verified_surfaces: subnetSurfaces,
      };
      assert(
        stableStringify(detailArtifact) ===
          stableStringify(expectedDetailArtifact),
        `generated:${subnet.netuid}: per-subnet detail artifact is not reproducible from registry inputs`,
      );
    } catch (error) {
      if (error.code === "ENOENT") {
        assert(
          false,
          `generated:${subnet.netuid}: missing per-subnet detail artifact`,
        );
        continue;
      }
      throw error;
    }
  }

  // --- Flywheel-preservation invariant (#343) -------------------------------
  // completeness_score / missing_* must derive ONLY from curated signals — the
  // curated `primary_links` and verified surface kinds — never from chain-derived
  // / backfilled passthrough fields. Otherwise auto-enrichment would silently
  // satisfy gaps and drain the SN74 curation queue (gaps are the product). This
  // gates Wave 4 enrichment: (a) re-derive `missing_required` from the profile's
  // curated inputs and assert it matches, so no hidden field can feed it; and
  // (b) assert chain-backfilled index links (display-only) never satisfy
  // completeness. See ADR 0003 / docs/integration-readiness.md.
  const indexByNetuid = new Map(
    subnetsArtifact.subnets.map((subnet) => [subnet.netuid, subnet]),
  );
  const REQUIRED_IDENTITY = [
    ["source-repo", "source_repo"],
    ["website", "website_url"],
  ];
  for (const profile of profilesArtifact.profiles) {
    const links = profile.primary_links || {};
    const supported = new Set(profile.supported_interface_kinds || []);
    const expectedMissingRequired = REQUIRED_IDENTITY.filter(
      ([kind, linkField]) => !(links[linkField] || supported.has(kind)),
    ).map(([kind]) => kind);
    assert(
      stableStringify([...(profile.missing_required || [])].sort()) ===
        stableStringify(expectedMissingRequired.sort()),
      `flywheel:${profile.netuid}: missing_required is not reproducible from curated inputs — a derived/passthrough field may be feeding completeness`,
    );
    const indexEntry = indexByNetuid.get(profile.netuid);
    for (const [kind, linkField] of REQUIRED_IDENTITY) {
      if (indexEntry?.[linkField] && !links[linkField]) {
        assert(
          (profile.missing_required || []).includes(kind),
          `flywheel:${profile.netuid}: chain-backfilled ${linkField} must not satisfy completeness (it must stay in missing_required)`,
        );
      }
    }
  }

  const curatedNetuids = new Set(overlays.map((overlay) => overlay.netuid));
  const surfaceNetuids = new Set(
    surfacesArtifact.surfaces.map((surface) => surface.netuid),
  );
  for (const netuid of surfaceNetuids) {
    assert(
      curatedNetuids.has(netuid),
      `generated surfaces: surface exists for non-curated netuid ${netuid}`,
    );
  }

  assert(
    coverageArtifact.chain_subnet_count === nativeSnapshot.subnets.length,
    "coverage: chain_subnet_count mismatch",
  );
  assert(
    coverageArtifact.curated_overlay_count === nativeSnapshot.subnets.length,
    "coverage: curated_overlay_count mismatch",
  );
  assert(
    coverageArtifact.native_only_count === 0,
    "coverage: native_only_count must be 0",
  );
  assert(
    coverageArtifact.surface_count === surfacesArtifact.surfaces.length,
    "coverage: surface_count mismatch",
  );
  assert(
    coverageArtifact.candidate_count === candidates.length,
    "coverage: candidate_count mismatch",
  );
  assert(
    candidatesArtifact.candidates.length === candidates.length,
    "candidates artifact: count mismatch",
  );
  assert(
    curationArtifact.curation.length === nativeSnapshot.subnets.length,
    "curation artifact: count mismatch",
  );
  assert(
    gapsArtifact.gaps.length === nativeSnapshot.subnets.length,
    "gaps artifact: count mismatch",
  );
  assert(
    verificationArtifact.candidate_count ===
      verificationArtifact.results.length,
    "verification artifact: candidate_count must match full result count",
  );
  assert(
    verificationArtifact.results.length <= candidates.length,
    "verification artifact: full result count cannot exceed candidates",
  );
  for (const result of verificationArtifact.results) {
    assert(
      candidateIds.has(result.candidate_id),
      `verification artifact: unknown candidate ${result.candidate_id}`,
    );
  }
  assert(
    reviewQueueArtifact.count === reviewQueueArtifact.candidates.length,
    "review queue artifact: count must match candidates length",
  );
  assert(
    contractsArtifact.contract_version,
    "contracts artifact: contract_version is required",
  );
  const typeDefinitionsStat = await fs
    .stat(path.join(repoRoot, "public/metagraph/types.d.ts"))
    .catch((error) => {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
  assert(
    typeDefinitionsStat?.isFile(),
    "type definitions artifact: public/metagraph/types.d.ts is required",
  );
  assert(
    contractsArtifact.primary_domain === "api.metagraph.sh",
    "contracts artifact: primary_domain must be api.metagraph.sh",
  );
  assert(
    contractsArtifact.status_domain === null,
    "contracts artifact: status_domain must remain null for v1",
  );
  assert(
    Array.isArray(contractsArtifact.artifacts),
    "contracts artifact: artifacts must be an array",
  );
  assert(
    contractsArtifact.artifacts.every((artifact) =>
      String(artifact.path || "").startsWith("/metagraph/"),
    ),
    "contracts artifact: all artifact paths must stay under /metagraph",
  );
  assert(
    new Set(contractsArtifact.artifacts.map((artifact) => artifact.id)).size ===
      contractsArtifact.artifacts.length,
    "contracts artifact: artifact ids must be unique",
  );
  for (const expectedArtifact of [
    "changelog",
    "source-snapshots",
    "rpc-pools",
    "r2-manifest",
    "type-definitions",
  ]) {
    assert(
      contractsArtifact.artifacts.some(
        (artifact) => artifact.id === expectedArtifact,
      ),
      `contracts artifact: missing ${expectedArtifact}`,
    );
  }
  assert(
    apiIndexArtifact.primary_domain === "api.metagraph.sh",
    "api index: primary_domain must be api.metagraph.sh",
  );
  assert(
    Array.isArray(apiIndexArtifact.routes),
    "api index: routes must be an array",
  );
  assert(
    apiIndexArtifact.routes.every(
      (route) =>
        route.path === "/api/v1" ||
        String(route.path || "").startsWith("/api/v1/"),
    ),
    "api index: routes must stay under /api/v1",
  );
  for (const expectedRoute of [
    "/api/v1/changelog",
    "/api/v1/source-snapshots",
    "/api/v1/contracts",
    "/api/v1/openapi.json",
    "/api/v1/build",
  ]) {
    assert(
      apiIndexArtifact.routes.some((route) => route.path === expectedRoute),
      `api index: missing ${expectedRoute}`,
    );
  }
  assert(changelogArtifact.summary, "changelog: summary is required");
  assert(changelogArtifact.subnets, "changelog: subnet diff is required");
  assert(
    searchArtifact.document_count === searchArtifact.documents.length,
    "search: document_count mismatch",
  );
  assert(
    freshnessArtifact.summary?.native_snapshot_captured_at ===
      nativeSnapshot.captured_at,
    "freshness: native snapshot timestamp mismatch",
  );
  assert(
    freshnessArtifact.summary?.native_data_as_of === nativeSnapshot.captured_at,
    "freshness: native_data_as_of mismatch",
  );
  const candidateVerificationFreshness = freshnessArtifact.sources.find(
    (source) => source.id === "candidate-verification",
  );
  assert(
    freshnessArtifact.summary?.verification_as_of ===
      candidateVerificationFreshness?.as_of,
    "freshness: verification_as_of mismatch",
  );
  assert(
    freshnessArtifact.summary?.blocking_source_count ===
      freshnessArtifact.sources.filter(
        (source) => source.stale_behavior === "block",
      ).length,
    "freshness: blocking source count mismatch",
  );
  assert(
    freshnessArtifact.summary?.missing_blocking_source_count ===
      freshnessArtifact.sources.filter(
        (source) =>
          source.stale_behavior === "block" && source.status === "missing",
      ).length,
    "freshness: missing blocking source count mismatch",
  );
  for (const source of freshnessArtifact.sources) {
    assert(
      source.as_of === source.timestamp,
      `freshness:${source.id}: as_of and timestamp must match`,
    );
    assert(
      ["block", "warn"].includes(source.stale_behavior),
      `freshness:${source.id}: stale_behavior is invalid`,
    );
    assert(
      source.stale_behavior === "block" ||
        source.required_for_publish === false,
      `freshness:${source.id}: warning sources cannot be required for publish`,
    );
  }
  if (requiresFreshness()) {
    validateFreshnessForPublish(freshnessArtifact);
  }
  assert(
    sourceHealthArtifact.summary?.provider_count ===
      providersArtifact.providers.length,
    "source health: provider count mismatch",
  );
  assert(
    sourceSnapshotsArtifact.summary?.source_count ===
      sourceSnapshotsArtifact.sources.length,
    "source snapshots: source_count mismatch",
  );
  assert(
    sourceSnapshotsArtifact.sources.some(
      (source) =>
        source.id === "native-subnets" &&
        source.record_count === nativeSnapshot.subnets.length,
    ),
    "source snapshots: missing native subnet source",
  );
  assert(
    evidenceLedgerArtifact.summary?.claim_count ===
      evidenceLedgerArtifact.claims.length,
    "evidence ledger: claim count mismatch",
  );
  assert(
    healthArtifact.surfaces.length ===
      surfacesArtifact.surfaces.filter(
        (surface) => surface.probe?.enabled && surface.public_safe,
      ).length,
    "health artifact: probed surface count mismatch",
  );
  assert(
    healthSummaryArtifact.subnets.length === nativeSnapshot.subnets.length,
    "health summary: subnet count mismatch",
  );
  if (requiresProbeHealth()) {
    assert(
      healthArtifact.source === "live-smoke-probe",
      "health artifact: publish requires probe-derived health",
    );
    assert(
      healthSummaryArtifact.source === "live-smoke-probe",
      "health summary: publish requires probe-derived health",
    );
    assert(
      healthSummaryArtifact.global?.status_counts?.unknown !==
        healthSummaryArtifact.global?.surface_count,
      "health summary: publish cannot promote all-unknown health",
    );
  }
  assert(
    rpcEndpointsArtifact.endpoints.length ===
      surfacesArtifact.surfaces.filter((surface) =>
        ["subtensor-rpc", "subtensor-wss"].includes(surface.kind),
      ).length,
    "rpc endpoints artifact: endpoint count mismatch",
  );
  assert(
    rpcEndpointsArtifact.endpoints.every((endpoint) => endpoint.netuid === 0),
    "rpc endpoints artifact: base-layer RPC endpoints must be rooted at netuid 0",
  );
  assert(
    Array.isArray(endpointPoolsArtifact.pools),
    "endpoint pools: pools must be an array",
  );
  assert(
    endpointPoolsArtifact.disabled_proxy_contract?.enabled === false,
    "endpoint pools: read-only proxy contract must remain disabled by default",
  );
  assert(
    r2ManifestArtifact.artifact_count === r2ManifestArtifact.artifacts.length,
    "R2 manifest: compact artifact count mismatch",
  );
  assert(
    (r2ManifestArtifact.full_artifact_count ||
      r2ManifestArtifact.artifact_count) >= r2ManifestArtifact.artifact_count,
    "R2 manifest: full artifact count must include compact artifacts",
  );
  assert(
    r2ManifestArtifact.bucket_binding === "METAGRAPH_ARCHIVE",
    "R2 manifest: unexpected bucket binding",
  );
  assert(
    r2ManifestArtifact.artifacts.some(
      (artifact) => artifact.path === "/metagraph/changelog.json",
    ),
    "R2 manifest: changelog must be uploaded",
  );
  assert(
    r2ManifestArtifact.required_artifact_paths?.includes(
      "/metagraph/source-snapshots.json",
    ) ||
      r2ManifestArtifact.artifacts.some(
        (artifact) => artifact.path === "/metagraph/source-snapshots.json",
      ),
    "R2 manifest: source snapshots must be uploaded",
  );
  assert(
    r2ManifestArtifact.required_artifact_paths?.includes(
      "/metagraph/types.d.ts",
    ) ||
      r2ManifestArtifact.artifacts.some(
        (artifact) =>
          artifact.path === "/metagraph/types.d.ts" &&
          artifact.content_type === "text/plain; charset=utf-8",
      ),
    "R2 manifest: generated type definitions must be uploaded",
  );
  assert(
    (schemaDriftArtifact.openapi_surface_count ??
      schemaDriftArtifact.summary?.surface_count) ===
      surfacesArtifact.surfaces.filter((surface) => surface.kind === "openapi")
        .length,
    "schema drift: OpenAPI surface count mismatch",
  );
  assert(
    Array.isArray(schemaIndexArtifact.schemas),
    "schema index: schemas must be an array",
  );
  assert(
    reviewCurationArtifact.summary?.subnet_count ===
      nativeSnapshot.subnets.length,
    "review curation: subnet count mismatch",
  );
  assert(
    reviewGapPrioritiesArtifact.priorities.length ===
      nativeSnapshot.subnets.length,
    "review gap priorities: subnet count mismatch",
  );
  assert(
    Array.isArray(reviewAdapterCandidatesArtifact.candidates),
    "review adapter candidates: candidates must be an array",
  );
  assert(
    Array.isArray(reviewDecisionsArtifact.decisions),
    "review decisions: decisions must be an array",
  );

  for (const netuid of nativeNetuids) {
    for (const artifactPath of [
      `health/subnets/${netuid}.json`,
      `health/badges/${netuid}.json`,
    ]) {
      try {
        await fs.access(artifactPathForRelative(artifactPath));
      } catch {
        assert(false, `${artifactPath}: missing health artifact`);
      }
    }
  }

  for (const schemaPath of [
    "schemas/provider.schema.json",
    "schemas/subnet-manifest.schema.json",
    "schemas/candidate-surface.schema.json",
    "schemas/public-artifacts.schema.json",
  ]) {
    try {
      await fs.access(path.join(repoRoot, schemaPath));
    } catch {
      assert(false, `${schemaPath}: missing JSON schema contract`);
    }
  }
}

function requiresProbeHealth() {
  if (process.env.METAGRAPH_REQUIRE_PROBE_HEALTH === "1") {
    return true;
  }
  return (
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_WORKFLOW === "Publish Cloudflare Backend" &&
    process.env.GITHUB_REF === "refs/heads/main"
  );
}

function requiresFreshness() {
  if (process.env.METAGRAPH_REQUIRE_FRESHNESS === "1") {
    return true;
  }
  return (
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_WORKFLOW === "Publish Cloudflare Backend" &&
    process.env.GITHUB_REF === "refs/heads/main"
  );
}

function validateFreshnessForPublish(freshnessArtifact) {
  const now = Date.now();
  const failures = [];
  for (const source of freshnessArtifact.sources.filter(
    (entry) => entry.stale_behavior === "block",
  )) {
    if (source.status === "missing" || !source.as_of) {
      failures.push(`${source.id} is missing`);
      continue;
    }
    if (!["captured", "current"].includes(source.status)) {
      failures.push(`${source.id} status is ${source.status}`);
      continue;
    }
    const observedAt = Date.parse(source.as_of);
    if (!Number.isFinite(observedAt)) {
      failures.push(`${source.id} has invalid as_of timestamp`);
      continue;
    }
    const ageHours = (now - observedAt) / 3_600_000;
    if (ageHours > source.stale_after_hours) {
      failures.push(
        `${source.id} is stale (${ageHours.toFixed(1)}h > ${source.stale_after_hours}h)`,
      );
    }
  }

  assert(
    failures.length === 0,
    `freshness: publish requires fresh blocking sources: ${failures.join("; ")}`,
  );
}

const providers = await loadProviders();
const subnets = await loadSubnets();
const nativeSnapshot = await loadNativeSnapshot();
const candidates = await loadCandidates();
const reviewDecisionsDocument = await readJson(
  path.join(repoRoot, "registry/reviews/maintainer-reviewed.json"),
);
const verificationDocument = await loadVerification({ preferDetailed: false });
validatePublicSafeJson(verificationDocument, ["registry verification"]);
const providerIds = new Set();
const netuids = new Set();
const slugs = new Set();
const surfaceIds = new Set();
const surfaceLocators = new Set();
const nativeNetuids = validateNativeSnapshot(nativeSnapshot);
const registryVerificationEvidence = {
  byCandidateId: new Map(
    (verificationDocument.results || [])
      .filter((result) => result.candidate_id)
      .map((result) => [result.candidate_id, result]),
  ),
  byLocator: new Map(
    (verificationDocument.results || [])
      .filter((result) => result.url)
      .map((result) => [registrySurfaceKey(result), result]),
  ),
};
const candidateIds = new Set();
const candidateLocators = new Set();

for (const provider of providers) {
  validateProvider(provider);
  assert(
    !providerIds.has(provider.id),
    `${provider.id}: duplicate provider id`,
  );
  providerIds.add(provider.id);
}

for (const subnet of subnets) {
  assert(
    !netuids.has(subnet.netuid),
    `${subnet.slug}: duplicate netuid ${subnet.netuid}`,
  );
  assert(!slugs.has(subnet.slug), `${subnet.slug}: duplicate subnet slug`);
  assert(
    nativeNetuids.has(subnet.netuid) ||
      subnet.extensions?.pending_native === true,
    `${subnet.slug}: curated overlay netuid ${subnet.netuid} is not present in native snapshot`,
  );
  netuids.add(subnet.netuid);
  slugs.add(subnet.slug);
  validateSubnet(
    subnet,
    providerIds,
    surfaceIds,
    surfaceLocators,
    registryVerificationEvidence,
  );
}

for (const nativeNetuid of nativeNetuids) {
  assert(
    netuids.has(nativeNetuid),
    `native:${nativeNetuid}: missing curated overlay`,
  );
}

const rootOverlay = subnets.find((subnet) => subnet.netuid === 0);
assert(
  rootOverlay?.categories?.includes("root"),
  "root overlay must be labeled root/system",
);

for (const candidate of candidates) {
  assert(
    !candidateIds.has(candidate.id),
    `${candidate.id}: duplicate candidate id`,
  );
  candidateIds.add(candidate.id);
  const locator = registrySurfaceKey(candidate);
  assert(
    !candidateLocators.has(locator),
    `${candidate.id}: duplicate candidate locator ${locator}`,
  );
  candidateLocators.add(locator);
  validateCandidate(candidate, nativeNetuids, providerIds);
}

assert(
  reviewDecisionsDocument.schema_version === 1,
  "review decisions: schema_version must be 1",
);
assert(
  Array.isArray(reviewDecisionsDocument.decisions),
  "review decisions: decisions must be an array",
);
for (const decision of reviewDecisionsDocument.decisions || []) {
  validateReviewDecision(decision, nativeNetuids);
}

await validateGeneratedArtifacts(nativeSnapshot, subnets, candidates);

if (errors.length > 0) {
  console.error(`Validation failed with ${errors.length} issue(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Validated ${nativeSnapshot.subnets.length} native subnet(s), ${subnets.length} curated overlay(s), ${surfaceIds.size} surface(s), ${providers.length} provider(s), and ${candidates.length} candidate(s).`,
);

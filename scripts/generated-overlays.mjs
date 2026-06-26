import { promises as fs } from "node:fs";
import path from "node:path";
import {
  generatedSourceRoot,
  hashJson,
  isUnsafeUrl,
  listJsonFiles,
  loadCandidates,
  evidenceSourceUrls,
  loadNativeSnapshot,
  loadProviders,
  loadVerification,
  nativeDisplayName,
  nativeNameQuality,
  normalizePublicUrl,
  readJson,
  registrySurfaceKey,
  repoRoot,
  stableStringify,
  writeJson,
} from "./lib.mjs";
import {
  ownerTokensMatch,
  providerIdentityTokens,
  urlOwnerTokens,
} from "./registry-identity.mjs";

export const generatedOverlayDirectory = path.join(
  repoRoot,
  "registry/subnets/generated",
);
export const generatedOverlaySummaryPath = path.join(
  repoRoot,
  "registry/generated/subnet-overlays-summary.json",
);
export const generatedOverlaySourcePath = path.join(
  generatedSourceRoot,
  "subnets/generated-overlays.json",
);

function overlayFieldOrFallback(overlay, field, fallback) {
  return Object.hasOwn(overlay, field) ? overlay[field] : fallback;
}

export async function loadManualSubnetOverlays() {
  const files = await listJsonFiles(path.join(repoRoot, "registry/subnets"));
  const overlays = await Promise.all(files.map(readJson));
  return sortOverlays(overlays);
}

export async function loadExistingGeneratedSubnetOverlays() {
  const files = await listJsonFiles(generatedOverlayDirectory);
  const overlays = await Promise.all(files.map(readJson));
  return sortOverlays(overlays);
}

export async function generateBaselineOverlaySet(options = {}) {
  const nativeSnapshot = options.nativeSnapshot || (await loadNativeSnapshot());
  const candidates = options.candidates || (await loadCandidates());
  const verification =
    options.verification || (await loadVerification({ preferDetailed: false }));
  const providers = options.providers || (await loadProviders());
  const manualOverlays =
    options.manualOverlays || (await loadManualSubnetOverlays());
  const existingGeneratedOverlays =
    options.existingGeneratedOverlays ||
    (await loadExistingGeneratedSubnetOverlays());
  // Maintainer-reviewed decisions elevate generated-only overlays too (not just
  // manual ones), but the elevation must be tied to reviewed evidence. A subnet
  // should not inherit the maintainer-reviewed tier merely because any unrelated
  // surface was promoted for the same netuid.
  const maintainerReviewedDecisions =
    options.maintainerReviewedDecisions ||
    (
      await readJson(
        path.join(repoRoot, "registry/reviews/maintainer-reviewed.json"),
      ).catch(() => ({ decisions: [] }))
    ).decisions ||
    [];
  const maintainerReviewedDecisionsByNetuid = groupByNetuid(
    maintainerReviewedDecisions.filter(
      (decision) => decision.decision === "maintainer-reviewed",
    ),
  );

  const manualNetuids = new Set(
    manualOverlays.map((overlay) => overlay.netuid),
  );
  const existingGeneratedByNetuid = new Map(
    existingGeneratedOverlays.map((overlay) => [overlay.netuid, overlay]),
  );
  const verificationByCandidate = new Map(
    (verification.results || []).map((result) => [result.candidate_id, result]),
  );
  const providersById = new Map(
    providers.map((provider) => [provider.id, provider]),
  );
  const candidatesByNetuid = groupByNetuid(candidates);
  const generatedOverlays = [];
  const manualBaselineOverlays = [];

  for (const nativeSubnet of nativeSnapshot.subnets || []) {
    const baselineOverlay = buildGeneratedOverlay({
      candidatesByNetuid,
      existingGeneratedByNetuid,
      nativeSubnet,
      providersById,
      verificationByCandidate,
      maintainerReviewedDecisionsByNetuid,
    });
    if (manualNetuids.has(nativeSubnet.netuid)) {
      manualBaselineOverlays.push(baselineOverlay);
      continue;
    }
    generatedOverlays.push(baselineOverlay);
  }
  const augmentedManualOverlays = augmentManualOverlaysWithBaseline(
    manualOverlays,
    manualBaselineOverlays,
  );

  const summary = buildGeneratedOverlaySummary({
    generatedOverlays,
    manualOverlays: augmentedManualOverlays,
    nativeSnapshot,
    verification,
  });

  return {
    candidates,
    generatedOverlays,
    manualBaselineOverlays,
    manualOverlays: augmentedManualOverlays,
    nativeSnapshot,
    summary,
    providers,
    verification,
  };
}

export function augmentManualOverlaysWithBaseline(
  manualOverlays,
  baselineOverlays,
) {
  const baselineByNetuid = new Map(
    baselineOverlays.map((overlay) => [overlay.netuid, overlay]),
  );

  return sortOverlays(
    manualOverlays.map((manualOverlay) => {
      const baselineOverlay = baselineByNetuid.get(manualOverlay.netuid);
      const baselineSurfaces = baselineOverlay?.surfaces || [];
      if (baselineSurfaces.length === 0) {
        return manualOverlay;
      }

      const manualSurfaces = manualOverlay.surfaces || [];
      const excludedSurfaceIds = new Set(
        manualOverlay.baseline_excluded_surface_ids || [],
      );
      const excludedSurfaceUrls = new Set(
        (manualOverlay.baseline_excluded_surface_urls || [])
          .map((url) => normalizePublicUrl(url))
          .filter(Boolean),
      );
      const existingKeys = new Set(manualSurfaces.map(registrySurfaceKey));
      const additions = baselineSurfaces.filter((surface) => {
        if (excludedSurfaceIds.has(surface.id)) {
          return false;
        }
        const normalizedUrl = normalizePublicUrl(surface.url);
        if (normalizedUrl && excludedSurfaceUrls.has(normalizedUrl)) {
          return false;
        }
        const key = registrySurfaceKey(surface);
        if (existingKeys.has(key)) {
          return false;
        }
        existingKeys.add(key);
        return true;
      });

      if (additions.length === 0) {
        return manualOverlay;
      }

      const surfaces = [...manualSurfaces, ...additions].sort(
        (a, b) =>
          surfaceRank(a.kind) - surfaceRank(b.kind) || a.id.localeCompare(b.id),
      );
      const sourceUrls = new Set(
        surfaces.flatMap((surface) => evidenceSourceUrls(surface)),
      );
      const categories = new Set(manualOverlay.categories || []);
      categories.add("baseline-augmented");

      return {
        ...manualOverlay,
        categories: [...categories].sort(),
        dashboard_url:
          manualOverlay.dashboard_url || firstUrl(manualSurfaces, "dashboard"),
        docs_url: manualOverlay.docs_url || firstUrl(manualSurfaces, "docs"),
        source_repo: overlayFieldOrFallback(
          manualOverlay,
          "source_repo",
          firstUrl(manualSurfaces, "source-repo"),
        ),
        website_url: overlayFieldOrFallback(
          manualOverlay,
          "website_url",
          firstUrl(manualSurfaces, "website"),
        ),
        curation: {
          ...(manualOverlay.curation || {}),
          source_count: Math.max(
            manualOverlay.curation?.source_count || 0,
            sourceUrls.size,
          ),
        },
        surfaces,
      };
    }),
  );
}

export function buildGeneratedOverlaySummary({
  generatedOverlays,
  manualOverlays,
  nativeSnapshot,
  verification,
  mode = "write",
}) {
  const promotedSurfaceCount = generatedOverlays.reduce(
    (count, overlay) => count + overlay.surfaces.length,
    0,
  );

  return {
    schema_version: 1,
    mode,
    native_subnet_count: nativeSnapshot.subnets.length,
    manual_overlay_count: manualOverlays.length,
    generated_overlay_count: generatedOverlays.length,
    total_overlay_count: manualOverlays.length + generatedOverlays.length,
    promoted_surface_count: promotedSurfaceCount,
    generated_without_surfaces: generatedOverlays
      .filter((overlay) => overlay.surfaces.length === 0)
      .map((overlay) => overlay.netuid),
    verification_result_count: verification.results?.length || 0,
    overlays: generatedOverlays.map((overlay) => ({
      checksum: hashJson(overlay),
      netuid: overlay.netuid,
      slug: overlay.slug,
      surface_count: overlay.surfaces.length,
    })),
  };
}

export async function writeGeneratedOverlayArtifacts({
  generatedOverlays,
  manualOverlays,
  nativeSnapshot,
  verification,
}) {
  const summary = buildGeneratedOverlaySummary({
    generatedOverlays,
    manualOverlays,
    nativeSnapshot,
    verification,
  });
  await fs.rm(generatedOverlayDirectory, { recursive: true, force: true });
  await writeJson(generatedOverlaySummaryPath, summary);
  await writeJson(generatedOverlaySourcePath, {
    schema_version: 1,
    generated_at: nativeSnapshot.captured_at || null,
    overlays: generatedOverlays,
  });
  return summary;
}

// Curation block for a generated overlay. A maintainer-reviewed decision elevates
// the level to the trusted tier (only when there are surfaces to vouch for);
// otherwise it's machine-verified (has surfaces) or candidate-discovered (none).
// reviewed_at stays null here — the authoritative timestamp lives in the decision
// file (registry/reviews/maintainer-reviewed.json), the single source of truth.
function buildGeneratedCuration({
  hasSurfaces,
  hasReviewedEvidence,
  sourceCount,
  gapNotes,
}) {
  const elevated = hasSurfaces && hasReviewedEvidence;
  return {
    level: elevated
      ? "maintainer-reviewed"
      : hasSurfaces
        ? "machine-verified"
        : "candidate-discovered",
    review_state: elevated ? "maintainer-reviewed" : "machine-generated",
    reviewed_at: null,
    verified_at: null,
    source_count: sourceCount,
    gap_notes: gapNotes,
  };
}

function buildGeneratedOverlay({
  candidatesByNetuid,
  existingGeneratedByNetuid,
  nativeSubnet,
  providersById,
  verificationByCandidate,
  maintainerReviewedDecisionsByNetuid = new Map(),
}) {
  const subnetCandidates = candidatesByNetuid.get(nativeSubnet.netuid) || [];
  const promotedSurfaces = subnetCandidates
    .map((candidate) => ({
      candidate,
      verification: verificationByCandidate.get(candidate.id),
    }))
    .filter(({ candidate, verification }) =>
      isPromotable(candidate, verification, providersById),
    )
    .map(({ candidate, verification }) =>
      promoteCandidate(candidate, verification),
    )
    .filter(uniqueSurfaceLocator())
    .filter(limitPromotedSurfaceKinds())
    .sort(
      (a, b) =>
        surfaceRank(a.kind) - surfaceRank(b.kind) || a.id.localeCompare(b.id),
    );

  const gaps = calculateGaps(promotedSurfaces);
  const sourceUrls = new Set(
    promotedSurfaces.flatMap((surface) => evidenceSourceUrls(surface)),
  );

  const slug = nativeSubnet.netuid === 0 ? "root" : `sn-${nativeSubnet.netuid}`;
  const existingOverlay = existingGeneratedByNetuid.get(nativeSubnet.netuid);
  const existingName =
    existingOverlay && nativeNameQuality(existingOverlay) === "chain"
      ? existingOverlay.name
      : null;
  const name = nativeDisplayName(nativeSubnet, existingName);

  return {
    schema_version: 1,
    netuid: nativeSubnet.netuid,
    name,
    slug,
    status: nativeSubnet.status,
    categories:
      nativeSubnet.netuid === 0 ? ["root", "system"] : ["baseline-curated"],
    docs_url: firstUrl(promotedSurfaces, "docs"),
    source_repo: firstUrl(promotedSurfaces, "source-repo"),
    dashboard_url: firstUrl(promotedSurfaces, "dashboard"),
    website_url: firstUrl(promotedSurfaces, "website"),
    notes:
      nativeSubnet.netuid === 0
        ? "Machine-generated root/system baseline overlay."
        : "Machine-generated baseline overlay from verified public-source candidates.",
    curation: buildGeneratedCuration({
      hasSurfaces: promotedSurfaces.length > 0,
      hasReviewedEvidence: hasMaintainerReviewedEvidence(
        promotedSurfaces,
        maintainerReviewedDecisionsByNetuid.get(nativeSubnet.netuid) || [],
      ),
      sourceCount: sourceUrls.size,
      gapNotes: gaps.gap_notes,
    }),
    links: [],
    surfaces: promotedSurfaces,
  };
}

function hasMaintainerReviewedEvidence(surfaces, decisions) {
  if (surfaces.length === 0 || decisions.length === 0) {
    return false;
  }

  const promotedUrls = new Set(
    surfaces
      .flatMap((surface) => [surface.url, ...evidenceSourceUrls(surface)])
      .map((url) => normalizePublicUrl(url))
      .filter(Boolean),
  );
  return decisions.some((decision) =>
    evidenceSourceUrls(decision)
      .map((url) => normalizePublicUrl(url))
      .filter(Boolean)
      .some((url) => promotedUrls.has(url)),
  );
}

const OWNER_SENSITIVE_KINDS = new Set([
  "source-repo",
  "website",
  "subnet-api",
  "openapi",
  "sse",
]);

function isPromotable(candidate, verification, providersById = new Map()) {
  if (
    !verification ||
    !["live", "redirected"].includes(verification.classification)
  ) {
    return false;
  }
  if (
    isUnsafeUrl(candidate.url) ||
    (verification.redirect_target &&
      isUnsafeUrl(verification.redirect_target)) ||
    verification.private_redirect_blocked
  ) {
    return false;
  }
  if (candidate.state && candidate.state !== "schema-valid") {
    return false;
  }
  if (isCommunityOwnerSensitiveCandidate(candidate)) {
    const providerRecord = providersById.get(candidate.provider);
    const identityTokens = providerIdentityTokens(providerRecord);
    const claimTokens = urlOwnerTokens(candidate.url);
    if (!ownerTokensMatch(claimTokens, identityTokens)) {
      return false;
    }
  }
  if (isGenericToolingSurface(candidate)) {
    return false;
  }
  if (
    candidate.kind === "website" &&
    candidate.source_type === "project-website-link"
  ) {
    return false;
  }
  if (candidate.kind === "subnet-api") {
    return isApiContentType(verification.content_type);
  }
  if (candidate.kind === "openapi") {
    return isJsonContentType(verification.content_type);
  }
  return true;
}

function isCommunityOwnerSensitiveCandidate(candidate) {
  return (
    OWNER_SENSITIVE_KINDS.has(candidate.kind) &&
    (candidate.source_type === "community-pr-intake" ||
      candidate.source_tier === "community-docs")
  );
}

function isGenericToolingSurface(candidate) {
  let url;
  try {
    url = new URL(candidate.url);
  } catch {
    return true;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const pathname = url.pathname.toLowerCase();
  if (candidate.kind === "openapi") {
    return (
      (host === "github.com" &&
        ["/swagger", "/swagger.json"].includes(pathname)) ||
      host === "swagger.io" ||
      (host === "github.com" && pathname.includes("/swagger")) ||
      (host === "github.com" && pathname.includes("/swaggo/"))
    );
  }

  return false;
}

function limitPromotedSurfaceKinds() {
  const counts = new Map();
  const limits = {
    dashboard: 3,
    "data-artifact": 5,
    docs: 4,
    openapi: 3,
    "source-repo": 4,
    "subnet-api": 4,
    website: 2,
  };

  return (surface) => {
    const count = counts.get(surface.kind) || 0;
    const limit = limits[surface.kind] || 2;
    if (count >= limit) {
      return false;
    }
    counts.set(surface.kind, count + 1);
    return true;
  };
}

function isApiContentType(contentType) {
  const normalized = String(contentType || "").toLowerCase();
  return (
    normalized.includes("json") ||
    normalized.includes("text/plain") ||
    normalized.includes("text/event-stream") ||
    normalized.includes("application/octet-stream")
  );
}

function isJsonContentType(contentType) {
  return String(contentType || "")
    .toLowerCase()
    .includes("json");
}

function uniqueSurfaceLocator() {
  const seen = new Set();
  return (surface) => {
    const key = registrySurfaceKey(surface);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  };
}

function promoteCandidate(candidate, verification) {
  const surface = {
    id: candidate.id,
    name: candidate.name,
    kind: candidate.kind,
    url: candidate.url,
    provider: candidate.provider,
    auth_required: false,
    authority: "registry-observed",
    public_safe: true,
    source_urls: evidenceSourceUrls(candidate),
    quality_signals: verification.quality_signals,
    rate_limit: candidate.rate_limit,
    rate_limit_notes: candidate.rate_limit_notes,
    probe: probeForKind(candidate.kind),
    notes: candidate.review_notes,
  };

  if (candidate.kind === "openapi") {
    surface.schema_url = candidate.url;
    surface.schema_status = "machine-readable";
  }

  return surface;
}

function calculateGaps(surfaces) {
  const kinds = new Set(surfaces.map((surface) => surface.kind));
  const gapNotes = [];
  const expected = [
    ["docs", "No verified project docs surface yet."],
    ["source-repo", "No verified source repository yet."],
    ["website", "No verified project website yet."],
    ["dashboard", "No verified dashboard yet."],
    ["openapi", "No verified OpenAPI/Swagger surface yet."],
    ["subnet-api", "No verified subnet API surface yet."],
    ["sse", "No verified SSE/event stream yet."],
    ["data-artifact", "No verified data artifact yet."],
  ];

  for (const [kind, message] of expected) {
    if (!kinds.has(kind)) {
      gapNotes.push(message);
    }
  }

  return { gap_notes: gapNotes };
}

function firstUrl(surfaces, kind) {
  return surfaces.find((surface) => surface.kind === kind)?.url;
}

function probeForKind(kind) {
  if (kind === "sse") {
    return { enabled: true, method: "GET", expect: "sse", timeout_ms: 5000 };
  }
  if (kind === "openapi" || kind === "subnet-api") {
    return { enabled: true, method: "GET", expect: "any", timeout_ms: 10000 };
  }
  return { enabled: true, method: "HEAD", expect: "any", timeout_ms: 10000 };
}

function surfaceRank(kind) {
  return (
    {
      "source-repo": 1,
      website: 2,
      docs: 3,
      dashboard: 4,
      openapi: 5,
      "subnet-api": 6,
      sse: 7,
      "data-artifact": 8,
    }[kind] || 99
  );
}

function groupByNetuid(items) {
  const groups = new Map();
  for (const item of items) {
    const group = groups.get(item.netuid) || [];
    group.push(item);
    groups.set(item.netuid, group);
  }
  return groups;
}

function sortOverlays(overlays) {
  return overlays.sort(
    (a, b) => a.netuid - b.netuid || a.slug.localeCompare(b.slug),
  );
}

export function printGeneratedOverlaySummary(summary) {
  if (process.env.METAGRAPH_VERBOSE_SUMMARY === "1") {
    console.log(stableStringify(summary));
    return;
  }

  const { overlays, ...compact } = summary;
  console.log(
    stableStringify({
      ...compact,
      overlay_checksum_count: overlays?.length || 0,
      overlay_summary_path: "registry/generated/subnet-overlays-summary.json",
    }),
  );
}

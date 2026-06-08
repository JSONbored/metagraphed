import { promises as fs } from "node:fs";
import path from "node:path";
import {
  generatedSourceRoot,
  hashJson,
  isUnsafeUrl,
  listJsonFiles,
  loadCandidates,
  loadNativeSnapshot,
  loadVerification,
  nativeDisplayName,
  nativeNameQuality,
  readJson,
  registrySurfaceKey,
  repoRoot,
  stableStringify,
  writeJson,
} from "./lib.mjs";

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
  const manualOverlays =
    options.manualOverlays || (await loadManualSubnetOverlays());
  const existingGeneratedOverlays =
    options.existingGeneratedOverlays ||
    (await loadExistingGeneratedSubnetOverlays());

  const manualNetuids = new Set(
    manualOverlays.map((overlay) => overlay.netuid),
  );
  const existingGeneratedByNetuid = new Map(
    existingGeneratedOverlays.map((overlay) => [overlay.netuid, overlay]),
  );
  const verificationByCandidate = new Map(
    (verification.results || []).map((result) => [result.candidate_id, result]),
  );
  const candidatesByNetuid = groupByNetuid(candidates);
  const generatedOverlays = [];

  for (const nativeSubnet of nativeSnapshot.subnets || []) {
    if (manualNetuids.has(nativeSubnet.netuid)) {
      continue;
    }
    generatedOverlays.push(
      buildGeneratedOverlay({
        candidatesByNetuid,
        existingGeneratedByNetuid,
        nativeSubnet,
        verificationByCandidate,
      }),
    );
  }

  const summary = buildGeneratedOverlaySummary({
    generatedOverlays,
    manualOverlays,
    nativeSnapshot,
    verification,
  });

  return {
    candidates,
    generatedOverlays,
    manualOverlays,
    nativeSnapshot,
    summary,
    verification,
  };
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

function buildGeneratedOverlay({
  candidatesByNetuid,
  existingGeneratedByNetuid,
  nativeSubnet,
  verificationByCandidate,
}) {
  const subnetCandidates = candidatesByNetuid.get(nativeSubnet.netuid) || [];
  const promotedSurfaces = subnetCandidates
    .map((candidate) => ({
      candidate,
      verification: verificationByCandidate.get(candidate.id),
    }))
    .filter(({ candidate, verification }) =>
      isPromotable(candidate, verification),
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
    promotedSurfaces.flatMap((surface) => surface.source_urls || []),
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
    curation: {
      level:
        promotedSurfaces.length > 0
          ? "machine-verified"
          : "candidate-discovered",
      review_state: "machine-generated",
      reviewed_at: null,
      verified_at: null,
      source_count: sourceUrls.size,
      gap_notes: gaps.gap_notes,
    },
    links: [],
    surfaces: promotedSurfaces,
  };
}

function isPromotable(candidate, verification) {
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
    const pathname = new URL(candidate.url).pathname.toLowerCase();
    if (pathname.endsWith(".json")) {
      return isJsonContentType(verification.content_type);
    }
    return (
      isJsonContentType(verification.content_type) ||
      isHtmlContentType(verification.content_type)
    );
  }
  return true;
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

function isHtmlContentType(contentType) {
  return String(contentType || "")
    .toLowerCase()
    .includes("html");
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
    source_urls: candidate.source_urls || [candidate.source_url],
    quality_signals: verification.quality_signals,
    rate_limit_notes: candidate.rate_limit_notes,
    probe: probeForKind(candidate.kind),
    notes: candidate.review_notes,
  };

  if (candidate.kind === "openapi") {
    const pathname = new URL(candidate.url).pathname.toLowerCase();
    if (
      pathname.endsWith(".json") &&
      isJsonContentType(verification.content_type)
    ) {
      surface.schema_url = candidate.url;
      surface.schema_status = "machine-readable";
    } else {
      surface.schema_status = "ui-only";
      surface.notes =
        `${surface.notes || ""} Machine-readable OpenAPI schema has not been captured for this surface.`.trim();
    }
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

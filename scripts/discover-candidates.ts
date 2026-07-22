import path from "node:path";
import {
  apiDocsSubdomainOrigins,
  buildTimestamp,
  isLikelyExampleLink,
  isPlaceholderIdentityUrl,
  isUnsafeResolvedUrl,
  listJsonFilesRecursive,
  loadNativeSnapshot,
  loadProviders,
  loadSubnets,
  nativeDisplayName,
  normalizePublicUrl,
  OPENAPI_PROBE_PATHS,
  probeOpenApiSpec,
  readCommittedManifestGeneratedAt,
  readJson,
  isLikelyProjectDomain,
  README_KIND_LIMITS,
  README_LINK_LIMIT,
  repoRoot,
  selectReviewableReadmeLinks,
  slugify,
  stableStringify,
  writeJson,
} from "./lib.mjs";

type Row = Record<string, unknown>;

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const nativeSnapshot: Row = await loadNativeSnapshot();
const nativeSnapshotSubnets = nativeSnapshot.subnets as Row[];
const existingOverlays: Row[] = await loadSubnets();
const providers: Row[] = await loadProviders();
const providerIds = new Set(providers.map((provider) => provider.id as string));
const observedAt =
  process.env.METAGRAPH_PERSIST_DISCOVERY_OBSERVED_AT === "1"
    ? process.env.METAGRAPH_DISCOVERY_OBSERVED_AT || new Date().toISOString()
    : null;
const nativeByNetuid = new Map<number, Row>(
  nativeSnapshotSubnets.map((subnet) => [subnet.netuid as number, subnet]),
);
const overlayNameByNetuid = new Map<number, string>(
  existingOverlays
    .filter((overlay) => overlay.name)
    .map((overlay) => [overlay.netuid as number, overlay.name as string]),
);
const overlayProviderByNetuid = new Map<number, string>(
  existingOverlays.map((overlay) => [
    overlay.netuid as number,
    selectOverlayProvider(overlay),
  ]),
);
const netuidsWithProjectDocs = new Set<number>(
  existingOverlays
    .filter((overlay) =>
      ((overlay.surfaces as Row[]) || []).some(
        (surface) =>
          surface.kind === "docs" && !isCommunityDocsProvider(surface.provider),
      ),
    )
    .map((overlay) => overlay.netuid as number),
);
// Subnets that already expose an `openapi` surface — nothing to auto-discover.
const netuidsWithOpenapi = new Set<number>(
  existingOverlays
    .filter((overlay) =>
      ((overlay.surfaces as Row[]) || []).some(
        (surface) => surface.kind === "openapi",
      ),
    )
    .map((overlay) => overlay.netuid as number),
);
// Body cap for an OpenAPI spec probe — generous enough for real specs while
// bounding what a hostile path can stream back into the discovery process.
const OPENAPI_SPEC_PROBE_MAX_BYTES = 2 * 1024 * 1024;
const candidatesByKey = new Map<string, Row>();
const candidateIds = new Set<string>();
const warnings: string[] = [];
const existingGeneratedCandidates = await loadExistingGeneratedCandidates();
// A committed community/curated candidate already pins a locator that the live
// OpenAPI/website probes can rediscover under a different id — which trips
// validate's candidate-locator uniqueness in the production publish (#1026
// follow-up). CI builds from committed data only, so it never sees the live
// collision; that's why the publish failed while every PR's CI stayed green.
// Reserve every committed community candidate's locator (same key format as
// addCandidate, via the shared normalizeCandidateUrl) so the discovery never
// emits a duplicate of one — the committed candidate stands.
const reservedCandidateLocators = new Set<string>();
for (const file of await listJsonFilesRecursive(
  path.join(repoRoot, "registry/candidates/community"),
)) {
  const document: Row = await readJson(file);
  for (const candidate of (document.candidates as Row[]) || []) {
    const normalizedUrl = normalizeCandidateUrl(candidate.url);
    if (!normalizedUrl) continue;
    reservedCandidateLocators.add(
      `${candidate.netuid}:${candidate.kind}:${normalizedUrl.toLowerCase()}`,
    );
  }
}
const restoredProviders = new Set<string>();
const TAOPEDIA_ARTICLE_PROBE_MAX_BYTES = 64 * 1024;
// TaoMarketCap normally reports a finite `count`, but keep count-less
// pagination bounded so a malformed `next` chain cannot hang refresh jobs.
const TAOMARKETCAP_MAX_PAGES = 50;

await discoverFromNativeChainIdentity();
await discoverFromTaoMarketCap();
await discoverFromTensorplexSubnetDocs();
await discoverFromTaopediaArticles();
await discoverUniversalTaoMarketCapDashboards();
await discoverUniversalBackpropFinanceDashboards();
await discoverUniversalTaostatsMetagraphDashboards();
await discoverUniversalSubnetRadarDashboards();
// OpenAPI auto-discovery probes already-known API/docs surfaces (local overlay
// data) plus the discovered project websites, so it runs UNCONDITIONALLY —
// independent of whether the flaky third-party index sources fell back to
// restore mode — and before the website pass so a probe-confirmed spec wins the
// de-dupe over the blind common-path guess (addCommonApiPathCandidates) for the
// same URL. It is always freshly probed, so it is not part of the restore set.
await discoverOpenApiSpecs();
if (restoredProviders.size === 0) {
  await discoverFromGithubReadmes();
  await discoverFromProjectWebsites();
} else {
  restoreExistingCandidatesForSourceTypes([
    "github-readme-link",
    "project-website-common-path",
    "project-website-docs-subdomain",
    "project-website-link",
  ]);
}

const candidates = [...candidatesByKey.values()].sort(
  (a, b) =>
    (a.netuid as number) - (b.netuid as number) ||
    (a.kind as string).localeCompare(b.kind as string) ||
    (a.id as string).localeCompare(b.id as string),
);

const summary = {
  mode: dryRun ? "dry-run" : "write",
  native_subnet_count: nativeSnapshotSubnets.length,
  generated_candidate_count: candidates.length,
  candidate_subnet_count: new Set(
    candidates.map((candidate) => candidate.netuid),
  ).size,
  by_provider: countBy(candidates, "provider"),
  by_kind: countBy(candidates, "kind"),
  github_readme_policy: {
    kind_limits_per_repository: README_KIND_LIMITS,
    link_limit_per_repository: README_LINK_LIMIT,
    provenance:
      "README-derived links must be project-affiliated and are de-duplicated by kind/domain before entering the candidate bundle.",
  },
  warnings,
};

if (!dryRun) {
  const publicSourcesPath = path.join(
    repoRoot,
    "registry/candidates/generated/public-sources.json",
  );
  // Preserve the committed public-sources.json `generated_at` on a local build
  // so `npm run discover:candidates` never clobbers it with the 1970 epoch
  // placeholder; publish runs (METAGRAPH_BUILD_TIMESTAMP/RUN_ID set) get the
  // real build timestamp via buildTimestamp(). Mirrors the r2-manifest path.
  const generatedAt =
    (await readCommittedManifestGeneratedAt(publicSourcesPath)) ??
    buildTimestamp();
  await writeJson(publicSourcesPath, {
    schema_version: 1,
    generated_by: "metagraphed-discover-candidates",
    generated_at: generatedAt,
    native_snapshot_captured_at: nativeSnapshot.captured_at,
    notes:
      "Generated candidate surfaces from public sources. These are not verified registry surfaces until maintainer review promotes them into registry/subnets.",
    observed_at: observedAt,
    sources: [
      {
        id: "native-subnet-identities-v3",
        url: "https://docs.learnbittensor.org/python-api/html/_modules/bittensor/core/chain_data/subnet_identity.html",
      },
      {
        id: "taomarketcap",
        url: "https://api.taomarketcap.com/public/v1/subnets/",
      },
      {
        id: "backprop-finance",
        url: "https://backprop.finance/dtao/subnets/",
      },
      {
        id: "taostats",
        url: "https://taostats.io/subnets/",
      },
      {
        id: "subnetradar",
        url: "https://subnetradar.com/subnet/",
      },
      {
        id: "tensorplex-subnet-docs",
        url: "https://github.com/tensorplex-labs/subnet-docs",
      },
      {
        id: "taopedia-articles",
        url: "https://github.com/e35ventura/taopedia-articles",
      },
      {
        id: "github-readme-links",
        url: "https://github.com",
      },
      {
        id: "project-website-links",
        url: "https://metagraph.sh",
      },
    ],
    candidates,
  });
}

console.log(stableStringify(summary));

async function discoverFromNativeChainIdentity(): Promise<void> {
  const sourceUrl =
    "https://docs.learnbittensor.org/python-api/html/_modules/bittensor/core/chain_data/subnet_identity.html";

  for (const subnet of nativeSnapshotSubnets) {
    const identity = subnet.chain_identity as Row | undefined;
    if (!identity || typeof identity !== "object") {
      continue;
    }

    const netuid = subnet.netuid as number;
    const displayName =
      cleanName(identity.subnet_name) || displayNameForNetuid(netuid);
    const provider = providerForNativeIdentity(netuid);

    for (const url of extractUrls(identity.subnet_url)) {
      addCandidate({
        id: `sn-${netuid}-native-chain-website`,
        netuid,
        name: `${displayName} website`,
        kind: "website",
        url,
        source_url: sourceUrl,
        source_type: "subtensor-subnet-identities-v3",
        source_tier: "native-chain",
        confidence: "high",
        provider,
        review_notes:
          "Discovered from native Subtensor SubnetIdentitiesV3 metadata. Candidate still requires safe probe verification and maintainer review before promotion.",
      });
    }

    for (const url of extractUrls(identity.github_repo)) {
      addCandidate({
        id: `sn-${netuid}-native-chain-github`,
        netuid,
        name: `${displayName} GitHub ${
          githubSurfaceKind(url) === "repo-registry"
            ? "repository registry"
            : "source repository"
        }`,
        kind: githubSurfaceKind(url),
        url,
        source_url: sourceUrl,
        source_type: "subtensor-subnet-identities-v3",
        source_tier: "native-chain",
        confidence: "high",
        provider,
        review_notes:
          "Discovered from native Subtensor SubnetIdentitiesV3 metadata. Candidate still requires safe probe verification and maintainer review before promotion.",
      });
    }
  }
}

function selectOverlayProvider(overlay: Row): string {
  const ignoredProviders = new Set([
    "backprop-finance",
    "opentensor",
    "subnetradar",
    "taomarketcap",
    "taopedia-articles",
    "taostats",
    "tensorplex-subnet-docs",
  ]);
  for (const surface of (overlay.surfaces as Row[]) || []) {
    if (
      surface.provider &&
      providerIds.has(surface.provider as string) &&
      !ignoredProviders.has(surface.provider as string)
    ) {
      return surface.provider as string;
    }
  }
  if (overlay.slug && providerIds.has(overlay.slug as string)) {
    return overlay.slug as string;
  }
  return "opentensor";
}

function providerForNativeIdentity(netuid: number): string {
  return overlayProviderByNetuid.get(netuid) || "opentensor";
}

async function discoverFromTaoMarketCap(): Promise<void> {
  const limit = 100;
  let offset = 0;
  let expectedCount: number | null = null;

  for (let pageIndex = 0; pageIndex < TAOMARKETCAP_MAX_PAGES; pageIndex += 1) {
    if (expectedCount !== null && offset >= expectedCount) {
      break;
    }

    const pageUrl = `https://api.taomarketcap.com/public/v1/subnets/?limit=${limit}&offset=${offset}`;
    const page = await fetchJson(pageUrl);
    if (!page) {
      if (offset === 0) {
        restoreExistingCandidatesForProvider("taomarketcap");
      }
      return;
    }

    // Only bound the loop by total when the API actually reports one. The old
    // fallback `offset + results.length` equalled the just-advanced offset, so a
    // response without `count` exited after page 1 even when `page.next` pointed
    // at more pages. Leave it null and let the `if (!page.next) break` below
    // (the API's own pagination signal) terminate the walk.
    expectedCount = Number.isInteger(page.count)
      ? (page.count as number)
      : null;
    for (const subnet of (page.results as Row[]) || []) {
      const netuid = Number(subnet.netuid);
      if (!nativeByNetuid.has(netuid) || subnet.is_active === false) {
        continue;
      }

      const latestSnapshot = subnet.latest_snapshot as Row | undefined;
      const identity = latestSnapshot?.subnet_identities_v3 as Row | undefined;
      if (!identity || typeof identity !== "object") {
        continue;
      }

      const sourceUrl = `https://api.taomarketcap.com/public/v1/subnets/${netuid}/`;
      const displayName =
        cleanName(identity.subnetName) || displayNameForNetuid(netuid);

      for (const url of extractUrls(identity.subnetUrl)) {
        addCandidate({
          id: `sn-${netuid}-taomarketcap-website`,
          netuid,
          name: `${displayName} website`,
          kind: "website",
          url,
          source_url: sourceUrl,
          source_type: "taomarketcap-subnet-identity-v3",
          source_tier: "third-party-index",
          confidence: "medium",
          provider: "taomarketcap",
          review_notes:
            "Discovered from TaoMarketCap subnet identity metadata. Not probed or verified by Metagraphed.",
        });
      }

      for (const url of extractUrls(identity.githubRepo)) {
        addCandidate({
          id: `sn-${netuid}-taomarketcap-source-repo`,
          netuid,
          name: `${displayName} source repository`,
          kind: "source-repo",
          url,
          source_url: sourceUrl,
          source_type: "taomarketcap-subnet-identity-v3",
          source_tier: "third-party-index",
          confidence: "medium",
          provider: "taomarketcap",
          review_notes:
            "Discovered from TaoMarketCap subnet identity metadata. Not probed or verified by Metagraphed.",
        });
      }
    }

    if (!page.next) {
      break;
    }
    offset += limit;

    if (pageIndex === TAOMARKETCAP_MAX_PAGES - 1) {
      warnings.push(
        `TaoMarketCap pagination exceeded ${TAOMARKETCAP_MAX_PAGES} pages; stopping discovery to avoid an unbounded refresh`,
      );
    }
  }
}

async function discoverFromTensorplexSubnetDocs(): Promise<void> {
  let discoveredCount = 0;

  await mapLimit(
    nativeSnapshotSubnets
      .map((subnet) => subnet.netuid as number)
      .sort((a, b) => a - b),
    8,
    async (netuid) => {
      const rawUrl = `https://raw.githubusercontent.com/tensorplex-labs/subnet-docs/main/data/${netuid}/subnet.json`;
      const repoUrl = `https://github.com/tensorplex-labs/subnet-docs/blob/main/data/${netuid}/subnet.json`;
      const directoryUrl = `https://github.com/tensorplex-labs/subnet-docs/tree/main/data/${netuid}`;
      const document = await fetchJson(rawUrl, {}, { warn: false });
      if (!document) {
        return;
      }
      discoveredCount += 1;

      const nativeName = displayNameForNetuid(netuid);
      const displayName = cleanName(document.name) || nativeName;
      addCandidate({
        id: `sn-${netuid}-tensorplex-docs`,
        netuid,
        name: `${displayName} Tensorplex subnet docs`,
        kind: "docs",
        url: directoryUrl,
        source_url: repoUrl,
        source_type: "tensorplex-subnet-docs",
        source_tier: "community-docs",
        confidence: "medium",
        provider: "tensorplex-subnet-docs",
        review_notes:
          "Discovered from Tensorplex subnet-docs. Useful as documentation enrichment, not verified operational authority.",
      });

      for (const [index, rawUrlValue] of arrayFrom(document.github).entries()) {
        for (const url of extractUrls(rawUrlValue)) {
          addCandidate({
            id: `sn-${netuid}-tensorplex-source-repo-${index + 1}`,
            netuid,
            name: `${displayName} source repository`,
            kind: "source-repo",
            url,
            source_url: repoUrl,
            source_type: "tensorplex-subnet-docs-github",
            source_tier: "community-docs",
            confidence: "medium",
            provider: "tensorplex-subnet-docs",
            review_notes:
              "Discovered from Tensorplex subnet-docs. Not probed or verified by Metagraphed.",
          });
        }
      }

      for (const url of extractUrls(document.hw_requirements)) {
        addCandidate({
          id: `sn-${netuid}-tensorplex-hardware-docs`,
          netuid,
          name: `${displayName} hardware requirements`,
          kind: "docs",
          url,
          source_url: repoUrl,
          source_type: "tensorplex-subnet-docs-hardware",
          source_tier: "community-docs",
          confidence: "low",
          provider: "tensorplex-subnet-docs",
          review_notes:
            "Discovered from Tensorplex subnet-docs hardware requirements metadata.",
        });
      }

      for (const [index, website] of arrayFrom(document.websites).entries()) {
        const site = website as Row | undefined;
        const kind = surfaceKindForWebsiteLabel(site?.label);
        if (!kind) {
          continue;
        }
        for (const url of extractUrls(site?.url)) {
          const label =
            slugify((site?.label as string) || "website") || "website";
          addCandidate({
            id: `sn-${netuid}-tensorplex-${label}-${index + 1}`,
            netuid,
            name: `${displayName} ${site?.label || "website"}`,
            kind,
            url,
            source_url: repoUrl,
            source_type: "tensorplex-subnet-docs-website",
            source_tier: "community-docs",
            confidence: "low",
            provider: "tensorplex-subnet-docs",
            review_notes:
              "Discovered from Tensorplex subnet-docs website metadata. Not probed or verified by Metagraphed.",
          });
        }
      }
    },
  );

  if (discoveredCount === 0) {
    warnings.push(
      "tensorplex-subnet-docs: failed to fetch any raw subnet documents",
    );
    restoreExistingCandidatesForProvider("tensorplex-subnet-docs");
  }
}

async function discoverFromTaopediaArticles(): Promise<void> {
  let discoveredCount = 0;
  const existingTaopediaByNetuid = new Map<number, Row>(
    existingGeneratedCandidates
      .filter((candidate) => candidate.provider === "taopedia-articles")
      .map((candidate) => [candidate.netuid as number, candidate]),
  );
  await mapLimit(
    nativeSnapshotSubnets
      .map((subnet) => subnet.netuid as number)
      .filter((netuid) => netuid !== 0)
      .sort((a, b) => a - b),
    8,
    async (netuid) => {
      const articlePath =
        (await fetchTaopediaArticlePath(
          `content/pages/subnet_${netuid}/index.mdx`,
        )) ||
        (await fetchTaopediaArticlePath(
          githubBlobPath(existingTaopediaByNetuid.get(netuid)?.url),
        ));
      if (!articlePath) {
        return;
      }
      discoveredCount += 1;
      const url = `https://github.com/e35ventura/taopedia-articles/blob/main/${articlePath}`;
      addCandidate({
        id: `sn-${netuid}-taopedia-article`,
        netuid,
        name: `${displayNameForNetuid(netuid)} Taopedia article`,
        kind: "docs",
        url,
        source_url: url,
        source_type: "taopedia-article",
        source_tier: "community-docs",
        confidence: "low",
        provider: "taopedia-articles",
        review_notes:
          "Discovered from the public Taopedia article repository. Not verified as an operational interface.",
      });
    },
  );

  if (discoveredCount === 0) {
    warnings.push("taopedia-articles: failed to fetch any raw article pages");
    restoreExistingCandidatesForProvider("taopedia-articles");
  }
}

async function fetchTaopediaArticlePath(
  pathValue: string | null,
): Promise<string | null> {
  if (!pathValue) {
    return null;
  }
  const rawUrl = `https://raw.githubusercontent.com/e35ventura/taopedia-articles/main/${pathValue}`;
  const response = await fetchText(rawUrl, {
    accept: "text/plain",
    maxBytes: TAOPEDIA_ARTICLE_PROBE_MAX_BYTES,
    warn: false,
  });
  if (!response || response.status_code !== 200 || !response.text.trim()) {
    return null;
  }
  return pathValue;
}

async function discoverUniversalTaoMarketCapDashboards(): Promise<void> {
  for (const subnet of nativeSnapshotSubnets) {
    const netuid = subnet.netuid as number;
    addCandidate({
      id: `sn-${netuid}-taomarketcap-dashboard`,
      netuid,
      name: `${displayNameForNetuid(netuid)} TaoMarketCap dashboard`,
      kind: "dashboard",
      url: `https://taomarketcap.com/subnets/${netuid}`,
      source_url: `https://api.taomarketcap.com/public/v1/subnets/${netuid}/`,
      source_type: "taomarketcap-dashboard",
      source_tier: "third-party-index",
      confidence: "medium",
      provider: "taomarketcap",
      review_notes:
        "Universal TaoMarketCap subnet dashboard candidate. Third-party enrichment, not protocol authority.",
    });
  }
}

async function discoverUniversalBackpropFinanceDashboards(): Promise<void> {
  for (const subnet of nativeSnapshotSubnets) {
    const netuid = subnet.netuid as number;
    const displayName = displayNameForNetuid(netuid);
    const subnetSlug = slugify(displayName) || `subnet-${netuid}`;
    const url = `https://backprop.finance/dtao/subnets/${netuid}-${subnetSlug}`;
    addCandidate({
      id: `sn-${netuid}-backprop-dashboard`,
      netuid,
      name: `${displayName} Backprop Finance dashboard`,
      kind: "dashboard",
      url,
      source_url: url,
      source_type: "backprop-dashboard",
      source_tier: "third-party-index",
      confidence: "medium",
      provider: "backprop-finance",
      review_notes:
        "Universal Backprop Finance dTAO subnet dashboard candidate. Third-party enrichment, not protocol authority.",
    });
  }
}

async function discoverUniversalTaostatsMetagraphDashboards(): Promise<void> {
  for (const subnet of nativeSnapshotSubnets) {
    const netuid = subnet.netuid as number;
    const displayName = displayNameForNetuid(netuid);
    const url = `https://taostats.io/subnets/${netuid}/metagraph`;
    addCandidate({
      id: `sn-${netuid}-taostats-metagraph`,
      netuid,
      name: `${displayName} Taostats metagraph`,
      kind: "dashboard",
      url,
      source_url: url,
      source_type: "taostats-metagraph-dashboard",
      source_tier: "third-party-index",
      confidence: "medium",
      provider: "taostats",
      review_notes:
        "Universal Taostats subnet metagraph dashboard candidate. Third-party explorer enrichment, not protocol authority.",
    });
  }
}

async function discoverUniversalSubnetRadarDashboards(): Promise<void> {
  for (const subnet of nativeSnapshotSubnets) {
    const netuid = subnet.netuid as number;
    const displayName = displayNameForNetuid(netuid);
    const url = `https://subnetradar.com/subnet/${netuid}`;
    addCandidate({
      id: `sn-${netuid}-subnetradar-dashboard`,
      netuid,
      name: `${displayName} SubnetRadar dashboard`,
      kind: "dashboard",
      url,
      source_url: url,
      source_type: "subnetradar-dashboard",
      source_tier: "third-party-index",
      confidence: "medium",
      provider: "subnetradar",
      review_notes:
        "Universal SubnetRadar subnet dashboard candidate. Third-party risk/market analytics enrichment, not Metagraphed endpoint health authority.",
    });
  }
}

async function discoverFromGithubReadmes(): Promise<void> {
  const sourceRepoCandidates = [...candidatesByKey.values()].filter(
    (candidate) =>
      candidate.kind === "source-repo" &&
      parseGithubRepo(candidate.url as string),
  );
  const byRepo = new Map<
    string,
    { repo: { owner: string; repo: string }; candidates: Row[] }
  >();

  for (const candidate of sourceRepoCandidates) {
    const repo = parseGithubRepo(candidate.url as string) as {
      owner: string;
      repo: string;
    };
    const key = `${repo.owner}/${repo.repo}`.toLowerCase();
    if (!byRepo.has(key)) {
      byRepo.set(key, { repo, candidates: [] });
    }
    byRepo.get(key)?.candidates.push(candidate);
  }

  await mapLimit([...byRepo.values()], 8, async ({ repo, candidates }) => {
    const readme = await fetchGithubReadme(repo);
    if (!readme) {
      return;
    }

    for (const candidate of candidates) {
      const repoSlug = slugify(`${repo.owner}-${repo.repo}`);
      const links = (
        selectReviewableReadmeLinks as (
          links: Row[],
          options: { limit?: number; netuid?: unknown; repo?: unknown },
        ) => Row[]
      )(
        extractMarkdownLinks(readme.text, readme.url)
          .map((link): Row => ({
            ...link,
            classification: classifyDiscoveredLink(
              link.url as string,
              link.label,
              candidate.url as string,
            ),
          }))
          .filter((link) => link.classification),
        { netuid: candidate.netuid, repo },
      );

      for (const [index, link] of links.entries()) {
        const classification = link.classification as Row;
        addCandidate({
          id: `sn-${candidate.netuid}-github-readme-${repoSlug}-${classification.kind}-${index + 1}`,
          netuid: candidate.netuid,
          name: `${displayNameForNetuid(candidate.netuid as number)} ${classification.label}`,
          kind: classification.kind,
          url: link.url,
          source_url: readme.htmlUrl,
          source_type: "github-readme-link",
          source_tier: "community-docs",
          confidence: "low",
          provider: candidate.provider,
          review_notes:
            "Discovered from a project-affiliated public GitHub README link after README noise filters. Requires verification before promotion.",
        });
      }
    }
  });
}

async function discoverFromProjectWebsites(): Promise<void> {
  const websiteCandidates = [...candidatesByKey.values()].filter(
    (candidate) => candidate.kind === "website",
  );
  await mapLimit(websiteCandidates, 8, async (candidate) => {
    const root = normalizeCandidateUrl(candidate.url);
    if (!root) {
      return;
    }
    const websiteSlug = slugify(new URL(root).hostname);

    await addDocsSubdomainCandidate(candidate, root);
    addCommonApiPathCandidates(candidate, root);

    const html = await fetchText(root, {
      accept: "text/html,application/xhtml+xml",
      warn: false,
    });
    if (!html?.text) {
      return;
    }

    const links = extractHtmlLinks(html.text, root)
      .filter((link) => isLikelyProjectDomain(root, link.url))
      .map((link): Row => ({
        ...link,
        classification: classifyDiscoveredLink(
          link.url as string,
          link.label,
          root,
        ),
      }))
      .filter((link) => link.classification)
      .slice(0, 10);

    for (const [index, link] of links.entries()) {
      const classification = link.classification as Row;
      addCandidate({
        id: `sn-${candidate.netuid}-website-link-${websiteSlug}-${classification.kind}-${index + 1}`,
        netuid: candidate.netuid,
        name: `${displayNameForNetuid(candidate.netuid as number)} ${classification.label}`,
        kind: classification.kind,
        url: link.url,
        source_url: root,
        source_type: "project-website-link",
        source_tier: "provider-claimed",
        confidence: "low",
        provider: candidate.provider,
        review_notes:
          "Discovered from a public project website link. Requires verification before promotion.",
      });
    }
  });
}

async function addDocsSubdomainCandidate(
  candidate: Row,
  root: string,
): Promise<void> {
  const netuid = candidate.netuid as number;
  if (netuidsWithProjectDocs.has(netuid)) {
    return;
  }

  let docsUrl: string;
  try {
    const parsed = new URL(root);
    if (isGenericHost(parsed.hostname)) {
      return;
    }
    const hostname = parsed.hostname.replace(/^www\./i, "");
    if (
      hostname.startsWith("docs.") ||
      hostname.startsWith("api.") ||
      hostname.startsWith("app.") ||
      hostname.startsWith("dashboard.")
    ) {
      return;
    }
    docsUrl = `https://docs.${hostname}/`;
  } catch {
    return;
  }

  if (await isUnsafeResolvedUrl(docsUrl)) {
    return;
  }

  addCandidate({
    id: `sn-${netuid}-website-subdomain-docs-${slugify(new URL(docsUrl).hostname)}`,
    netuid,
    name: `${displayNameForNetuid(netuid)} docs subdomain`,
    kind: "docs",
    url: docsUrl,
    source_url: root,
    source_type: "project-website-docs-subdomain",
    source_tier: "provider-claimed",
    confidence: "low",
    provider: candidate.provider,
    review_notes:
      "Docs subdomain candidate inferred from a public project website root for a subnet without project-level docs. Requires verification before promotion.",
  });
}

function addCommonApiPathCandidates(candidate: Row, root: string): void {
  let origin: string;
  try {
    const parsed = new URL(root);
    if (isGenericHost(parsed.hostname)) {
      return;
    }
    origin = parsed.origin;
  } catch {
    return;
  }

  const netuid = candidate.netuid as number;
  const commonPaths = [
    { path: "/openapi.json", kind: "openapi", label: "OpenAPI JSON" },
    { path: "/swagger.json", kind: "openapi", label: "Swagger JSON" },
    { path: "/swagger", kind: "openapi", label: "Swagger UI" },
    { path: "/docs", kind: "docs", label: "docs" },
    { path: "/api", kind: "subnet-api", label: "API" },
    { path: "/health", kind: "subnet-api", label: "health endpoint" },
  ];

  for (const commonPath of commonPaths) {
    addCandidate({
      id: `sn-${netuid}-website-common-${slugify(commonPath.path)}`,
      netuid,
      name: `${displayNameForNetuid(netuid)} ${commonPath.label}`,
      kind: commonPath.kind,
      url: `${origin}${commonPath.path}`,
      source_url: root,
      source_type: "project-website-common-path",
      source_tier: "provider-claimed",
      confidence: "low",
      provider: candidate.provider,
      review_notes:
        "Common read-only path discovered from a public project website root. Requires verification before promotion.",
    });
  }
}

// #1004 — actively probe conventional OpenAPI/Swagger paths on each known base
// origin and register an `openapi` candidate only when a path returns a VALID
// spec document. Unlike the blind common-path guesses (addCommonApiPathCandidates),
// these are confirmed by a safe, body-capped probe, so they enter at `medium`
// confidence and feed the same verification + promotion + snapshot-openapi
// pipeline as every other candidate.
async function discoverOpenApiSpecs(): Promise<void> {
  await mapLimit(collectOpenApiBaseOrigins(), 8, async (target) => {
    const match = await probeOpenApiSpec(
      target.origin,
      OPENAPI_PROBE_PATHS,
      fetchOpenApiCandidate,
    );
    if (!match) {
      return;
    }
    let hostSlug: string;
    try {
      hostSlug = slugify(new URL(target.origin).hostname);
    } catch {
      hostSlug = slugify(target.origin);
    }
    addCandidate({
      id: `sn-${target.netuid}-openapi-probe-${hostSlug}`,
      netuid: target.netuid,
      name: `${displayNameForNetuid(target.netuid)} OpenAPI schema`,
      kind: "openapi",
      url: match.url,
      source_url: target.origin,
      source_type: "openapi-probe",
      source_tier: "provider-claimed",
      confidence: "medium",
      provider: target.provider,
      review_notes:
        "OpenAPI/Swagger document confirmed by a safe probe (validated spec structure) at a conventional path. Requires maintainer review before promotion.",
    });
  });
}

// Distinct (netuid, provider, origin) base origins worth probing for a spec: the
// project websites we have discovered plus any API/docs surfaces already known
// for the subnet (specs frequently live on an `api.` subdomain, not the
// marketing site). Subnets that already expose an `openapi` surface are skipped,
// and a candidate with no resolvable provider is dropped (provider is required).
function collectOpenApiBaseOrigins(): {
  netuid: number;
  provider: string;
  origin: string;
}[] {
  const seen = new Set<string>();
  const targets: { netuid: number; provider: string; origin: string }[] = [];
  const pushOrigin = (netuid: number, provider: string, origin: string) => {
    let host: string;
    try {
      host = new URL(origin).hostname;
    } catch {
      return;
    }
    if (isGenericHost(host)) {
      return;
    }
    const key = `${netuid}:${origin}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    targets.push({ netuid, provider, origin });
  };
  const add = (
    netuid: number | null,
    provider: string | null,
    rawUrl: unknown,
  ) => {
    if (netuid == null || !provider || netuidsWithOpenapi.has(netuid)) {
      return;
    }
    const normalized = normalizeCandidateUrl(rawUrl);
    if (!normalized) {
      return;
    }
    let origin: string;
    try {
      origin = new URL(normalized).origin;
    } catch {
      return;
    }
    if (isGenericHost(new URL(origin).hostname)) {
      return;
    }
    pushOrigin(netuid, provider, origin);
    // #1004 — also probe the conventional api./docs. subdomains of the same
    // registrable domain; live specs frequently live there, not on the marketing
    // root (the Graphite/Vidaio/Hippius class the root-only probe missed).
    for (const derived of apiDocsSubdomainOrigins(origin) as string[]) {
      pushOrigin(netuid, provider, derived);
    }
  };

  for (const candidate of candidatesByKey.values()) {
    if (candidate.kind === "website") {
      add(
        candidate.netuid as number,
        candidate.provider as string,
        candidate.url,
      );
    }
  }
  for (const overlay of existingOverlays) {
    const provider = selectOverlayProvider(overlay);
    for (const surface of (overlay.surfaces as Row[]) || []) {
      if (surface.kind === "subnet-api" || surface.kind === "docs") {
        add(overlay.netuid as number, provider, surface.url);
      }
    }
  }
  return targets;
}

// Safe, body-capped JSON fetch for the spec probe: returns the parsed document
// or null on any non-200, oversized, non-JSON, or unsafe/blocked response.
// Delegates to fetchText, which enforces the timeout, byte cap, and
// private-IP/unsafe-URL block (via fetchWithSafeRedirects).
async function fetchOpenApiCandidate(url: string): Promise<unknown> {
  const result = await fetchText(url, {
    accept: "application/json",
    maxBytes: OPENAPI_SPEC_PROBE_MAX_BYTES,
    warn: false,
  });
  if (!result || result.status_code !== 200 || !result.text) {
    return null;
  }
  try {
    return JSON.parse(result.text);
  } catch {
    return null;
  }
}

function isCommunityDocsProvider(provider: unknown): boolean {
  return ["taopedia-articles", "tensorplex-subnet-docs"].includes(
    provider as string,
  );
}

async function loadExistingGeneratedCandidates(): Promise<Row[]> {
  const candidates: Row[] = [];
  try {
    const existing: Row = await readJson(
      path.join(repoRoot, "registry/candidates/generated/public-sources.json"),
    );
    if (Array.isArray(existing.candidates)) {
      candidates.push(...(existing.candidates as Row[]));
    }
  } catch {
    // Continue to the public artifact fallback below.
  }

  try {
    const publicArtifact: Row = await readJson(
      path.join(repoRoot, "public/metagraph/candidates.json"),
    );
    if (Array.isArray(publicArtifact.candidates)) {
      candidates.push(...(publicArtifact.candidates as Row[]));
    }
  } catch {
    // No built candidate artifact exists yet.
  }

  const byKey = new Map<string, Row>();
  for (const candidate of candidates) {
    const key = `${candidate.id}:${candidate.url}`;
    if (!byKey.has(key)) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function restoreExistingCandidatesForProvider(provider: string): void {
  restoredProviders.add(provider);
  for (const candidate of existingGeneratedCandidates.filter(
    (entry) => entry.provider === provider,
  )) {
    restoreCandidate(candidate);
  }
}

function restoreExistingCandidatesForSourceTypes(sourceTypes: string[]): void {
  const sourceTypeSet = new Set(sourceTypes);
  for (const candidate of existingGeneratedCandidates.filter((entry) =>
    sourceTypeSet.has(entry.source_type as string),
  )) {
    restoreCandidate(candidate);
  }
}

function restoreCandidate(candidate: Row): void {
  addCandidate({
    id: candidate.id,
    netuid: candidate.netuid,
    name: candidate.name,
    kind: candidate.kind,
    url: candidate.url,
    source_url: candidate.source_url,
    source_type: candidate.source_type,
    source_tier: candidate.source_tier,
    confidence: candidate.confidence,
    provider: candidate.provider,
    review_notes:
      stripRefreshFailureNote(candidate.review_notes) ||
      "Candidate restored from previous generated bundle.",
  });
}

function githubBlobPath(urlValue: unknown): string | null {
  if (!urlValue) {
    return null;
  }
  try {
    const url = new URL(urlValue as string);
    const prefix = "/e35ventura/taopedia-articles/blob/main/";
    if (url.hostname !== "github.com" || !url.pathname.startsWith(prefix)) {
      return null;
    }
    return decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

function stripRefreshFailureNote(value: unknown): string {
  return String(value || "")
    .replace(
      /\s*Source refresh failed; preserved pending a successful refresh\./g,
      "",
    )
    .trim();
}

function displayNameForNetuid(netuid: number): string {
  const nativeSubnet = nativeByNetuid.get(netuid);
  // nativeDisplayName's fallback param is inferred as `null | undefined` from
  // its untyped scripts/lib/formatting.mjs default value (`= null`), not
  // `string` -- cast until Phase 4 batch 7 converts that file.
  return (
    nativeDisplayName as (subnet: Row | undefined, fallback?: string) => string
  )(nativeSubnet, overlayNameByNetuid.get(netuid) || `Subnet ${netuid}`);
}

function githubSurfaceKind(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    if (
      url.hostname === "github.com" &&
      /^\/orgs\/[^/]+\/repositories\/?$/i.test(url.pathname)
    ) {
      return "repo-registry";
    }
  } catch {
    return "source-repo";
  }
  return "source-repo";
}

function addCandidate(candidate: Row): void {
  const normalizedUrl = normalizeCandidateUrl(candidate.url);
  if (!normalizedUrl) {
    return;
  }

  const key = `${candidate.netuid}:${candidate.kind}:${normalizedUrl.toLowerCase()}`;
  // A committed community candidate already pins this locator — re-emitting it as
  // a generated candidate breaks the publish's candidate-locator uniqueness check
  // (#1026 follow-up). Skip; the committed candidate stands.
  if (reservedCandidateLocators.has(key)) {
    return;
  }
  const sourceUrl = normalizeCandidateUrl(candidate.source_url);
  if (!sourceUrl) {
    return;
  }

  const sourceUrls = [sourceUrl];
  const existing = candidatesByKey.get(key);
  if (existing) {
    existing.source_urls = [
      ...new Set([
        ...((existing.source_urls as string[]) || [existing.source_url]),
        ...sourceUrls,
      ]),
    ].sort();
    return;
  }

  const stableId = uniqueCandidateId(candidate.id as string, normalizedUrl);
  candidateIds.add(stableId);
  candidatesByKey.set(key, {
    schema_version: 1,
    state: "schema-valid",
    auth_required: false,
    public_safe: true,
    rate_limit_notes:
      "Candidate only; no recurring probe is configured until maintainer review.",
    ...candidate,
    id: stableId,
    url: normalizedUrl,
    source_url: sourceUrl,
    source_urls: sourceUrls,
  });
}

function uniqueCandidateId(id: string, url: string): string {
  if (!candidateIds.has(id)) {
    return id;
  }
  const suffix = hashString(url).slice(0, 8);
  const suffixed = `${id}-${suffix}`;
  if (!candidateIds.has(suffixed)) {
    return suffixed;
  }
  let index = 2;
  while (candidateIds.has(`${suffixed}-${index}`)) {
    index += 1;
  }
  return `${suffixed}-${index}`;
}

function hashString(value: string): string {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function extractUrls(value: unknown): string[] {
  const values = arrayFrom(value).flatMap((item) => {
    if (typeof item !== "string") {
      return [];
    }
    const trimmed = item.trim();
    const explicitUrls = trimmed.match(/https?:\/\/[^\s,"'`)\]]+/g) || [];
    return explicitUrls.length > 0 ? explicitUrls : [trimmed];
  });

  return [
    ...new Set(
      values
        .map(normalizeCandidateUrl)
        .filter((url): url is string => Boolean(url)),
    ),
  ];
}

// Canonical URL normalization lives in scripts/lib.mjs (normalizePublicUrl) and
// is shared with the contributor-facing path (validate-surface.mjs /
// surface-add.mjs) so protocol/credential/SSRF/impersonation handling can never
// diverge by call site (#5991). Discovery layers on one extra rejection: the
// placeholder/template identity URLs (example.com, github.com/username/repo,
// deprecated + "your*" README stubs) that clear those guards but must never
// enter the candidate bundle. isPlaceholderIdentityUrl now carries the union of
// both former placeholder lists, so this is a thin compose, not a reimpl.
function normalizeCandidateUrl(value: unknown): string | null {
  const normalized = normalizePublicUrl(value);
  return normalized && !isPlaceholderIdentityUrl(normalized)
    ? normalized
    : null;
}

function cleanName(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const name = value.trim();
  if (!name || /^deprecated$/i.test(name)) {
    return "";
  }
  return name;
}

function arrayFrom(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return [value];
}

function surfaceKindForWebsiteLabel(label: unknown): string | null {
  const normalized = String(label || "").toLowerCase();
  if (["twitter", "x", "discord", "telegram"].includes(normalized)) {
    return null;
  }
  if (normalized.includes("github")) {
    return "source-repo";
  }
  if (
    normalized.includes("dashboard") ||
    normalized.includes("leaderboard") ||
    normalized.includes("logger") ||
    normalized.includes("market analysis")
  ) {
    return "dashboard";
  }
  if (
    normalized.includes("docs") ||
    normalized.includes("whitepaper") ||
    normalized.includes("roadmap") ||
    normalized.includes("blog") ||
    normalized.includes("substack")
  ) {
    return "docs";
  }
  if (normalized.includes("huggingface")) {
    return "data-artifact";
  }
  return "website";
}

function parseGithubRepo(
  value: string,
): { owner: string; repo: string } | null {
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") {
      return null;
    }
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    if (!owner || !repo) {
      return null;
    }
    return { owner, repo: repo.replace(/\.git$/, "") };
  } catch {
    return null;
  }
}

async function fetchGithubReadme(repo: {
  owner: string;
  repo: string;
}): Promise<{ text: string; url: string; htmlUrl: string } | null> {
  const branches = ["main", "master"];
  const names = ["README.md", "readme.md"];
  for (const branch of branches) {
    for (const name of names) {
      const rawUrl = `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${branch}/${name}`;
      const response = await fetchText(rawUrl, {
        accept: "text/markdown,text/plain",
        warn: false,
      });
      if (response?.status_code === 200 && response.text) {
        return {
          text: response.text.slice(0, 120000),
          url: rawUrl,
          htmlUrl: `https://github.com/${repo.owner}/${repo.repo}/blob/${branch}/${name}`,
        };
      }
    }
  }
  return null;
}

function extractMarkdownLinks(markdown: string, baseUrl: string): Row[] {
  const links: Row[] = [];
  const markdownLinkPattern = /\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/g;
  const bareUrlPattern = /https?:\/\/[^\s<>)"'`\]]+/g;
  for (const match of markdown.matchAll(markdownLinkPattern)) {
    links.push({ label: match[1], url: normalizeCandidateUrl(match[2]) });
  }
  for (const match of markdown.matchAll(bareUrlPattern)) {
    links.push({ label: "", url: normalizeCandidateUrl(match[0]) });
  }
  return dedupeLinks(
    links.filter((link) => link.url),
    baseUrl,
  );
}

function extractHtmlLinks(html: string, baseUrl: string): Row[] {
  const links: Row[] = [];
  const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis;
  for (const match of html.matchAll(anchorPattern)) {
    links.push({
      label: stripHtml(match[2]).slice(0, 120),
      url: normalizeLinkedUrl(match[1], baseUrl),
    });
  }
  return dedupeLinks(
    links.filter((link) => link.url),
    baseUrl,
  );
}

function normalizeLinkedUrl(value: unknown, baseUrl: string): string | null {
  if (
    typeof value !== "string" ||
    value.startsWith("#") ||
    value.startsWith("mailto:")
  ) {
    return null;
  }
  try {
    return normalizeCandidateUrl(new URL(value, baseUrl).toString());
  } catch {
    return null;
  }
}

function dedupeLinks(links: Row[], baseUrl: string): Row[] {
  const seen = new Set([normalizeCandidateUrl(baseUrl)]);
  const result: Row[] = [];
  for (const link of links) {
    const url = link.url as string | null;
    if (!url || seen.has(url) || isSocialUrl(url)) {
      continue;
    }
    seen.add(url);
    result.push(link);
  }
  return result;
}

function classifyDiscoveredLink(
  url: string,
  label: unknown,
  baseUrl: string,
): { kind: string; label: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const haystack =
    `${label || ""} ${parsed.hostname} ${parsed.pathname}`.toLowerCase();
  if (
    isSocialUrl(url) ||
    isBadgeOrAssetUrl(url) ||
    isGenericHost(parsed.hostname) ||
    haystack.includes("/issues") ||
    haystack.includes("/pulls")
  ) {
    return null;
  }

  if (haystack.includes("openapi") || haystack.includes("swagger")) {
    return { kind: "openapi", label: "OpenAPI surface" };
  }
  // #1008: code-examples — quickstarts, example dirs, SDK snippets, notebooks.
  // Checked ahead of the generic api/docs heuristics so an `/examples/` path or a
  // "quickstart" link is indexed as an example, not mis-bucketed as a docs/API
  // surface. Shared predicate (isLikelyExampleLink) so the test pins the logic.
  if (isLikelyExampleLink(haystack)) {
    return { kind: "example", label: "code example" };
  }
  if (
    haystack.includes("leaderboard") ||
    haystack.includes("dashboard") ||
    haystack.includes("stats")
  ) {
    return { kind: "dashboard", label: "dashboard" };
  }
  if (haystack.includes("api") || haystack.includes("health")) {
    return { kind: "subnet-api", label: "API surface" };
  }
  if (
    haystack.includes("docs") ||
    haystack.includes("documentation") ||
    haystack.includes("whitepaper") ||
    haystack.includes("guide") ||
    haystack.includes("paper")
  ) {
    return { kind: "docs", label: "docs" };
  }
  if (
    haystack.includes("huggingface.co") ||
    haystack.includes("dataset") ||
    haystack.includes("model")
  ) {
    return { kind: "data-artifact", label: "data artifact" };
  }
  if (isLikelyProjectDomain(baseUrl, url)) {
    return { kind: "website", label: "website page" };
  }
  return null;
}

function isGenericHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "");
  return [
    "github.com",
    "raw.githubusercontent.com",
    "gist.github.com",
    "gitlab.com",
    "bitbucket.org",
    "readthedocs.io",
    "subnetradar.com",
    "taomarketcap.com",
    "taostats.io",
    "docs.google.com",
  ].some(
    (genericHost) => host === genericHost || host.endsWith(`.${genericHost}`),
  );
}

function isBadgeOrAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = url.pathname.toLowerCase();
    return (
      host === "img.shields.io" ||
      host === "shields.io" ||
      host === "badgen.net" ||
      /\.(svg|png|jpg|jpeg|gif|webp|ico|pdf)$/.test(pathname)
    );
  } catch {
    return true;
  }
}

function isSocialUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^www\./, "");
    return [
      "x.com",
      "twitter.com",
      "discord.com",
      "discord.gg",
      "t.me",
      "telegram.me",
      "linkedin.com",
      "youtube.com",
      "youtu.be",
    ].some(
      (socialHost) => host === socialHost || host.endsWith(`.${socialHost}`),
    );
  } catch {
    return false;
  }
}

function stripHtml(value: unknown): string {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(
  url: string,
  headers: Record<string, string> = {},
  options: { warn?: boolean } = {},
): Promise<Row | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetchWithSafeRedirects(url, {
      headers: {
        accept: "application/json",
        "user-agent": "metagraphed-candidate-discovery/0.0",
        ...headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      if (options.warn !== false) {
        warnings.push(`${url}: HTTP ${response.status}`);
      }
      return null;
    }
    return await response.json();
  } catch (error) {
    if (options.warn !== false) {
      warnings.push(`${url}: ${(error as Error).message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(
  url: string,
  options: {
    accept?: string;
    maxBytes?: number;
    warn?: boolean;
    timeoutMs?: number;
  } = {},
): Promise<{ status_code: number; text: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs || 10000,
  );
  try {
    const response = await fetchWithSafeRedirects(url, {
      headers: {
        accept: options.accept || "*/*",
        "user-agent": "metagraphed-candidate-discovery/0.0",
      },
      signal: controller.signal,
    });
    if (!response.ok && options.warn !== false) {
      warnings.push(`${url}: HTTP ${response.status}`);
    }
    const text = response.ok
      ? await readResponseText(response, options.maxBytes)
      : "";
    return {
      status_code: response.status,
      text,
    };
  } catch (error) {
    if (options.warn !== false) {
      warnings.push(`${url}: ${(error as Error).message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseText(
  response: Response,
  maxBytes: number | undefined,
): Promise<string> {
  if (!Number.isFinite(maxBytes) || (maxBytes as number) <= 0) {
    return await response.text();
  }
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (bytesRead < (maxBytes as number)) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }

      const remainingBytes = (maxBytes as number) - bytesRead;
      const chunk =
        value.byteLength > remainingBytes
          ? value.slice(0, remainingBytes)
          : value;
      bytesRead += chunk.byteLength;
      text += decoder.decode(chunk, {
        stream: bytesRead < (maxBytes as number),
      });

      if (value.byteLength > remainingBytes) {
        return text + decoder.decode();
      }
    }

    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function fetchWithSafeRedirects(
  url: string,
  init: RequestInit,
  redirectCount = 0,
): Promise<Response> {
  if (await isUnsafeResolvedUrl(url)) {
    throw new Error("unsafe URL");
  }

  const response = await fetch(url, {
    ...init,
    redirect: "manual",
  });
  const location = response.headers.get("location");
  if (
    [301, 302, 303, 307, 308].includes(response.status) &&
    location &&
    redirectCount < 5
  ) {
    const redirectTarget = new URL(location, url).toString();
    if (await isUnsafeResolvedUrl(redirectTarget)) {
      await response.body?.cancel();
      throw new Error("redirect target is unsafe");
    }
    await response.body?.cancel();
    const nextInit =
      response.status === 303 && init.method && init.method !== "GET"
        ? { ...init, method: "GET" }
        : init;
    return fetchWithSafeRedirects(redirectTarget, nextInit, redirectCount + 1);
  }

  return response;
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift() as T;
        await mapper(item);
      }
    },
  );
  await Promise.all(workers);
}

function countBy(items: Row[], key: string): Record<string, number> {
  return Object.fromEntries(
    Object.entries(
      items.reduce(
        (accumulator: Record<string, number>, item) => {
          const value = item[key] as string;
          accumulator[value] = (accumulator[value] || 0) + 1;
          return accumulator;
        },
        {} as Record<string, number>,
      ),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}

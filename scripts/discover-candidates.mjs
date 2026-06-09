import path from "node:path";
import {
  buildTimestamp,
  isUnsafeResolvedUrl,
  loadNativeSnapshot,
  loadProviders,
  loadSubnets,
  nativeDisplayName,
  readJson,
  README_KIND_LIMITS,
  README_LINK_LIMIT,
  repoRoot,
  selectReviewableReadmeLinks,
  slugify,
  stableStringify,
  writeJson,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const nativeSnapshot = await loadNativeSnapshot();
const existingOverlays = await loadSubnets();
const providers = await loadProviders();
const providerIds = new Set(providers.map((provider) => provider.id));
const observedAt =
  process.env.METAGRAPH_PERSIST_DISCOVERY_OBSERVED_AT === "1"
    ? process.env.METAGRAPH_DISCOVERY_OBSERVED_AT || new Date().toISOString()
    : null;
const nativeByNetuid = new Map(
  nativeSnapshot.subnets.map((subnet) => [subnet.netuid, subnet]),
);
const overlayNameByNetuid = new Map(
  existingOverlays
    .filter((overlay) => overlay.name)
    .map((overlay) => [overlay.netuid, overlay.name]),
);
const overlayProviderByNetuid = new Map(
  existingOverlays.map((overlay) => [
    overlay.netuid,
    selectOverlayProvider(overlay),
  ]),
);
const netuidsWithProjectDocs = new Set(
  existingOverlays
    .filter((overlay) =>
      (overlay.surfaces || []).some(
        (surface) =>
          surface.kind === "docs" && !isCommunityDocsProvider(surface.provider),
      ),
    )
    .map((overlay) => overlay.netuid),
);
const candidatesByKey = new Map();
const candidateIds = new Set();
const warnings = [];
const existingGeneratedCandidates = await loadExistingGeneratedCandidates();
const restoredProviders = new Set();
const TAOPEDIA_ARTICLE_PROBE_MAX_BYTES = 64 * 1024;

await discoverFromNativeChainIdentity();
await discoverFromTaoMarketCap();
await discoverFromTensorplexSubnetDocs();
await discoverFromTaopediaArticles();
await discoverUniversalTaoMarketCapDashboards();
await discoverUniversalBackpropFinanceDashboards();
await discoverUniversalTaostatsMetagraphDashboards();
await discoverUniversalSubnetRadarDashboards();
if (restoredProviders.size === 0) {
  await discoverFromGithubReadmes();
  await discoverFromProjectWebsites();
} else {
  restoreExistingCandidatesForSourceTypes([
    "github-readme-link",
    "project-website-common-path",
    "project-website-link",
  ]);
}

const candidates = [...candidatesByKey.values()].sort(
  (a, b) =>
    a.netuid - b.netuid ||
    a.kind.localeCompare(b.kind) ||
    a.id.localeCompare(b.id),
);

const summary = {
  mode: dryRun ? "dry-run" : "write",
  native_subnet_count: nativeSnapshot.subnets.length,
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
  await writeJson(
    path.join(repoRoot, "registry/candidates/generated/public-sources.json"),
    {
      schema_version: 1,
      generated_by: "metagraphed-discover-candidates",
      generated_at: buildTimestamp(),
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
    },
  );
}

console.log(stableStringify(summary));

async function discoverFromNativeChainIdentity() {
  const sourceUrl =
    "https://docs.learnbittensor.org/python-api/html/_modules/bittensor/core/chain_data/subnet_identity.html";

  for (const subnet of nativeSnapshot.subnets) {
    const identity = subnet.chain_identity;
    if (!identity || typeof identity !== "object") {
      continue;
    }

    const displayName =
      cleanName(identity.subnet_name) || displayNameForNetuid(subnet.netuid);
    const provider = providerForNativeIdentity(subnet.netuid);

    for (const url of extractUrls(identity.subnet_url)) {
      addCandidate({
        id: `sn-${subnet.netuid}-native-chain-website`,
        netuid: subnet.netuid,
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
        id: `sn-${subnet.netuid}-native-chain-github`,
        netuid: subnet.netuid,
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

function selectOverlayProvider(overlay) {
  const ignoredProviders = new Set([
    "backprop-finance",
    "opentensor",
    "subnetradar",
    "taomarketcap",
    "taopedia-articles",
    "taostats",
    "tensorplex-subnet-docs",
  ]);
  for (const surface of overlay.surfaces || []) {
    if (
      surface.provider &&
      providerIds.has(surface.provider) &&
      !ignoredProviders.has(surface.provider)
    ) {
      return surface.provider;
    }
  }
  if (overlay.slug && providerIds.has(overlay.slug)) {
    return overlay.slug;
  }
  return "opentensor";
}

function providerForNativeIdentity(netuid) {
  return overlayProviderByNetuid.get(netuid) || "opentensor";
}

async function discoverFromTaoMarketCap() {
  const limit = 100;
  let offset = 0;
  let expectedCount = null;

  while (expectedCount === null || offset < expectedCount) {
    const pageUrl = `https://api.taomarketcap.com/public/v1/subnets/?limit=${limit}&offset=${offset}`;
    const page = await fetchJson(pageUrl);
    if (!page) {
      if (offset === 0) {
        restoreExistingCandidatesForProvider("taomarketcap");
      }
      return;
    }

    expectedCount = Number.isInteger(page.count)
      ? page.count
      : offset + (page.results || []).length;
    for (const subnet of page.results || []) {
      const netuid = Number(subnet.netuid);
      if (!nativeByNetuid.has(netuid) || subnet.is_active === false) {
        continue;
      }

      const identity = subnet.latest_snapshot?.subnet_identities_v3;
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
  }
}

async function discoverFromTensorplexSubnetDocs() {
  let discoveredCount = 0;

  await mapLimit(
    nativeSnapshot.subnets.map((subnet) => subnet.netuid).sort((a, b) => a - b),
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
        const kind = surfaceKindForWebsiteLabel(website?.label);
        if (!kind) {
          continue;
        }
        for (const url of extractUrls(website?.url)) {
          const label = slugify(website?.label || "website") || "website";
          addCandidate({
            id: `sn-${netuid}-tensorplex-${label}-${index + 1}`,
            netuid,
            name: `${displayName} ${website?.label || "website"}`,
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

async function discoverFromTaopediaArticles() {
  let discoveredCount = 0;
  const existingTaopediaByNetuid = new Map(
    existingGeneratedCandidates
      .filter((candidate) => candidate.provider === "taopedia-articles")
      .map((candidate) => [candidate.netuid, candidate]),
  );
  await mapLimit(
    nativeSnapshot.subnets
      .map((subnet) => subnet.netuid)
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

async function fetchTaopediaArticlePath(pathValue) {
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

async function discoverUniversalTaoMarketCapDashboards() {
  for (const subnet of nativeSnapshot.subnets) {
    addCandidate({
      id: `sn-${subnet.netuid}-taomarketcap-dashboard`,
      netuid: subnet.netuid,
      name: `${displayNameForNetuid(subnet.netuid)} TaoMarketCap dashboard`,
      kind: "dashboard",
      url: `https://taomarketcap.com/subnets/${subnet.netuid}`,
      source_url: `https://api.taomarketcap.com/public/v1/subnets/${subnet.netuid}/`,
      source_type: "taomarketcap-dashboard",
      source_tier: "third-party-index",
      confidence: "medium",
      provider: "taomarketcap",
      review_notes:
        "Universal TaoMarketCap subnet dashboard candidate. Third-party enrichment, not protocol authority.",
    });
  }
}

async function discoverUniversalBackpropFinanceDashboards() {
  for (const subnet of nativeSnapshot.subnets) {
    const displayName = displayNameForNetuid(subnet.netuid);
    const subnetSlug = slugify(displayName) || `subnet-${subnet.netuid}`;
    const url = `https://backprop.finance/dtao/subnets/${subnet.netuid}-${subnetSlug}`;
    addCandidate({
      id: `sn-${subnet.netuid}-backprop-dashboard`,
      netuid: subnet.netuid,
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

async function discoverUniversalTaostatsMetagraphDashboards() {
  for (const subnet of nativeSnapshot.subnets) {
    const displayName = displayNameForNetuid(subnet.netuid);
    const url = `https://taostats.io/subnets/${subnet.netuid}/metagraph`;
    addCandidate({
      id: `sn-${subnet.netuid}-taostats-metagraph`,
      netuid: subnet.netuid,
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

async function discoverUniversalSubnetRadarDashboards() {
  for (const subnet of nativeSnapshot.subnets) {
    const displayName = displayNameForNetuid(subnet.netuid);
    const url = `https://subnetradar.com/subnet/${subnet.netuid}`;
    addCandidate({
      id: `sn-${subnet.netuid}-subnetradar-dashboard`,
      netuid: subnet.netuid,
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

async function discoverFromGithubReadmes() {
  const sourceRepoCandidates = [...candidatesByKey.values()].filter(
    (candidate) =>
      candidate.kind === "source-repo" && parseGithubRepo(candidate.url),
  );
  const byRepo = new Map();

  for (const candidate of sourceRepoCandidates) {
    const repo = parseGithubRepo(candidate.url);
    const key = `${repo.owner}/${repo.repo}`.toLowerCase();
    if (!byRepo.has(key)) {
      byRepo.set(key, { repo, candidates: [] });
    }
    byRepo.get(key).candidates.push(candidate);
  }

  await mapLimit([...byRepo.values()], 8, async ({ repo, candidates }) => {
    const readme = await fetchGithubReadme(repo);
    if (!readme) {
      return;
    }

    for (const candidate of candidates) {
      const repoSlug = slugify(`${repo.owner}-${repo.repo}`);
      const links = selectReviewableReadmeLinks(
        extractMarkdownLinks(readme.text, readme.url)
          .map((link) => ({
            ...link,
            classification: classifyDiscoveredLink(
              link.url,
              link.label,
              candidate.url,
            ),
          }))
          .filter((link) => link.classification),
        { netuid: candidate.netuid, repo },
      );

      for (const [index, link] of links.entries()) {
        addCandidate({
          id: `sn-${candidate.netuid}-github-readme-${repoSlug}-${link.classification.kind}-${index + 1}`,
          netuid: candidate.netuid,
          name: `${displayNameForNetuid(candidate.netuid)} ${link.classification.label}`,
          kind: link.classification.kind,
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

async function discoverFromProjectWebsites() {
  const websiteCandidates = [...candidatesByKey.values()].filter(
    (candidate) => candidate.kind === "website",
  );
  await mapLimit(websiteCandidates, 8, async (candidate) => {
    const root = normalizePublicUrl(candidate.url);
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
      .map((link) => ({
        ...link,
        classification: classifyDiscoveredLink(link.url, link.label, root),
      }))
      .filter((link) => link.classification)
      .slice(0, 10);

    for (const [index, link] of links.entries()) {
      addCandidate({
        id: `sn-${candidate.netuid}-website-link-${websiteSlug}-${link.classification.kind}-${index + 1}`,
        netuid: candidate.netuid,
        name: `${displayNameForNetuid(candidate.netuid)} ${link.classification.label}`,
        kind: link.classification.kind,
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

async function addDocsSubdomainCandidate(candidate, root) {
  if (netuidsWithProjectDocs.has(candidate.netuid)) {
    return;
  }

  let docsUrl;
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
    id: `sn-${candidate.netuid}-website-subdomain-docs-${slugify(new URL(docsUrl).hostname)}`,
    netuid: candidate.netuid,
    name: `${displayNameForNetuid(candidate.netuid)} docs subdomain`,
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

function addCommonApiPathCandidates(candidate, root) {
  let origin;
  try {
    const parsed = new URL(root);
    if (isGenericHost(parsed.hostname)) {
      return;
    }
    origin = parsed.origin;
  } catch {
    return;
  }

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
      id: `sn-${candidate.netuid}-website-common-${slugify(commonPath.path)}`,
      netuid: candidate.netuid,
      name: `${displayNameForNetuid(candidate.netuid)} ${commonPath.label}`,
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

function isCommunityDocsProvider(provider) {
  return ["taopedia-articles", "tensorplex-subnet-docs"].includes(provider);
}

async function loadExistingGeneratedCandidates() {
  const candidates = [];
  try {
    const existing = await readJson(
      path.join(repoRoot, "registry/candidates/generated/public-sources.json"),
    );
    if (Array.isArray(existing.candidates)) {
      candidates.push(...existing.candidates);
    }
  } catch {
    // Continue to the public artifact fallback below.
  }

  try {
    const publicArtifact = await readJson(
      path.join(repoRoot, "public/metagraph/candidates.json"),
    );
    if (Array.isArray(publicArtifact.candidates)) {
      candidates.push(...publicArtifact.candidates);
    }
  } catch {
    // No built candidate artifact exists yet.
  }

  const byKey = new Map();
  for (const candidate of candidates) {
    const key = `${candidate.id}:${candidate.url}`;
    if (!byKey.has(key)) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()];
}

function restoreExistingCandidatesForProvider(provider) {
  restoredProviders.add(provider);
  for (const candidate of existingGeneratedCandidates.filter(
    (entry) => entry.provider === provider,
  )) {
    restoreCandidate(candidate);
  }
}

function restoreExistingCandidatesForSourceTypes(sourceTypes) {
  const sourceTypeSet = new Set(sourceTypes);
  for (const candidate of existingGeneratedCandidates.filter((entry) =>
    sourceTypeSet.has(entry.source_type),
  )) {
    restoreCandidate(candidate);
  }
}

function restoreCandidate(candidate) {
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

function githubBlobPath(urlValue) {
  if (!urlValue) {
    return null;
  }
  try {
    const url = new URL(urlValue);
    const prefix = "/e35ventura/taopedia-articles/blob/main/";
    if (url.hostname !== "github.com" || !url.pathname.startsWith(prefix)) {
      return null;
    }
    return decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return null;
  }
}

function stripRefreshFailureNote(value) {
  return String(value || "")
    .replace(
      /\s*Source refresh failed; preserved pending a successful refresh\./g,
      "",
    )
    .trim();
}

function displayNameForNetuid(netuid) {
  const nativeSubnet = nativeByNetuid.get(netuid);
  return nativeDisplayName(
    nativeSubnet,
    overlayNameByNetuid.get(netuid) || `Subnet ${netuid}`,
  );
}

function githubSurfaceKind(urlValue) {
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

function addCandidate(candidate) {
  const normalizedUrl = normalizePublicUrl(candidate.url);
  if (!normalizedUrl) {
    return;
  }

  const key = `${candidate.netuid}:${candidate.kind}:${normalizedUrl.toLowerCase()}`;
  const sourceUrl = normalizePublicUrl(candidate.source_url);
  if (!sourceUrl) {
    return;
  }

  const sourceUrls = [sourceUrl];
  const existing = candidatesByKey.get(key);
  if (existing) {
    existing.source_urls = [
      ...new Set([
        ...(existing.source_urls || [existing.source_url]),
        ...sourceUrls,
      ]),
    ].sort();
    return;
  }

  const stableId = uniqueCandidateId(candidate.id, normalizedUrl);
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

function uniqueCandidateId(id, url) {
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

function hashString(value) {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}

function extractUrls(value) {
  const values = arrayFrom(value).flatMap((item) => {
    if (typeof item !== "string") {
      return [];
    }
    const trimmed = item.trim();
    const explicitUrls = trimmed.match(/https?:\/\/[^\s,"'`)\]]+/g) || [];
    return explicitUrls.length > 0 ? explicitUrls : [trimmed];
  });

  return [...new Set(values.map(normalizePublicUrl).filter(Boolean))];
}

function normalizePublicUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  let candidate = value
    .trim()
    .replace(/^[<`"']+|[>`"',.;:!]+$/g, "")
    .split("](")[0]
    .replace(/[\]`"',.;:!]+$/g, "");
  if (!candidate || isPlaceholder(candidate)) {
    return null;
  }

  if (
    !/^https?:\/\//i.test(candidate) &&
    /^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(candidate)
  ) {
    candidate = `https://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }
    if (isUnsafeHost(url.hostname)) {
      return null;
    }
    url.hash = "";
    if (url.pathname !== "/") {
      url.pathname = url.pathname.replace(/\/+$/, "");
    }
    return url.toString();
  } catch {
    return null;
  }
}

function isPlaceholder(value) {
  const normalized = value.toLowerCase();
  return [
    "example.com",
    "github.com/deprecated/deprecated",
    "github.com/username/repo",
    "github.com/yourusername/yourrepo",
    "yourwebsite",
    "your-org",
    "deprecated.com",
    "deprecated.png",
    "localhost",
    "127.0.0.1",
  ].some((placeholder) => normalized.includes(placeholder));
}

function cleanName(value) {
  if (typeof value !== "string") {
    return "";
  }
  const name = value.trim();
  if (!name || /^deprecated$/i.test(name)) {
    return "";
  }
  return name;
}

function arrayFrom(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return [value];
}

function surfaceKindForWebsiteLabel(label) {
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

function parseGithubRepo(value) {
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

async function fetchGithubReadme(repo) {
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

function extractMarkdownLinks(markdown, baseUrl) {
  const links = [];
  const markdownLinkPattern = /\[([^\]]{1,120})\]\((https?:\/\/[^)\s]+)\)/g;
  const bareUrlPattern = /https?:\/\/[^\s<>)"'`\]]+/g;
  for (const match of markdown.matchAll(markdownLinkPattern)) {
    links.push({ label: match[1], url: normalizePublicUrl(match[2]) });
  }
  for (const match of markdown.matchAll(bareUrlPattern)) {
    links.push({ label: "", url: normalizePublicUrl(match[0]) });
  }
  return dedupeLinks(
    links.filter((link) => link.url),
    baseUrl,
  );
}

function extractHtmlLinks(html, baseUrl) {
  const links = [];
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

function normalizeLinkedUrl(value, baseUrl) {
  if (
    typeof value !== "string" ||
    value.startsWith("#") ||
    value.startsWith("mailto:")
  ) {
    return null;
  }
  try {
    return normalizePublicUrl(new URL(value, baseUrl).toString());
  } catch {
    return null;
  }
}

function dedupeLinks(links, baseUrl) {
  const seen = new Set([normalizePublicUrl(baseUrl)]);
  const result = [];
  for (const link of links) {
    if (!link.url || seen.has(link.url) || isSocialUrl(link.url)) {
      continue;
    }
    seen.add(link.url);
    result.push(link);
  }
  return result;
}

function classifyDiscoveredLink(url, label, baseUrl) {
  let parsed;
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

function isLikelyProjectDomain(baseUrl, candidateUrl) {
  try {
    const base = new URL(baseUrl);
    const candidate = new URL(candidateUrl);
    return (
      candidate.hostname === base.hostname ||
      registrableDomain(candidate.hostname) === registrableDomain(base.hostname)
    );
  } catch {
    return false;
  }
}

function registrableDomain(hostname) {
  const parts = hostname.toLowerCase().split(".").filter(Boolean);
  return parts.slice(-2).join(".");
}

function isGenericHost(hostname) {
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

function isBadgeOrAssetUrl(value) {
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

function isUnsafeHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
  );
}

function isSocialUrl(value) {
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

function stripHtml(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(url, headers = {}, options = {}) {
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
      warnings.push(`${url}: ${error.message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, options = {}) {
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
      warnings.push(`${url}: ${error.message}`);
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readResponseText(response, maxBytes) {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
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
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) {
        return text + decoder.decode();
      }

      const remainingBytes = maxBytes - bytesRead;
      const chunk =
        value.byteLength > remainingBytes
          ? value.slice(0, remainingBytes)
          : value;
      bytesRead += chunk.byteLength;
      text += decoder.decode(chunk, { stream: bytesRead < maxBytes });

      if (value.byteLength > remainingBytes) {
        return text + decoder.decode();
      }
    }

    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function fetchWithSafeRedirects(url, init, redirectCount = 0) {
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

async function mapLimit(items, limit, mapper) {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        await mapper(item);
      }
    },
  );
  await Promise.all(workers);
}

function countBy(items, key) {
  return Object.fromEntries(
    Object.entries(
      items.reduce((accumulator, item) => {
        accumulator[item[key]] = (accumulator[item[key]] || 0) + 1;
        return accumulator;
      }, {}),
    ).sort(([a], [b]) => a.localeCompare(b)),
  );
}

import path from "node:path";
import {
  buildTimestamp,
  loadNativeSnapshot,
  repoRoot,
  slugify,
  stableStringify,
  writeJson
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const nativeSnapshot = await loadNativeSnapshot();
const nativeByNetuid = new Map(nativeSnapshot.subnets.map((subnet) => [subnet.netuid, subnet]));
const candidatesByKey = new Map();
const warnings = [];

await discoverFromTaoMarketCap();
await discoverFromTensorplexSubnetDocs();
await discoverFromTaopediaArticles();

const candidates = [...candidatesByKey.values()].sort(
  (a, b) => a.netuid - b.netuid || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
);

const summary = {
  mode: dryRun ? "dry-run" : "write",
  native_subnet_count: nativeSnapshot.subnets.length,
  generated_candidate_count: candidates.length,
  candidate_subnet_count: new Set(candidates.map((candidate) => candidate.netuid)).size,
  by_provider: countBy(candidates, "provider"),
  by_kind: countBy(candidates, "kind"),
  warnings
};

if (!dryRun) {
  await writeJson(path.join(repoRoot, "registry/candidates/generated/public-sources.json"), {
    schema_version: 1,
    generated_by: "metagraphed-discover-candidates",
    generated_at: buildTimestamp(),
    native_snapshot_captured_at: nativeSnapshot.captured_at,
    notes:
      "Generated candidate surfaces from public sources. These are not verified registry surfaces until maintainer review promotes them into registry/subnets.",
    sources: [
      {
        id: "taomarketcap",
        url: "https://api.taomarketcap.com/public/v1/subnets/"
      },
      {
        id: "tensorplex-subnet-docs",
        url: "https://github.com/tensorplex-labs/subnet-docs"
      },
      {
        id: "taopedia-articles",
        url: "https://github.com/e35ventura/taopedia-articles"
      }
    ],
    candidates
  });
}

console.log(stableStringify(summary));

async function discoverFromTaoMarketCap() {
  const limit = 100;
  let offset = 0;
  let expectedCount = null;

  while (expectedCount === null || offset < expectedCount) {
    const pageUrl = `https://api.taomarketcap.com/public/v1/subnets/?limit=${limit}&offset=${offset}`;
    const page = await fetchJson(pageUrl);
    if (!page) {
      return;
    }

    expectedCount = Number.isInteger(page.count) ? page.count : offset + (page.results || []).length;
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
      const displayName = cleanName(identity.subnetName) || nativeByNetuid.get(netuid).name;

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
          review_notes: "Discovered from TaoMarketCap subnet identity metadata. Not probed or verified by Metagraphed."
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
          review_notes: "Discovered from TaoMarketCap subnet identity metadata. Not probed or verified by Metagraphed."
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
  const dataRootUrl = "https://api.github.com/repos/tensorplex-labs/subnet-docs/contents/data?ref=main";
  const entries = await fetchJson(dataRootUrl, githubHeaders());
  if (!Array.isArray(entries)) {
    warnings.push("tensorplex-subnet-docs: failed to list data directories");
    return;
  }

  const availableNetuids = new Set(
    entries
      .filter((entry) => entry.type === "dir" && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((netuid) => nativeByNetuid.has(netuid))
  );

  await mapLimit([...availableNetuids].sort((a, b) => a - b), 8, async (netuid) => {
    const rawUrl = `https://raw.githubusercontent.com/tensorplex-labs/subnet-docs/main/data/${netuid}/subnet.json`;
    const repoUrl = `https://github.com/tensorplex-labs/subnet-docs/blob/main/data/${netuid}/subnet.json`;
    const directoryUrl = `https://github.com/tensorplex-labs/subnet-docs/tree/main/data/${netuid}`;
    const document = await fetchJson(rawUrl);
    if (!document) {
      return;
    }

    const nativeName = nativeByNetuid.get(netuid).name;
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
      review_notes: "Discovered from Tensorplex subnet-docs. Useful as documentation enrichment, not verified operational authority."
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
          review_notes: "Discovered from Tensorplex subnet-docs. Not probed or verified by Metagraphed."
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
        review_notes: "Discovered from Tensorplex subnet-docs hardware requirements metadata."
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
          review_notes: "Discovered from Tensorplex subnet-docs website metadata. Not probed or verified by Metagraphed."
        });
      }
    }
  });
}

async function discoverFromTaopediaArticles() {
  const treeUrl = "https://api.github.com/repos/e35ventura/taopedia-articles/git/trees/main?recursive=1";
  const tree = await fetchJson(treeUrl, githubHeaders());
  if (!Array.isArray(tree?.tree)) {
    warnings.push("taopedia-articles: failed to list repository tree");
    return;
  }

  for (const entry of tree.tree) {
    const match = /^content\/pages\/subnet_(\d+)[^/]*\/index\.mdx$/.exec(entry.path || "");
    if (!match) {
      continue;
    }

    const netuid = Number(match[1]);
    if (!nativeByNetuid.has(netuid)) {
      continue;
    }

    const url = `https://github.com/e35ventura/taopedia-articles/blob/main/${entry.path}`;
    addCandidate({
      id: `sn-${netuid}-taopedia-article`,
      netuid,
      name: `${nativeByNetuid.get(netuid).name} Taopedia article`,
      kind: "docs",
      url,
      source_url: url,
      source_type: "taopedia-article",
      source_tier: "community-docs",
      confidence: "low",
      provider: "taopedia-articles",
      review_notes: "Discovered from the public Taopedia article repository. Not verified as an operational interface."
    });
  }
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
    existing.source_urls = [...new Set([...(existing.source_urls || [existing.source_url]), ...sourceUrls])].sort();
    return;
  }

  candidatesByKey.set(key, {
    schema_version: 1,
    state: "schema-valid",
    auth_required: false,
    public_safe: true,
    rate_limit_notes: "Candidate only; no recurring probe is configured until maintainer review.",
    ...candidate,
    url: normalizedUrl,
    source_url: sourceUrl,
    source_urls: sourceUrls
  });
}

function extractUrls(value) {
  const values = arrayFrom(value).flatMap((item) => {
    if (typeof item !== "string") {
      return [];
    }
    const trimmed = item.trim();
    const explicitUrls = trimmed.match(/https?:\/\/[^\s,"')\]]+/g) || [];
    return explicitUrls.length > 0 ? explicitUrls : [trimmed];
  });

  return [...new Set(values.map(normalizePublicUrl).filter(Boolean))];
}

function normalizePublicUrl(value) {
  if (typeof value !== "string") {
    return null;
  }

  let candidate = value.trim().replace(/^<|>$/g, "");
  if (!candidate || isPlaceholder(candidate)) {
    return null;
  }

  if (!/^https?:\/\//i.test(candidate) && /^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(candidate)) {
    candidate = `https://${candidate}`;
  }

  try {
    const url = new URL(candidate);
    if (!["http:", "https:"].includes(url.protocol)) {
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
    "yourwebsite",
    "your-org",
    "deprecated.com",
    "deprecated.png",
    "localhost",
    "127.0.0.1"
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

async function fetchJson(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "metagraphed-candidate-discovery/0.0",
        ...headers
      },
      signal: controller.signal
    });
    if (!response.ok) {
      warnings.push(`${url}: HTTP ${response.status}`);
      return null;
    }
    return await response.json();
  } catch (error) {
    warnings.push(`${url}: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function githubHeaders() {
  if (!process.env.GITHUB_TOKEN) {
    return {};
  }
  return {
    authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    "x-github-api-version": "2022-11-28"
  };
}

async function mapLimit(items, limit, mapper) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      await mapper(item);
    }
  });
  await Promise.all(workers);
}

function countBy(items, key) {
  return Object.fromEntries(
    Object.entries(
      items.reduce((accumulator, item) => {
        accumulator[item[key]] = (accumulator[item[key]] || 0) + 1;
        return accumulator;
      }, {})
    ).sort(([a], [b]) => a.localeCompare(b))
  );
}

import path from "node:path";
import {
  buildTimestamp,
  hashJson,
  isJsonContentType,
  isUnsafeUrlResolved,
  repoRoot,
  stableStringify,
  writeJson,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const generatedAt = buildTimestamp();
const contractVersion = "2026-06-06.1";
const outputRoot = path.join(repoRoot, "registry/adapters/latest");

const [allways, gittensor] = await Promise.all([
  snapshotAllways(),
  snapshotGittensor(),
]);
const snapshots = [allways, gittensor];

if (!dryRun) {
  for (const snapshot of snapshots) {
    await writeJson(path.join(outputRoot, `${snapshot.slug}.json`), snapshot);
  }
}

console.log(
  stableStringify({
    mode: dryRun ? "dry-run" : "write",
    snapshots: snapshots.map((snapshot) => ({
      slug: snapshot.slug,
      status: snapshot.status,
      dimensions: Object.keys(snapshot.dimensions || {}).length,
    })),
  }),
);

async function snapshotAllways() {
  const endpoints = [
    ["health", "https://api.all-ways.io/health"],
    ["protocol_constants", "https://api.all-ways.io/protocol/constants"],
    ["protocol_chain_state", "https://api.all-ways.io/protocol/chain-state"],
    ["network_overview", "https://api.all-ways.io/network/overview"],
    ["miners", "https://api.all-ways.io/miners"],
    ["leaderboard", "https://api.all-ways.io/miners/leaderboard"],
    ["reliability", "https://api.all-ways.io/miners/reliability"],
    ["events_latest", "https://api.all-ways.io/events/latest"],
    ["crown", "https://api.all-ways.io/crown"],
  ];
  const dimensions = {};
  await mapLimit(endpoints, 6, async ([key, url]) => {
    dimensions[key] = await fetchJsonSummary(url);
  });
  dimensions.sse = await fetchSseSummary("https://api.all-ways.io/sse");

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source: "adapter-snapshot",
    netuid: 7,
    slug: "allways",
    status: adapterStatus(Object.values(dimensions)),
    dimensions,
    notes: [
      "Allways adapter publishes response-shape, count, hash, and freshness metadata only.",
      "Raw swap, miner, address, wallet, validator, and event payloads are not persisted.",
    ],
  };
}

async function snapshotGittensor() {
  const masterUrl =
    "https://raw.githubusercontent.com/entrius/gittensor/main/gittensor/validator/weights/master_repositories.json";
  const master = await fetchJson(masterUrl);
  const dimensions = {
    master_repositories: summarizeGittensorMaster(masterUrl, master),
    bounties: {
      status: "docs-only",
      source_url: "https://docs.gittensor.io/cli",
      notes:
        "Bounty state is documented through CLI flows; no unauthenticated public API surface has been verified.",
    },
    contributions: {
      status: "docs-only",
      source_url: "https://docs.gittensor.io/oss-contributions.html",
      notes:
        "Contribution scoring rules are public; validator-local scoring inputs and PAT-backed flows remain out of scope.",
    },
  };

  const repositoryNames = Object.keys(master.body || {}).sort();
  const repoMetadata = [];
  await mapLimit(repositoryNames, 6, async (fullName) => {
    const metadata = await fetchGithubRepo(fullName);
    repoMetadata.push(metadata);
  });
  repoMetadata.sort((a, b) => a.full_name.localeCompare(b.full_name));
  dimensions.repository_metadata = summarizeGithubMetadata(repoMetadata);
  dimensions.mirror_freshness = repoMetadata.find(
    (repo) => repo.full_name === "entrius/das-github-mirror",
  ) || {
    status: "not-found",
    full_name: "entrius/das-github-mirror",
  };

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source: "adapter-snapshot",
    netuid: 74,
    slug: "gittensor",
    status: adapterStatus([
      dimensions.master_repositories,
      dimensions.repository_metadata,
    ]),
    dimensions,
    excluded_dimensions: [
      "credentialed_github_flows",
      "private_validator_inputs",
      "private_dashboards",
      "wallet_data",
    ],
    notes: [
      "Gittensor adapter publishes public repository/config aggregates only.",
      "No PATs, wallet paths, local validator state, private scoring inputs, or credentialed GitHub data are collected.",
    ],
  };
}

async function fetchJsonSummary(url) {
  const fetched = await fetchJson(url);
  if (!fetched.ok) {
    return {
      status: fetched.status,
      url,
      error: fetched.error || null,
      status_code: fetched.status_code || null,
      latency_ms: fetched.latency_ms ?? null,
      captured_at: fetched.captured_at,
    };
  }

  return {
    status: "captured",
    url,
    status_code: fetched.status_code,
    latency_ms: fetched.latency_ms,
    content_type: fetched.content_type,
    captured_at: fetched.captured_at,
    hash: hashJson(fetched.body),
    shape: summarizeJsonShape(fetched.body),
  };
}

async function fetchJson(url) {
  if (await isUnsafeUrlResolved(url)) {
    return {
      ok: false,
      status: "unsafe",
      error: "unsafe URL",
      captured_at: new Date().toISOString(),
    };
  }

  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "metagraphed-adapter-snapshot/0.0",
      },
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status:
          response.status === 429
            ? "rate-limited"
            : response.status >= 500
              ? "transient"
              : "failed",
        error: `HTTP ${response.status}`,
        status_code: response.status,
        content_type: contentType || null,
        latency_ms: Math.round(performance.now() - started),
        captured_at: new Date().toISOString(),
      };
    }
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!isJsonContentType(contentType) && body === null) {
      return {
        ok: false,
        status: "content-mismatch",
        error: "response was not JSON",
        status_code: response.status,
        content_type: contentType || null,
        latency_ms: Math.round(performance.now() - started),
        captured_at: new Date().toISOString(),
      };
    }
    return {
      ok: true,
      status: "captured",
      body,
      status_code: response.status,
      content_type: contentType || null,
      latency_ms: Math.round(performance.now() - started),
      captured_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      status: error.name === "AbortError" ? "timeout" : "failed",
      error: error.message,
      error_class: error.name,
      latency_ms: Math.round(performance.now() - started),
      captured_at: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSseSummary(url) {
  if (await isUnsafeUrlResolved(url)) {
    return {
      status: "unsafe",
      url,
      error: "unsafe URL",
      captured_at: new Date().toISOString(),
    };
  }

  const controller = new AbortController();
  const started = performance.now();
  const timer = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "text/event-stream",
        "user-agent": "metagraphed-adapter-snapshot/0.0",
      },
      signal: controller.signal,
    });
    let firstChunkBytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      const chunk = await reader.read().catch(() => null);
      firstChunkBytes = chunk?.value?.byteLength || 0;
      await reader.cancel().catch(() => {});
    }
    return {
      status: response.ok
        ? "captured"
        : response.status === 429
          ? "rate-limited"
          : "failed",
      url,
      status_code: response.status,
      content_type: response.headers.get("content-type") || null,
      latency_ms: Math.round(performance.now() - started),
      first_chunk_bytes: firstChunkBytes,
      captured_at: new Date().toISOString(),
    };
  } catch (error) {
    return {
      status: error.name === "AbortError" ? "timeout" : "failed",
      url,
      error: error.message,
      error_class: error.name,
      latency_ms: Math.round(performance.now() - started),
      captured_at: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeJsonShape(value) {
  const shape = {
    type: Array.isArray(value)
      ? "array"
      : value === null
        ? "null"
        : typeof value,
  };
  if (Array.isArray(value)) {
    shape.item_count = value.length;
    if (value[0] && typeof value[0] === "object" && !Array.isArray(value[0])) {
      const keys = Object.keys(value[0]).sort();
      shape.first_item_keys = publicSafeFieldNames(keys).slice(0, 40);
      shape.redacted_key_count = keys.length - shape.first_item_keys.length;
    } else {
      shape.first_item_keys = [];
      shape.redacted_key_count = 0;
    }
    return shape;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    const topLevelKeys = entries.map(([key]) => key).sort();
    shape.top_level_keys = publicSafeFieldNames(topLevelKeys).slice(0, 60);
    shape.redacted_key_count =
      topLevelKeys.length - shape.top_level_keys.length;
    shape.top_level_key_count = entries.length;
    shape.array_fields = entries
      .filter(
        ([key, nested]) => Array.isArray(nested) && isPublicSafeFieldName(key),
      )
      .map(([key, nested]) => ({ key, item_count: nested.length }))
      .sort((a, b) => a.key.localeCompare(b.key));
    shape.object_fields = entries
      .filter(
        ([key, nested]) =>
          isPublicSafeFieldName(key) &&
          nested &&
          typeof nested === "object" &&
          !Array.isArray(nested),
      )
      .map(([key, nested]) => ({ key, key_count: Object.keys(nested).length }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  return shape;
}

function publicSafeFieldNames(keys) {
  return keys.filter(isPublicSafeFieldName);
}

function isPublicSafeFieldName(key) {
  return !/(address|coldkey|hotkey|keypair|private|secret|seed|token|wallet)/i.test(
    String(key),
  );
}

function summarizeGittensorMaster(url, fetched) {
  if (!fetched.ok || !fetched.body || typeof fetched.body !== "object") {
    return {
      status: fetched.status || "failed",
      url,
      error: fetched.error || null,
      status_code: fetched.status_code || null,
      captured_at: fetched.captured_at,
    };
  }

  const entries = Object.entries(fetched.body).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const emissionShares = entries.map(
    ([, config]) => Number(config.emission_share) || 0,
  );
  const maintainerCuts = entries.map(
    ([, config]) => Number(config.maintainer_cut) || 0,
  );
  const issueDiscoveryShares = entries.map(
    ([, config]) => Number(config.issue_discovery_share) || 0,
  );

  return {
    status: "captured",
    url,
    status_code: fetched.status_code,
    content_type: fetched.content_type,
    latency_ms: fetched.latency_ms,
    captured_at: fetched.captured_at,
    config_hash: hashJson(fetched.body),
    repository_count: entries.length,
    total_emission_share: round6(
      emissionShares.reduce((sum, value) => sum + value, 0),
    ),
    zero_emission_count: emissionShares.filter((value) => value === 0).length,
    maintainer_cut_repo_count: maintainerCuts.filter((value) => value > 0)
      .length,
    max_maintainer_cut: round6(Math.max(0, ...maintainerCuts)),
    issue_discovery_enabled_count: issueDiscoveryShares.filter(
      (value) => value > 0,
    ).length,
    top_emission_repositories: entries
      .map(([repository, config]) => ({
        repository,
        emission_share: Number(config.emission_share) || 0,
        maintainer_cut: Number(config.maintainer_cut) || 0,
        issue_discovery_share: Number(config.issue_discovery_share) || 0,
      }))
      .sort(
        (a, b) =>
          b.emission_share - a.emission_share ||
          a.repository.localeCompare(b.repository),
      )
      .slice(0, 10),
  };
}

async function fetchGithubRepo(fullName) {
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) {
    return { status: "invalid", full_name: fullName };
  }
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "metagraphed-adapter-snapshot/0.0",
  };
  if (process.env.GITHUB_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    headers["x-github-api-version"] = "2022-11-28";
  }
  const started = performance.now();
  try {
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}`,
      { headers },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      return githubHtmlFallback(fullName, {
        status:
          response.status === 403 ? "rate-limited-or-forbidden" : "failed",
        full_name: fullName,
        status_code: response.status,
        error: body?.message || `HTTP ${response.status}`,
        latency_ms: Math.round(performance.now() - started),
        captured_at: new Date().toISOString(),
      });
    }
    return {
      status: "captured",
      full_name: body.full_name || fullName,
      html_url: body.html_url || `https://github.com/${fullName}`,
      archived: Boolean(body.archived),
      disabled: Boolean(body.disabled),
      default_branch: body.default_branch || null,
      pushed_at: body.pushed_at || null,
      updated_at: body.updated_at || null,
      open_issues_count: Number.isInteger(body.open_issues_count)
        ? body.open_issues_count
        : null,
      topics: Array.isArray(body.topics) ? body.topics.slice().sort() : [],
      latency_ms: Math.round(performance.now() - started),
      captured_at: new Date().toISOString(),
    };
  } catch (error) {
    return githubHtmlFallback(fullName, {
      status: "failed",
      full_name: fullName,
      error: error.message,
      latency_ms: Math.round(performance.now() - started),
      captured_at: new Date().toISOString(),
    });
  }
}

async function githubHtmlFallback(fullName, failure) {
  const started = performance.now();
  try {
    const response = await fetch(`https://github.com/${fullName}`, {
      method: "HEAD",
      headers: {
        accept: "text/html",
        "user-agent": "metagraphed-adapter-snapshot/0.0",
      },
    });
    await response.body?.cancel?.();
    if (!response.ok) {
      return failure;
    }
    return {
      ...failure,
      status: "html-fallback",
      html_url: `https://github.com/${fullName}`,
      fallback_reason: failure.status,
      fallback_status_code: response.status,
      fallback_latency_ms: Math.round(performance.now() - started),
    };
  } catch {
    return failure;
  }
}

function summarizeGithubMetadata(repos) {
  const captured = repos.filter((repo) => repo.status === "captured");
  const usable = repos.filter((repo) =>
    ["captured", "html-fallback"].includes(repo.status),
  );
  return {
    status: usable.length === 0 && repos.length > 0 ? "degraded" : "captured",
    repository_count: repos.length,
    captured_count: captured.length,
    html_fallback_count: repos.filter((repo) => repo.status === "html-fallback")
      .length,
    archived_count: captured.filter((repo) => repo.archived).length,
    disabled_count: captured.filter((repo) => repo.disabled).length,
    latest_push_at:
      captured
        .map((repo) => repo.pushed_at)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
    rate_limited_or_forbidden_count: repos.filter(
      (repo) => repo.status === "rate-limited-or-forbidden",
    ).length,
    repositories: usable.map((repo) => ({
      full_name: repo.full_name,
      archived: repo.archived ?? null,
      default_branch: repo.default_branch || null,
      html_url: repo.html_url || null,
      metadata_level:
        repo.status === "captured" ? "github-api" : "html-fallback",
      pushed_at: repo.pushed_at || null,
      open_issues_count: repo.open_issues_count ?? null,
      topic_count: repo.topics?.length || 0,
    })),
  };
}

function adapterStatus(dimensions) {
  const values = dimensions.filter(Boolean);
  if (values.length === 0) {
    return "unknown";
  }
  if (
    values.every((dimension) =>
      ["captured", "docs-only"].includes(dimension.status),
    )
  ) {
    return "captured";
  }
  if (
    values.some((dimension) =>
      ["captured", "docs-only"].includes(dimension.status),
    )
  ) {
    return "degraded";
  }
  return "failed";
}

function round6(value) {
  return Number(value.toFixed(6));
}

async function mapLimit(items, limit, mapper) {
  const queue = [...items];
  const workers = Array.from(
    { length: Math.min(limit, queue.length) },
    async () => {
      while (queue.length > 0) {
        await mapper(queue.shift());
      }
    },
  );
  await Promise.all(workers);
}

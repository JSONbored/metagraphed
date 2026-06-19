import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildTimestamp,
  hashJson,
  isJsonContentType,
  isUnsafeResolvedUrl,
  loadSubnets,
  readJson,
  repoRoot,
  stableStringify,
  writeJson,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const generatedAt = buildTimestamp();
const contractVersion = "2026-06-06.1";
const MAX_OPENAPI_SCHEMA_BYTES = 2 * 1024 * 1024;
const outputRoot = path.join(repoRoot, "registry/adapters/latest");
// GitHub token plumbing: accept either env name (the project convention used by
// discover-candidates and the CI workflows) and ignore accidental whitespace.
const githubToken = (
  process.env.GITHUB_TOKEN ||
  process.env.GH_TOKEN ||
  ""
).trim();
// When set, an authenticated run that GitHub rejects (401) is a hard failure
// instead of silently degrading published adapter data. Targeted at the
// invalid/expired-token case; a deliberately tokenless run is never failed.
const requireAdapterAuth = process.env.METAGRAPH_REQUIRE_ADAPTER_AUTH === "1";

async function loadPreviousAdapterSnapshot(slug) {
  try {
    return await readJson(path.join(outputRoot, `${slug}.json`));
  } catch {
    return null;
  }
}
const OPENAPI_METHODS = new Set([
  "delete",
  "get",
  "head",
  "options",
  "patch",
  "post",
  "put",
  "trace",
]);

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}

async function main() {
  const [allways, gittensor] = await Promise.all([
    snapshotAllways(),
    snapshotGittensor(),
  ]);
  const genericSnapshots = await snapshotGenericOpenApiAdapters(
    new Set([allways.slug, gittensor.slug]),
  );
  const snapshots = [allways, gittensor, ...genericSnapshots].sort(
    (a, b) => a.netuid - b.netuid || a.slug.localeCompare(b.slug),
  );

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
}

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

  const previous = await loadPreviousAdapterSnapshot("gittensor");
  const repositoryNames = Object.keys(master.body || {}).sort();
  const repoMetadata = [];
  await mapLimit(repositoryNames, 6, async (fullName) => {
    const metadata = await fetchGithubRepo(fullName);
    repoMetadata.push(metadata);
  });
  repoMetadata.sort((a, b) => a.full_name.localeCompare(b.full_name));
  dimensions.repository_metadata = summarizeGithubMetadata(
    repoMetadata,
    previous?.dimensions?.repository_metadata || null,
  );
  reportAdapterAuth("gittensor", dimensions.repository_metadata);
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

async function snapshotGenericOpenApiAdapters(excludedSlugs) {
  const overlays = await loadSubnets();
  const snapshots = [];
  await mapLimit(
    overlays.filter((overlay) => !excludedSlugs.has(overlay.slug)),
    4,
    async (overlay) => {
      const schemaSurfaces = machineReadableOpenApiSurfaces(overlay);
      if (schemaSurfaces.length === 0) {
        return;
      }
      snapshots.push(
        await snapshotGenericOpenApiAdapter(overlay, schemaSurfaces),
      );
    },
  );
  return snapshots;
}

function machineReadableOpenApiSurfaces(overlay) {
  const surfaces = overlay.surfaces || [];
  const seen = new Set();
  return surfaces
    .filter(
      (surface) =>
        surface.kind === "openapi" &&
        surface.public_safe !== false &&
        surface.schema_status === "machine-readable",
    )
    .map((surface) => ({
      ...surface,
      schema_url: surface.schema_url || surface.url,
    }))
    .filter((surface) => {
      if (!surface.schema_url) {
        return false;
      }
      const key = surface.schema_url;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.schema_url.localeCompare(b.schema_url));
}

async function snapshotGenericOpenApiAdapter(overlay, schemaSurfaces) {
  const schemas = [];
  await mapLimit(schemaSurfaces, 4, async (surface) => {
    schemas.push(await fetchOpenApiSchemaSummary(surface));
  });
  schemas.sort((a, b) => a.surface_id.localeCompare(b.surface_id));

  const apiSurfaces = (overlay.surfaces || [])
    .filter((surface) =>
      ["subnet-api", "data-artifact", "sse"].includes(surface.kind),
    )
    .map(publicSurfaceSummary)
    .sort((a, b) => a.id.localeCompare(b.id));

  const dimensions = {
    openapi_schemas: summarizeOpenApiSchemas(schemas),
    public_api_surfaces: {
      status: "captured",
      captured_at: latestTimestamp(schemas.map((schema) => schema.captured_at)),
      surface_count: apiSurfaces.length,
      surfaces: apiSurfaces,
    },
  };

  return {
    schema_version: 1,
    contract_version: contractVersion,
    generated_at: generatedAt,
    source: "adapter-snapshot",
    adapter_kind: "generic-openapi",
    netuid: overlay.netuid,
    slug: overlay.slug,
    status: adapterStatus(Object.values(dimensions)),
    dimensions,
    notes: [
      "Generic OpenAPI adapter publishes schema-shape, operation-count, hash, and freshness metadata only.",
      "Raw schemas, protected method calls, credentialed data, and API response payloads are not persisted.",
    ],
  };
}

async function fetchOpenApiSchemaSummary(surface) {
  const schemaUrl = surface.schema_url || surface.url;
  const fetched = await fetchJson(schemaUrl);
  const base = {
    surface_id: surface.id,
    name: surface.name,
    schema_url: schemaUrl,
    url: surface.url,
    provider: surface.provider || null,
    auth_required: Boolean(surface.auth_required),
    captured_at: fetched.captured_at,
  };
  if (!fetched.ok || !fetched.body || typeof fetched.body !== "object") {
    return {
      ...base,
      status: fetched.status || "failed",
      error: fetched.error || null,
      status_code: fetched.status_code || null,
      content_type: fetched.content_type || null,
      latency_ms: fetched.latency_ms ?? null,
    };
  }

  return {
    ...base,
    status: "captured",
    status_code: fetched.status_code,
    content_type: fetched.content_type,
    latency_ms: fetched.latency_ms,
    hash: hashJson(fetched.body),
    shape: summarizeOpenApiShape(fetched.body),
  };
}

function summarizeOpenApiSchemas(schemas) {
  const captured = schemas.filter((schema) => schema.status === "captured");
  return {
    status:
      captured.length === schemas.length
        ? "captured"
        : captured.length > 0
          ? "degraded"
          : "failed",
    schema_count: schemas.length,
    captured_count: captured.length,
    captured_at: latestTimestamp(schemas.map((schema) => schema.captured_at)),
    total_path_count: captured.reduce(
      (sum, schema) => sum + (schema.shape?.path_count || 0),
      0,
    ),
    total_operation_count: captured.reduce(
      (sum, schema) => sum + (schema.shape?.operation_count || 0),
      0,
    ),
    schemas,
  };
}

function summarizeOpenApiShape(schema) {
  const paths =
    schema.paths && typeof schema.paths === "object" ? schema.paths : {};
  const pathEntries = Object.entries(paths);
  const methodCounts = {};
  let operationCount = 0;
  for (const [, pathDefinition] of pathEntries) {
    if (!pathDefinition || typeof pathDefinition !== "object") {
      continue;
    }
    for (const method of Object.keys(pathDefinition)) {
      const normalized = method.toLowerCase();
      if (!OPENAPI_METHODS.has(normalized)) {
        continue;
      }
      methodCounts[normalized] = (methodCounts[normalized] || 0) + 1;
      operationCount += 1;
    }
  }
  const components =
    schema.components && typeof schema.components === "object"
      ? schema.components
      : {};
  const securitySchemes =
    components.securitySchemes && typeof components.securitySchemes === "object"
      ? components.securitySchemes
      : {};
  const componentSchemas =
    components.schemas && typeof components.schemas === "object"
      ? components.schemas
      : {};

  return {
    title: schema.info?.title || null,
    version: schema.info?.version || null,
    openapi_version: schema.openapi || schema.swagger || null,
    path_count: pathEntries.length,
    operation_count: operationCount,
    method_counts: Object.fromEntries(
      Object.entries(methodCounts).sort(([a], [b]) => a.localeCompare(b)),
    ),
    server_count: Array.isArray(schema.servers) ? schema.servers.length : 0,
    tag_count: Array.isArray(schema.tags) ? schema.tags.length : 0,
    component_schema_count: Object.keys(componentSchemas).length,
    security_scheme_count: Object.keys(securitySchemes).length,
    has_global_security:
      Array.isArray(schema.security) && schema.security.length > 0,
    sample_paths: pathEntries
      .map(([apiPath]) => apiPath)
      .filter(isPublicSafeOpenApiPath)
      .sort()
      .slice(0, 20),
  };
}

function publicSurfaceSummary(surface) {
  return {
    id: surface.id,
    kind: surface.kind,
    name: surface.name,
    url: surface.url,
    provider: surface.provider || null,
    auth_required: Boolean(surface.auth_required),
    schema_url: surface.schema_url || null,
    probe_enabled: Boolean(surface.probe?.enabled),
  };
}

function latestTimestamp(values) {
  return (
    values
      .filter(Boolean)
      .map((value) => new Date(value))
      .filter((value) => !Number.isNaN(value.getTime()))
      .sort((a, b) => a.getTime() - b.getTime())
      .at(-1)
      ?.toISOString() || null
  );
}

function isPublicSafeOpenApiPath(apiPath) {
  return !/(address|coldkey|hotkey|keypair|private|secret|seed|token|wallet)/i.test(
    String(apiPath),
  );
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

function parseContentLength(value) {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function readResponseText(response, maxBytes) {
  if (!response.body) {
    return { ok: true, text: "" };
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const bodyBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bodyBytes) };
}

export async function fetchJson(url, redirectCount = 0) {
  if (await isUnsafeResolvedUrl(url)) {
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
      redirect: "manual",
      signal: controller.signal,
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
        return {
          ok: false,
          status: "unsafe",
          error: "redirect target is unsafe",
          private_redirect_blocked: true,
          status_code: response.status,
          latency_ms: Math.round(performance.now() - started),
          captured_at: new Date().toISOString(),
        };
      }
      await response.body?.cancel();
      return fetchJson(redirectTarget, redirectCount + 1);
    }
    const contentType = response.headers.get("content-type") || "";
    const contentLength = parseContentLength(
      response.headers.get("content-length"),
    );
    if (contentLength !== null && contentLength > MAX_OPENAPI_SCHEMA_BYTES) {
      await response.body?.cancel();
      return {
        ok: false,
        status: "too-large",
        error: `response exceeded ${MAX_OPENAPI_SCHEMA_BYTES} bytes`,
        status_code: response.status,
        content_type: contentType || null,
        content_length: contentLength,
        max_bytes: MAX_OPENAPI_SCHEMA_BYTES,
        latency_ms: Math.round(performance.now() - started),
        captured_at: new Date().toISOString(),
      };
    }
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
    const limitedBody = await readResponseText(
      response,
      MAX_OPENAPI_SCHEMA_BYTES,
    );
    if (!limitedBody.ok) {
      return {
        ok: false,
        status: "too-large",
        error: `response exceeded ${MAX_OPENAPI_SCHEMA_BYTES} bytes`,
        status_code: response.status,
        content_type: contentType || null,
        content_length: contentLength,
        max_bytes: MAX_OPENAPI_SCHEMA_BYTES,
        latency_ms: Math.round(performance.now() - started),
        captured_at: new Date().toISOString(),
      };
    }
    const text = limitedBody.text;
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
  if (await isUnsafeResolvedUrl(url)) {
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
  if (githubToken) {
    headers.authorization = `Bearer ${githubToken}`;
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
          response.status === 401
            ? "unauthorized"
            : response.status === 403
              ? "rate-limited-or-forbidden"
              : "failed",
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

export function summarizeGithubMetadata(repos, previousSummary = null) {
  // Index the previously-published per-repo metadata so a degraded fresh fetch
  // (bad/missing token, rate limit, transient error) carries forward the last
  // known-good GitHub API values instead of regressing the published adapter to
  // null `pushed_at`/`open_issues_count` rows.
  const previousByName = new Map(
    (previousSummary?.repositories || [])
      .filter((repo) => repo && repo.full_name)
      .map((repo) => [repo.full_name, repo]),
  );
  const previousAsOf = previousSummary?.captured_at || null;

  const unauthorized = repos.some(
    (repo) =>
      repo.status === "unauthorized" || repo.fallback_reason === "unauthorized",
  );
  const authStatus = unauthorized
    ? "unauthorized"
    : githubToken
      ? "ok"
      : "unauthenticated";

  const rows = repos.map((repo) => {
    if (repo.status === "captured") {
      return {
        full_name: repo.full_name,
        archived: repo.archived ?? null,
        default_branch: repo.default_branch || null,
        html_url: repo.html_url || null,
        metadata_level: "github-api",
        pushed_at: repo.pushed_at || null,
        open_issues_count: repo.open_issues_count ?? null,
        topic_count: repo.topics?.length || 0,
      };
    }
    // Fresh fetch did not capture: carry forward prior github-api data if any.
    const previous = previousByName.get(repo.full_name);
    if (previous && previous.metadata_level?.startsWith("github-api")) {
      return {
        full_name: repo.full_name,
        archived: previous.archived ?? null,
        default_branch: previous.default_branch || null,
        html_url: repo.html_url || previous.html_url || null,
        metadata_level: "github-api-cached",
        metadata_as_of: previous.metadata_as_of || previousAsOf,
        pushed_at: previous.pushed_at || null,
        open_issues_count: previous.open_issues_count ?? null,
        topic_count: previous.topic_count || 0,
      };
    }
    if (repo.status === "html-fallback") {
      return {
        full_name: repo.full_name,
        archived: repo.archived ?? null,
        default_branch: repo.default_branch || null,
        html_url: repo.html_url || null,
        metadata_level: "html-fallback",
        pushed_at: repo.pushed_at || null,
        open_issues_count: repo.open_issues_count ?? null,
        topic_count: repo.topics?.length || 0,
      };
    }
    return null;
  });

  const repositories = rows.filter(Boolean);
  const capturedCount = repositories.filter(
    (repo) => repo.metadata_level === "github-api",
  ).length;
  const carriedForwardCount = repositories.filter(
    (repo) => repo.metadata_level === "github-api-cached",
  ).length;
  const usableCount = capturedCount + carriedForwardCount;
  const withRealMetadata = repositories.filter((repo) =>
    repo.metadata_level?.startsWith("github-api"),
  );

  return {
    // "captured" as long as we are publishing real metadata (fresh or carried
    // forward); only "degraded" when there is genuinely nothing usable.
    status: usableCount === 0 && repos.length > 0 ? "degraded" : "captured",
    auth_status: authStatus,
    captured_at: new Date().toISOString(),
    repository_count: repos.length,
    captured_count: capturedCount,
    carried_forward_count: carriedForwardCount,
    html_fallback_count: repositories.filter(
      (repo) => repo.metadata_level === "html-fallback",
    ).length,
    archived_count: withRealMetadata.filter((repo) => repo.archived).length,
    latest_push_at:
      withRealMetadata
        .map((repo) => repo.pushed_at)
        .filter(Boolean)
        .sort()
        .at(-1) || null,
    rate_limited_or_forbidden_count: repos.filter(
      (repo) => repo.status === "rate-limited-or-forbidden",
    ).length,
    repositories: repositories.sort((a, b) =>
      a.full_name.localeCompare(b.full_name),
    ),
  };
}

function reportAdapterAuth(slug, summary) {
  if (!summary) {
    return;
  }
  if (summary.auth_status === "unauthorized") {
    const message =
      `adapter snapshot for ${slug}: GitHub rejected the configured token ` +
      `(401 Bad credentials). Published repository metadata was carried ` +
      `forward from the previous snapshot (${summary.carried_forward_count} ` +
      `repos) instead of being captured fresh. Fix GITHUB_TOKEN/GH_TOKEN.`;
    process.stderr.write(`::warning::${message}\n`);
    if (requireAdapterAuth) {
      process.stderr.write(
        `::error::${slug} adapter snapshot requires a valid GitHub token ` +
          `(METAGRAPH_REQUIRE_ADAPTER_AUTH=1).\n`,
      );
      process.exitCode = 1;
    }
  } else if (summary.auth_status === "unauthenticated" && shouldWrite) {
    process.stderr.write(
      `::warning::adapter snapshot for ${slug}: no GITHUB_TOKEN/GH_TOKEN ` +
        `configured; GitHub repository metadata may be rate-limited or ` +
        `carried forward from the previous snapshot.\n`,
    );
  }
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

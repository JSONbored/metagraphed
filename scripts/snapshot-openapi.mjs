import { promises as fs } from "node:fs";
import {
  artifactFilePath,
  artifactOutputPath,
  buildTimestamp,
  extractAuth,
  flattenSurfaces,
  hashJson,
  isJsonContentType,
  isUnsafeResolvedUrl,
  isUnsafeUrl,
  loadSubnets,
  sanitizeOpenApiDocument,
  stableStringify,
  writeJson,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const generatedAt = buildTimestamp();
const observedAt =
  nonPlaceholderTimestamp(process.env.METAGRAPH_SCHEMA_OBSERVED_AT) ||
  nonPlaceholderTimestamp(process.env.METAGRAPH_BUILD_TIMESTAMP) ||
  new Date().toISOString();
const contractVersion = "2026-06-06.1";

class SchemaSnapshotLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaSnapshotLimitError";
  }
}

// DoS bounds for the production schemas:snapshot step, which fetches and
// normalizes OpenAPI specs from untrusted upstream subnet origins.
const OPENAPI_SNAPSHOT_LIMITS = {
  responseBytes: positiveIntegerEnv("METAGRAPH_OPENAPI_MAX_BYTES", 5_000_000),
  normalizeDepth: positiveIntegerEnv(
    "METAGRAPH_OPENAPI_MAX_NORMALIZE_DEPTH",
    100,
  ),
  normalizeNodes: positiveIntegerEnv(
    "METAGRAPH_OPENAPI_MAX_NORMALIZE_NODES",
    100_000,
  ),
};

const subnets = await loadSubnets();
const surfaces = flattenSurfaces(subnets).filter(
  (surface) => surface.kind === "openapi" && surface.public_safe,
);
const existingBySurface = await loadExistingSchemaIndex();
const results = [];

await mapLimit(surfaces, 8, async (surface) => {
  const result = await snapshotSurface(surface);
  results.push(result);
});

results.sort(
  (a, b) => a.netuid - b.netuid || a.surface_id.localeCompare(b.surface_id),
);

const index = {
  schema_version: 1,
  contract_version: contractVersion,
  generated_at: generatedAt,
  observed_at: observedAt,
  source: "openapi-snapshot",
  notes:
    "Machine-readable OpenAPI/Swagger JSON snapshots only. HTML Swagger UI pages are not treated as schema-backed.",
  summary: {
    surface_count: surfaces.length,
    schema_count: results.filter((result) => result.status === "captured")
      .length,
    by_status: countBy(results, "status"),
    by_drift_status: countBy(results, "drift_status"),
  },
  // The full `document` lives only in the per-surface schema file, never in the
  // index (which would balloon to many MB).
  schemas: results.map(({ document: _document, ...rest }) => rest),
};

const capturedSchemaCount = results.filter(
  (result) => result.status === "captured",
).length;
const drift = {
  schema_version: 1,
  contract_version: contractVersion,
  generated_at: generatedAt,
  observed_at: observedAt,
  source: "openapi-snapshot",
  status: capturedSchemaCount > 0 ? "captured" : "not-found",
  openapi_surface_count: surfaces.length,
  schema_backed_surface_count: capturedSchemaCount,
  summary: index.summary,
  surfaces: results.map((result) => ({
    netuid: result.netuid,
    subnet_slug: result.subnet_slug,
    surface_id: result.surface_id,
    url: result.url,
    schema_url: result.schema_url,
    status: result.status,
    drift_status: result.drift_status,
    hash: result.hash,
    previous_hash: result.previous_hash,
    error: result.error || null,
  })),
};

if (!dryRun) {
  for (const result of results) {
    if (result.status !== "captured") {
      continue;
    }
    await writeJson(artifactOutputPath(`schemas/${result.surface_id}.json`), {
      ...result.snapshot,
      // The real OpenAPI/Swagger spec — paths + components + securitySchemes —
      // so consumers (get_api_schema) can build a client, not just read a hash.
      document: result.document,
    });
  }
  await writeJson(artifactOutputPath("schemas/index.json"), index);
  await writeJson(artifactOutputPath("schema-drift.json"), drift);
  await updateFreshnessSchemaSnapshot(drift);
}

console.log(
  stableStringify({
    mode: dryRun ? "dry-run" : "write",
    surface_count: surfaces.length,
    summary: index.summary,
  }),
);

async function snapshotSurface(surface) {
  const candidates = candidateSchemaUrls(surface);
  for (const schemaUrl of candidates) {
    const response = await fetchJson(schemaUrl);
    if (!response.ok) {
      if (response.private_redirect_blocked || response.unsafe_url) {
        return unavailable(surface, schemaUrl, "unsafe", response.error);
      }
      if (isLimitResponse(response)) {
        return unavailable(surface, schemaUrl, "too-large", response.error);
      }
      continue;
    }
    if (!isOpenApiLike(response.body)) {
      continue;
    }

    let normalized;
    try {
      assertNormalizationBounds(response.body);
      normalized = sanitizeOpenApiDocument(response.body);
    } catch (error) {
      if (error instanceof SchemaSnapshotLimitError) {
        return unavailable(surface, schemaUrl, "too-large", error.message);
      }
      throw error;
    }
    const hash = hashJson(normalized);
    const previous = existingBySurface.get(surface.id);
    const driftStatus = previous?.hash
      ? previous.hash === hash
        ? "unchanged"
        : "changed"
      : "new";
    const snapshot = {
      schema_version: 1,
      contract_version: contractVersion,
      generated_at: generatedAt,
      observed_at: observedAt,
      netuid: surface.netuid,
      subnet_slug: surface.subnet_slug,
      subnet_name: surface.subnet_name,
      surface_id: surface.id,
      surface_url: surface.url,
      schema_url: schemaUrl,
      hash,
      previous_hash: previous?.hash || null,
      drift_status: driftStatus,
      openapi_version: normalized.openapi || normalized.swagger || null,
      title: normalized.info?.title || null,
      version: normalized.info?.version || null,
      path_count:
        normalized.paths && typeof normalized.paths === "object"
          ? Object.keys(normalized.paths).length
          : 0,
      component_schema_count:
        normalized.components?.schemas &&
        typeof normalized.components.schemas === "object"
          ? Object.keys(normalized.components.schemas).length
          : 0,
      tag_count: Array.isArray(normalized.tags) ? normalized.tags.length : 0,
      server_count: Array.isArray(normalized.servers)
        ? normalized.servers.length
        : 0,
      ...extractAuth(normalized),
    };

    return {
      netuid: surface.netuid,
      subnet_slug: surface.subnet_slug,
      surface_id: surface.id,
      url: surface.url,
      schema_url: schemaUrl,
      status: "captured",
      drift_status: driftStatus,
      hash,
      previous_hash: previous?.hash || null,
      path: `/metagraph/schemas/${surface.id}.json`,
      content_type: response.content_type || null,
      snapshot,
      // Sanitized spec — written only to the per-surface schema file (not the
      // index), so get_api_schema can return real paths/components safely.
      document: normalized,
    };
  }

  return unavailable(
    surface,
    candidates[0] || surface.url,
    "not-found",
    "no machine-readable OpenAPI JSON found",
  );
}

function unavailable(surface, schemaUrl, status, error) {
  const previous = existingBySurface.get(surface.id);
  return {
    netuid: surface.netuid,
    subnet_slug: surface.subnet_slug,
    surface_id: surface.id,
    url: surface.url,
    schema_url: schemaUrl || null,
    status,
    drift_status: previous?.hash
      ? "missing-after-previous-capture"
      : "not-captured",
    hash: null,
    previous_hash: previous?.hash || null,
    path: null,
    error,
  };
}

function candidateSchemaUrls(surface) {
  const urls = [];
  if (surface.schema_url) {
    urls.push(surface.schema_url);
  }

  try {
    const parsed = new URL(surface.url);
    if (parsed.pathname.toLowerCase().endsWith(".json")) {
      urls.push(surface.url);
    }
    for (const suffix of [
      "/openapi.json",
      "/swagger.json",
      "/swagger-json",
      "/api-json",
      "/docs-json",
      "/swagger/v1/swagger.json",
    ]) {
      urls.push(`${parsed.origin}${suffix}`);
    }
  } catch {
    // Ignore invalid URLs; validation catches them elsewhere.
  }

  return [...new Set(urls.filter((url) => !isUnsafeUrl(url)))];
}

async function fetchJson(url, redirectCount = 0) {
  if (await isUnsafeResolvedUrl(url)) {
    return { ok: false, unsafe_url: true, error: "unsafe URL" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "metagraphed-openapi-snapshot/0.0",
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
          private_redirect_blocked: true,
          error: "redirect target is unsafe",
        };
      }
      await response.body?.cancel();
      return fetchJson(redirectTarget, redirectCount + 1);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !isJsonContentType(contentType)) {
      await response.body?.cancel();
      return {
        ok: false,
        content_type: contentType || null,
        status_code: response.status,
        error: response.ok
          ? "content type is not JSON"
          : `HTTP ${response.status}`,
      };
    }

    const contentLength = parseContentLength(
      response.headers.get("content-length"),
    );
    if (contentLength > OPENAPI_SNAPSHOT_LIMITS.responseBytes) {
      await response.body?.cancel();
      return {
        ok: false,
        content_type: contentType,
        status_code: response.status,
        error: `JSON response exceeds ${OPENAPI_SNAPSHOT_LIMITS.responseBytes} byte limit`,
      };
    }

    const rawBody = await readBoundedResponseText(
      response,
      OPENAPI_SNAPSHOT_LIMITS.responseBytes,
    );
    return {
      ok: true,
      body: JSON.parse(rawBody),
      content_type: contentType,
      status_code: response.status,
    };
  } catch (error) {
    return { ok: false, error: error.message, error_class: error.name };
  } finally {
    clearTimeout(timer);
  }
}

function isLimitResponse(response) {
  return (
    response.error_class === "SchemaSnapshotLimitError" ||
    response.error?.includes("byte limit")
  );
}

async function readBoundedResponseText(response, maxBytes) {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        await reader.cancel();
        throw new SchemaSnapshotLimitError(
          `JSON response exceeds ${maxBytes} byte limit`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

// Depth/node guard for the untrusted OpenAPI document. The byte-bound caps
// total size; this defends the recursive sanitizeOpenApiDocument() pass from a
// pathological within-budget structure (deep nesting / huge fan-out). Kept
// local to the snapshot step rather than folded into the shared lib.mjs
// sanitizer so the limit policy stays with the untrusted-fetch threat.
function assertNormalizationBounds(value) {
  walkNormalizationBounds(value, { nodes: 0 }, 0);
}

function walkNormalizationBounds(value, state, depth) {
  if (depth > OPENAPI_SNAPSHOT_LIMITS.normalizeDepth) {
    throw new SchemaSnapshotLimitError(
      `OpenAPI document exceeds ${OPENAPI_SNAPSHOT_LIMITS.normalizeDepth} level normalization depth limit`,
    );
  }

  state.nodes += 1;
  if (state.nodes > OPENAPI_SNAPSHOT_LIMITS.normalizeNodes) {
    throw new SchemaSnapshotLimitError(
      `OpenAPI document exceeds ${OPENAPI_SNAPSHOT_LIMITS.normalizeNodes} node normalization limit`,
    );
  }

  if (Array.isArray(value)) {
    for (const nested of value) {
      walkNormalizationBounds(nested, state, depth + 1);
    }
  } else if (value && typeof value === "object") {
    for (const nested of Object.values(value)) {
      walkNormalizationBounds(nested, state, depth + 1);
    }
  }
}

function parseContentLength(value) {
  if (!value) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function positiveIntegerEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isOpenApiLike(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (typeof value.openapi === "string" ||
      typeof value.swagger === "string" ||
      value.paths),
  );
}

async function loadExistingSchemaIndex() {
  try {
    const index = JSON.parse(
      await fs.readFile(artifactFilePath("schemas/index.json"), "utf8"),
    );
    return new Map(
      (index.schemas || [])
        .filter((entry) => entry.hash)
        .map((entry) => [entry.surface_id, entry]),
    );
  } catch {
    return new Map();
  }
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

async function updateFreshnessSchemaSnapshot(drift) {
  const freshnessPath = artifactFilePath("freshness.json");
  let freshness;
  try {
    freshness = JSON.parse(await fs.readFile(freshnessPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const asOf =
    nonPlaceholderTimestamp(drift.observed_at) ||
    nonPlaceholderTimestamp(drift.generated_at);
  if (!asOf) {
    return;
  }

  freshness.summary = {
    ...(freshness.summary || {}),
    openapi_surface_count: drift.openapi_surface_count,
    schema_snapshot_as_of: asOf,
    stale_window_warnings: (
      freshness.summary?.stale_window_warnings || []
    ).filter(
      (warning) =>
        !String(warning).startsWith("schema-drift has no observed timestamp"),
    ),
  };

  const source = {
    as_of: asOf,
    id: "schema-drift",
    lane: "schema-snapshot",
    notes:
      "Schema drift snapshots are warning-only until more subnets publish machine-readable schemas.",
    path: "public/metagraph/schema-drift.json",
    required_for_publish: false,
    stale_after_hours: 168,
    stale_behavior: "warn",
    status: drift.status,
    timestamp: asOf,
    timestamp_field: "schema_snapshot_as_of",
  };
  const sources = (freshness.sources || []).filter(
    (entry) => entry.id !== "schema-drift",
  );
  sources.push(source);
  freshness.sources = sources.sort((a, b) => a.id.localeCompare(b.id));

  await writeJson(freshnessPath, freshness);
}

function nonPlaceholderTimestamp(value) {
  if (!value || value === "1970-01-01T00:00:00.000Z") {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date.toISOString();
}

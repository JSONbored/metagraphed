// capture-fixtures: record ONE sanitized live request/response sample per
// no-auth GET service (issue #352), so the registry is agent-CONSUMABLE — an
// agent sees what a surface actually returns, not just what its schema claims.
// Network step (runs in the refresh pipeline, NOT the deterministic build):
// writes R2-staging fixtures/{surface_id}.json that build-artifacts re-attaches
// and indexes. Mirrors snapshot-openapi.mjs's safe-fetch + DoS bounds.
import http from "node:http";
import https from "node:https";
import {
  artifactOutputPath,
  buildTimestamp,
  fixtureCaptureFailureReason,
  flattenSurfaces,
  isJsonContentType,
  isUnsafeUrl,
  resolvePublicUrlAddresses,
  loadSubnets,
  sanitizeFixtureBody,
  writeJson,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const generatedAt = buildTimestamp();
const observedAt =
  process.env.METAGRAPH_BUILD_TIMESTAMP &&
  process.env.METAGRAPH_BUILD_TIMESTAMP !== "1970-01-01T00:00:00.000Z"
    ? process.env.METAGRAPH_BUILD_TIMESTAMP
    : new Date().toISOString();

// Kinds whose GET returns a JSON body worth sampling. SSE streams are excluded
// (no single response), as are dashboards (HTML).
const FIXTURE_KINDS = new Set(["subnet-api", "openapi", "data-artifact"]);
const MAX_BYTES = 1_000_000; // hard cap before parsing
const TIMEOUT_MS = 12_000;
const CONCURRENCY = 6;

class FixtureCaptureLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "FixtureCaptureLimitError";
  }
}

async function mapLimit(items, limit, fn) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    (async () => {
      while (index < items.length) {
        const current = index++;
        results[current] = await fn(items[current]);
      }
    })(),
  );
  await Promise.all(workers);
  return results;
}

async function fetchSample(url, redirectCount = 0) {
  if (typeof url !== "string" || isUnsafeUrl(url)) {
    return { ok: false, error: "unsafe or invalid url" };
  }
  const resolvedAddresses = await resolvePublicUrlAddresses(url);
  if (resolvedAddresses.length === 0) {
    return { ok: false, error: "unsafe or invalid url" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await pinnedFetch(
      url,
      resolvedAddresses,
      controller.signal,
    );
    const location = headerValue(response, "location");
    if (
      [301, 302, 303, 307, 308].includes(response.statusCode) &&
      location &&
      redirectCount < 5
    ) {
      const target = new URL(location, url).toString();
      response.destroy();
      return fetchSample(target, redirectCount + 1);
    }
    const contentType = headerValue(response, "content-type") || "";
    const ok = response.statusCode >= 200 && response.statusCode < 300;
    if (!ok || !isJsonContentType(contentType)) {
      response.destroy();
      return {
        ok: false,
        status: response.statusCode,
        error: ok ? "non-json response" : `http ${response.statusCode}`,
      };
    }
    const contentLength = parseContentLength(
      headerValue(response, "content-length"),
    );
    if (contentLength !== null && contentLength > MAX_BYTES) {
      response.destroy();
      return { ok: false, error: "response exceeds byte limit" };
    }
    const raw = await readBoundedResponseText(response, MAX_BYTES);
    return {
      ok: true,
      status: response.statusCode,
      content_type: contentType,
      body: JSON.parse(raw),
    };
  } catch (error) {
    return {
      ok: false,
      error: fixtureCaptureFailureReason(error),
      error_class: error.name,
    };
  } finally {
    clearTimeout(timer);
  }
}

function pinnedFetch(url, resolvedAddresses, signal) {
  const parsed = new URL(url);
  const client = parsed.protocol === "https:" ? https : http;
  let nextAddress = 0;

  return new Promise((resolve, reject) => {
    const request = client.request(
      parsed,
      {
        headers: {
          accept: "application/json",
          "user-agent": "metagraphed-fixture-capture/0.0",
        },
        lookup: (_hostname, _options, callback) => {
          const record =
            resolvedAddresses[nextAddress % resolvedAddresses.length];
          nextAddress += 1;
          callback(null, record.address, record.family);
        },
        signal,
      },
      resolve,
    );
    request.on("error", reject);
    request.end();
  });
}

function headerValue(response, name) {
  const value = response.headers[name];
  return Array.isArray(value) ? value[0] : value || null;
}

function parseContentLength(value) {
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  return Number.parseInt(value, 10);
}

async function readBoundedResponseText(response, maxBytes) {
  const chunks = [];
  let receivedBytes = 0;

  for await (const chunk of response) {
    receivedBytes += chunk.byteLength;
    if (receivedBytes > maxBytes) {
      response.destroy();
      throw new FixtureCaptureLimitError(
        `JSON response exceeds ${maxBytes} byte limit`,
      );
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, receivedBytes).toString("utf8");
}

const subnets = await loadSubnets();
const candidates = flattenSurfaces(subnets).filter(
  (surface) =>
    FIXTURE_KINDS.has(surface.kind) &&
    surface.public_safe &&
    !surface.auth_required &&
    surface.probe?.enabled !== false &&
    (surface.probe?.method || "GET").toUpperCase() === "GET",
);

const captured = [];
const statuses = [];
await mapLimit(candidates, CONCURRENCY, async (surface) => {
  const result = await fetchSample(surface.url);
  if (!result.ok) {
    statuses.push({
      surface_id: surface.id,
      netuid: surface.netuid,
      subnet_slug: surface.subnet_slug || null,
      kind: surface.kind,
      status: "capture-failed",
      reason: result.error || "capture failed",
      response_status: result.status ?? null,
      error_class: result.error_class || null,
    });
    return;
  }
  const fixture = {
    schema_version: 1,
    generated_at: generatedAt,
    captured_at: observedAt,
    surface_id: surface.id,
    netuid: surface.netuid,
    subnet_slug: surface.subnet_slug || null,
    subnet_name: surface.subnet_name || null,
    kind: surface.kind,
    request: { method: "GET", url: surface.url },
    response: {
      status: result.status,
      content_type: result.content_type,
      // bounded + redacted: secrets/credentials stripped, huge values truncated
      body: sanitizeFixtureBody(result.body),
    },
  };
  captured.push(fixture);
  statuses.push({
    surface_id: surface.id,
    netuid: surface.netuid,
    subnet_slug: surface.subnet_slug || null,
    kind: surface.kind,
    status: "captured",
    reason: null,
    response_status: result.status,
    error_class: null,
    captured_at: observedAt,
  });
  if (shouldWrite) {
    await writeJson(artifactOutputPath(`fixtures/${surface.id}.json`), fixture);
  }
});

const statusCounts = Object.fromEntries(
  Object.entries(
    statuses.reduce((acc, entry) => {
      acc[entry.status] = (acc[entry.status] || 0) + 1;
      return acc;
    }, {}),
  ).sort(),
);
const captureReport = {
  schema_version: 1,
  generated_at: generatedAt,
  captured_at: observedAt,
  mode: dryRun ? "dry-run" : "write",
  candidate_count: candidates.length,
  captured_count: captured.length,
  status_counts: statusCounts,
  surfaces: statuses.sort((a, b) =>
    String(a.surface_id).localeCompare(String(b.surface_id)),
  ),
};
if (shouldWrite) {
  await writeJson(artifactOutputPath("fixtures/_capture-report.json"), {
    ...captureReport,
    mode: "write",
  });
}

const summary = {
  mode: dryRun ? "dry-run" : "write",
  candidate_count: candidates.length,
  captured_count: captured.length,
  status_counts: statusCounts,
  surface_ids: captured.map((fixture) => fixture.surface_id).sort(),
  failures: statuses
    .filter((entry) => entry.status !== "captured")
    .map((entry) => ({
      surface_id: entry.surface_id,
      reason: entry.reason,
      response_status: entry.response_status,
      error_class: entry.error_class,
    })),
};
console.log(JSON.stringify(summary, null, 2));

// capture-fixtures: record ONE sanitized live request/response sample per
// no-auth GET service (issue #352), so the registry is agent-CONSUMABLE — an
// agent sees what a surface actually returns, not just what its schema claims.
// Network step (runs in the refresh pipeline, NOT the deterministic build):
// writes R2-staging fixtures/{surface_id}.json that build-artifacts re-attaches
// and indexes. Mirrors snapshot-openapi.mjs's safe-fetch + DoS bounds.
import {
  artifactOutputPath,
  buildTimestamp,
  flattenSurfaces,
  isJsonContentType,
  isUnsafeResolvedUrl,
  isUnsafeUrl,
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
  if (
    typeof url !== "string" ||
    isUnsafeUrl(url) ||
    (await isUnsafeResolvedUrl(url))
  ) {
    return { ok: false, error: "unsafe or invalid url" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "metagraphed-fixture-capture/0.0",
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
      const target = new URL(location, url).toString();
      await response.body?.cancel();
      return fetchSample(target, redirectCount + 1);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok || !isJsonContentType(contentType)) {
      await response.body?.cancel();
      return {
        ok: false,
        status: response.status,
        error: response.ok ? "non-json response" : `http ${response.status}`,
      };
    }
    const raw = await response.text();
    if (raw.length > MAX_BYTES) {
      return { ok: false, error: "response exceeds byte limit" };
    }
    return {
      ok: true,
      status: response.status,
      content_type: contentType,
      body: JSON.parse(raw),
    };
  } catch (error) {
    return { ok: false, error: error.message, error_class: error.name };
  } finally {
    clearTimeout(timer);
  }
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
await mapLimit(candidates, CONCURRENCY, async (surface) => {
  const result = await fetchSample(surface.url);
  if (!result.ok) return;
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
  if (shouldWrite) {
    await writeJson(artifactOutputPath(`fixtures/${surface.id}.json`), fixture);
  }
});

const summary = {
  mode: dryRun ? "dry-run" : "write",
  candidate_count: candidates.length,
  captured_count: captured.length,
  surface_ids: captured.map((fixture) => fixture.surface_id).sort(),
};
console.log(JSON.stringify(summary, null, 2));

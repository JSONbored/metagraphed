import { promises as fs } from "node:fs";
import path from "node:path";
import {
  buildTimestamp,
  flattenSurfaces,
  hashJson,
  isJsonContentType,
  isUnsafeUrl,
  isUnsafeUrlResolved,
  loadSubnets,
  repoRoot,
  stableStringify,
  writeJson,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const generatedAt = buildTimestamp();
const contractVersion = "2026-06-06.1";
const subnets = await loadSubnets();
const surfaces = flattenSurfaces(subnets).filter(
  (surface) => surface.kind === "openapi" && surface.public_safe,
);
const schemaRoot = path.join(repoRoot, "public/metagraph/schemas");
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
  schemas: results,
};

const capturedSchemaCount = results.filter(
  (result) => result.status === "captured",
).length;
const drift = {
  schema_version: 1,
  contract_version: contractVersion,
  generated_at: generatedAt,
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
  await fs.mkdir(schemaRoot, { recursive: true });
  for (const result of results) {
    if (result.status !== "captured") {
      continue;
    }
    await writeJson(
      path.join(schemaRoot, `${result.surface_id}.json`),
      result.snapshot,
    );
  }
  await writeJson(path.join(schemaRoot, "index.json"), index);
  await writeJson(
    path.join(repoRoot, "public/metagraph/schema-drift.json"),
    drift,
  );
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
      continue;
    }
    if (!isOpenApiLike(response.body)) {
      continue;
    }

    const normalized = normalizeSchema(response.body);
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
  if (await isUnsafeUrlResolved(url)) {
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
      if (await isUnsafeUrlResolved(redirectTarget)) {
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

    return {
      ok: true,
      body: await response.json(),
      content_type: contentType,
      status_code: response.status,
    };
  } catch (error) {
    return { ok: false, error: error.message, error_class: error.name };
  } finally {
    clearTimeout(timer);
  }
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

function normalizeSchema(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeSchema);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !["x-generated-at", "x-timestamp"].includes(key.toLowerCase()),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, normalizeSchema(nested)]),
    );
  }
  return value;
}

async function loadExistingSchemaIndex() {
  try {
    const index = JSON.parse(
      await fs.readFile(path.join(schemaRoot, "index.json"), "utf8"),
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

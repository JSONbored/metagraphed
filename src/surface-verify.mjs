// #358: live "verify-now" for a single CATALOGUED surface, shared by the
// /api/v1/surfaces/{surface_id}/verify worker endpoint and the verify_integration
// MCP tool. The surface always comes from the curated operational-surfaces
// catalog (never a user-supplied URL), so this adds no new SSRF surface — it
// re-probes the exact URLs the 15-minute health cron already probes, just on
// demand. The worker layer adds the rate limiter + a 60s per-surface cache so
// repeated calls can't fan out into real outbound probes.
import { probeSurface } from "./health-probe-core.ts";
import { resolveSurfaceAlias } from "./surface-aliases.mjs";

// Surface ids look like "7:subnet-api:x" or "nodies-finney-rpc"; stable
// surface keys look like "srf-4d92fe6304cbb843". Both are catalog-resolved
// identifiers, never URLs.
export const SURFACE_ID_PATTERN = /^[a-z0-9][a-z0-9:._-]*$/i;

export function findSurface(surfaces, surfaceId, aliasArtifact = null) {
  if (!Array.isArray(surfaces) || typeof surfaceId !== "string") return null;
  const direct =
    surfaces.find(
      (surface) =>
        surface?.surface_id === surfaceId || surface?.surface_key === surfaceId,
    ) || null;
  if (direct) return direct;

  const alias = resolveSurfaceAlias(aliasArtifact, surfaceId);
  if (!alias) return null;
  return (
    surfaces.find(
      (surface) =>
        surface?.surface_key === alias.surface_key ||
        surface?.surface_id === alias.current_id,
    ) || null
  );
}

// Resolve the surface to verify for a subnet: its primary callable surface, else
// the first catalogued one (mirrors the agent-catalog's "primary" pick).
export function primarySurfaceForNetuid(surfaces, netuid) {
  if (!Array.isArray(surfaces)) return null;
  const forNetuid = surfaces.filter((surface) => surface?.netuid === netuid);
  if (forNetuid.length === 0) return null;
  return (
    forNetuid.find((surface) => surface.probe?.enabled !== false) ||
    forNetuid[0]
  );
}

// Probe one surface and shape the verify result. `prober` is injectable for
// tests (defaults to the real network probe).
export async function verifySurface(
  surface,
  options = {},
  prober = probeSurface,
) {
  // probeSurface reads `surface.id`; the catalog uses `surface_id` — bridge it.
  const probe = await prober({ ...surface, id: surface.surface_id }, options);
  const callable =
    probe.status !== "failed" &&
    probe.classification !== "dead" &&
    probe.classification !== "unsafe";
  return {
    schema_version: 1,
    surface_id: surface.surface_id,
    surface_key: surface.surface_key ?? null,
    netuid: typeof surface.netuid === "number" ? surface.netuid : null,
    kind: surface.kind,
    url: surface.url,
    provider: surface.provider ?? null,
    auth_required: Boolean(surface.auth_required),
    status: probe.status,
    classification: probe.classification ?? null,
    callable,
    latency_ms: typeof probe.latency_ms === "number" ? probe.latency_ms : null,
    status_code:
      typeof probe.status_code === "number" ? probe.status_code : null,
    error: probe.error ?? null,
    probed_at: probe.last_checked || probe.verified_at || null,
  };
}

export const VERIFY_CACHE_TTL_SECONDS = 60;

export function verifyCacheRequest(surface) {
  const canonicalSurfaceId = surface.surface_key || surface.surface_id;
  return new Request(
    `https://verify.metagraph.sh/${encodeURIComponent(canonicalSurfaceId)}`,
  );
}

const verifyInFlight = new Map();

function verifyInFlightKey(cacheKey, probeOptions) {
  return `${cacheKey.url}:${JSON.stringify(probeOptions ?? {})}`;
}

// Shared 60s Cache-API layer for REST verify and MCP verify_integration (#358).
export async function verifySurfaceWithCache(
  surface,
  probeOptions = {},
  { cache = globalThis.caches?.default ?? null, waitUntil = null, prober } = {},
) {
  const cacheKey = cache ? verifyCacheRequest(surface) : null;
  const inFlightKey = cacheKey
    ? verifyInFlightKey(cacheKey, probeOptions)
    : null;
  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const cached = await hit.json();
      return { ...cached, from_cache: true };
    }
  }

  if (inFlightKey) {
    const pending = verifyInFlight.get(inFlightKey);
    if (pending) {
      return await pending;
    }
  }

  let put = null;
  const verification = (async () => {
    const result = await verifySurface(surface, probeOptions, prober);
    if (cache && cacheKey) {
      const stored = new Response(JSON.stringify(result), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, s-maxage=${VERIFY_CACHE_TTL_SECONDS}`,
        },
      });
      put = cache.put(cacheKey, stored);
      if (typeof waitUntil === "function") {
        waitUntil(put);
      } else {
        await put;
      }
    }
    return { ...result, from_cache: false };
  })();

  if (inFlightKey) {
    verifyInFlight.set(inFlightKey, verification);
  }

  try {
    return await verification;
  } finally {
    if (inFlightKey && verifyInFlight.get(inFlightKey) === verification) {
      if (put && typeof waitUntil === "function") {
        put
          .catch(() => {})
          .finally(() => {
            if (verifyInFlight.get(inFlightKey) === verification) {
              verifyInFlight.delete(inFlightKey);
            }
          });
      } else {
        verifyInFlight.delete(inFlightKey);
      }
    }
  }
}

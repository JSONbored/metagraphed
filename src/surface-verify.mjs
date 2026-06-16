// #358: live "verify-now" for a single CATALOGUED surface, shared by the
// /api/v1/surfaces/{surface_id}/verify worker endpoint and the verify_integration
// MCP tool. The surface always comes from the curated operational-surfaces
// catalog (never a user-supplied URL), so this adds no new SSRF surface — it
// re-probes the exact URLs the 2-minute health cron already probes, just on
// demand. The worker layer adds the rate limiter + a 60s per-surface cache so
// repeated calls can't fan out into real outbound probes.
import { probeSurface } from "./health-probe-core.mjs";

// Surface ids look like "7:subnet-api:x" or "nodies-finney-rpc".
export const SURFACE_ID_PATTERN = /^[a-z0-9][a-z0-9:._-]*$/i;

export function findSurface(surfaces, surfaceId) {
  if (!Array.isArray(surfaces) || typeof surfaceId !== "string") return null;
  return surfaces.find((surface) => surface?.surface_id === surfaceId) || null;
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

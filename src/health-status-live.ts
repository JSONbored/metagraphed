// Probe continuity carries measured last_ok and failure streaks across runs.
// An explicit native capability owns this read; malformed capabilities throw.
// Otherwise METAGRAPH_HEALTH_SOURCE must name the data-api binding. Use its
// direct internal route: widening tryDataApiTier's shared flags would also
// forward health routes that data-api does not implement (#9522).
// Transport, body and unavailable-tier failures yield no rows so the prober
// can still run without carrying previous continuity forward.

import { selectedObservationsStore } from "./observations-neon.ts";

type Row = Record<string, unknown>;

/** Flag values that name a tier able to answer this route. "data-api" is the
 * dispatcher in DATA_API (the value stopped saying "d1" about a deleted
 * database, #10223); the legacy "postgres" box value died with the box.
 * Anything else -- unset, "retired", a typo -- means there is nothing to ask. */
const TIERS_THAT_ANSWER = new Set(["data-api"]);

/**
 * surface_status rows whose `last_checked` is at or after `sinceMs`.
 *
 * Pass 0 for "every tracked surface regardless of age" — what continuity
 * wants, since a stale row is precisely the one worth carrying forward. The
 * serving fallback passes a real freshness cutoff instead, because a stale row
 * is not worth SERVING.
 */
export async function readLiveSurfaceStatus(
  env: Env | null | undefined,
  sinceMs: number,
): Promise<Row[]> {
  if (!env) return [];
  const native = selectedObservationsStore(env);
  if (native) {
    try {
      const rows = await native.unsafe(
        "SELECT * FROM surface_status WHERE last_checked >= $1",
        [Number.isFinite(sinceMs) && sinceMs > 0 ? Math.floor(sinceMs) : 0],
      );
      return Array.isArray(rows) ? (rows as Row[]) : [];
    } catch {
      return [];
    }
  }
  if (!TIERS_THAT_ANSWER.has(String(env.METAGRAPH_HEALTH_SOURCE))) return [];
  // Not cast to reach it: `Env` declares DATA_API. The runtime check stays --
  // a wrangler config without the service binding is a real state, and a
  // thrown TypeError here would surface as a 500 rather than an empty read.
  const dataApi = env.DATA_API;
  if (typeof dataApi?.fetch !== "function") return [];
  const since =
    Number.isFinite(sinceMs) && sinceMs > 0 ? Math.floor(sinceMs) : 0;
  let response: Response;
  try {
    response = await dataApi.fetch(
      new Request(
        `https://api.metagraph.sh/api/v1/internal/health-status-live?since=${since}`,
      ),
    );
  } catch {
    return [];
  }
  if (!response.ok) return [];
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return [];
  }
  const rows = (body as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

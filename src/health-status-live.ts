// The probe-status continuity read: every surface_status row the prober needs
// to carry last_ok and the failure streak across runs (#9522).
//
// WHY THIS IS A DIRECT SERVICE-BINDING CALL AND NOT tryPostgresTier.
//
// Both callers used to route this through tryPostgresTier(...,
// "METAGRAPH_HEALTH_SOURCE"), which resolved to null on every run: that flag
// reads "d1" in production, and tryPostgresTier only forwards "d1" for the
// three flags in DATA_API_D1_FLAGS. Adding this one to that set would have
// fixed the read and broken something else -- the flag is shared with
// /api/v1/health/trends, /api/v1/incidents and /api/v1/internal/compare-health,
// none of which data-api implements, so each of those would start forwarding,
// take a non-2xx, and emit a capturePostgresTierFallback exception on every
// request. That is a per-flag switch being asked to do a per-route job.
//
// This route is internal and service-binding-only, so it does not need the
// public proxy layer's flag gate at all -- the same argument
// data-api's subnet-identity-sync handler already makes for calling
// env.DATA_API.fetch() directly.
//
// THE FLAG STILL GATES THE READ, just not through DATA_API_D1_FLAGS. A
// deployment that has not pointed METAGRAPH_HEALTH_SOURCE at a tier must not
// have this reach for one -- both callers' suites pin that ("never reaches
// Postgres when the flag is off"), and it is the right contract: an unset flag
// means no probe-status tier exists here, not "try anyway". What changed is
// only that "d1" now names a tier that answers.
//
// DEGRADES, NEVER THROWS. A flag naming no tier, no binding, a transport
// failure, a non-2xx, an unparseable body, or a body without a rows array all
// yield an empty array -- which is exactly the state that existed before this
// route answered. A prober run that cannot read prior state should still
// probe; it just cannot carry continuity forward that run.

type Row = Record<string, unknown>;

interface ServiceBinding {
  fetch(request: Request): Promise<Response>;
}

/** Flag values that name a tier able to answer this route: the D1 dispatcher
 * (production since the box was retired) and the legacy Postgres one. Anything
 * else -- unset, "retired", a typo -- means there is nothing to ask. */
const TIERS_THAT_ANSWER = new Set(["d1", "postgres"]);

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
  if (!TIERS_THAT_ANSWER.has(String(env.METAGRAPH_HEALTH_SOURCE))) return [];
  const dataApi = (env as { DATA_API?: ServiceBinding } | null | undefined)
    ?.DATA_API;
  if (!dataApi?.fetch) return [];
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

// #10548: a surface registered `probe.enabled: false` is invisible to health
// forever, and an entire origin can disappear without one incident being raised.
//
// SN37 Aurelius is the demonstration: ~60 surfaces on
// `new-collector-api-production.up.railway.app`, of which ~50 are probe-disabled
// and were never checked by anything. The nine that ARE probed showed
// `degraded` -- which understates "the host does not exist" -- and the other
// fifty showed nothing at all, because `scripts/build-artifacts.ts` filters the
// prober's target list on `probe.enabled` and a false there means never in the
// list, forever.
//
// ## Why this checks ORIGINS and not surfaces
//
// The fact worth knowing is about the HOST, not the fifty paths on it. Probing
// each path would spend fifty requests to learn one thing, and would still miss
// an origin whose surfaces are all probe-disabled. One check per distinct origin
// condemns every surface on it at once -- including the ones no prober may touch
// -- and costs a single request.
//
// It also works for auth-gated surfaces without ever sending a credential or
// reading a body for content: reachability is about whether the host is there.
//
// ## How `not-routing` is decided WITHOUT a vendor list
//
// Railway answers `{"status":"error","code":404,"message":"Application not
// found"}` for every path on a deleted app. Matching that string would work
// until Vercel, Fly or Render phrase theirs differently.
//
// The signal that needs no vendor list: a real API returns DIFFERENT bodies for
// different paths. A platform placeholder returns the same one for all of them.
// So two or more registered paths answering with the same status AND the same
// body hash is the host telling us it is not routing any of what we advertise --
// whoever built the placeholder.
//
// ## The bias, stated
//
// Never condemn an origin we cannot prove dead. A single sample that 4xxs is
// `serving`, because a 401 from an auth-gated endpoint is a HEALTHY signal and
// indistinguishable from a placeholder with one observation. Under-reporting a
// dead host is recoverable; declaring a live subnet's API gone is not.

/** What one origin's check concluded. */
export type OriginVerdict =
  /** Answered, and answered differently for different paths. */
  | "serving"
  /** Every sample failed at the transport layer: DNS, TCP or TLS. */
  | "unreachable"
  /** Answered, but with one identical error for every registered path. */
  | "not-routing"
  /** Not enough samples to conclude anything. Never a finding. */
  | "indeterminate";

export interface OriginSample {
  url: string;
  /** Null when the request failed before a response existed. */
  status: number | null;
  /** Hash of the body, for the identical-placeholder comparison. Null when
   * there was no body to hash. */
  body_hash: string | null;
}

export interface OriginCheck {
  origin: string;
  checked_at: number;
  samples: OriginSample[];
  verdict: OriginVerdict;
  /** Every registered surface on this origin. A verdict about the host is a
   * verdict about all of them, which is the whole point. */
  surface_ids: string[];
}

/** Registered paths sampled per origin. Two is the minimum that can distinguish
 * a placeholder from a legitimately-404ing path; three gives one spare for a
 * path that happens to be genuinely auth-gated. */
export const ORIGIN_SAMPLE_SIZE = 3;

/** Per-sample timeout. A slow origin must not spend the tick's budget and turn
 * the origins it never reached into `unreachable` findings about them. */
export const ORIGIN_PROBE_TIMEOUT_MS = 10_000;

/** Bytes hashed per sample. A placeholder is small; hashing a megabyte of a
 * healthy API's response would spend the budget to reach the same verdict. */
export const ORIGIN_PROBE_MAX_BYTES = 64 * 1024;

/** A status at or above this is an error for the placeholder comparison. A 2xx
 * or 3xx means the host is routing, whatever the body says. */
const ERROR_STATUS_FLOOR = 400;

export interface SurfaceRef {
  id: string;
  url: string;
}

/** Group registered surfaces by origin.
 *
 * Keyed on the ORIGIN (scheme + host + port), because that is the unit that
 * lives or dies. Two subnets registering surfaces on one shared host are
 * checked once and both learn the answer.
 */
export function surfacesByOrigin(
  surfaces: Iterable<SurfaceRef>,
): Map<string, SurfaceRef[]> {
  const byOrigin = new Map<string, SurfaceRef[]>();
  for (const surface of surfaces) {
    if (!surface?.url || typeof surface.url !== "string") continue;
    let origin: string;
    try {
      const url = new URL(surface.url);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      origin = url.origin;
    } catch {
      continue;
    }
    const list = byOrigin.get(origin) ?? [];
    list.push(surface);
    byOrigin.set(origin, list);
  }
  return byOrigin;
}

/**
 * Which paths to sample for one origin.
 *
 * Registered paths, not invented ones: the question is whether the host serves
 * what we advertise, and a synthetic path would answer a different question
 * (and would 404 legitimately on a perfectly healthy API).
 *
 * Distinct paths only -- sampling the same URL twice would produce two identical
 * bodies and manufacture the `not-routing` signal out of nothing.
 */
export function sampleUrls(
  surfaces: SurfaceRef[],
  size = ORIGIN_SAMPLE_SIZE,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const surface of surfaces) {
    let path: string;
    try {
      const url = new URL(surface.url);
      path = `${url.pathname}${url.search}`;
    } catch {
      continue;
    }
    if (seen.has(path)) continue;
    seen.add(path);
    out.push(surface.url);
    if (out.length >= size) break;
  }
  return out;
}

/**
 * The verdict, from the samples alone.
 *
 * Pure, because this is the part with consequences: it decides whether we tell
 * the world a subnet's API host is gone.
 */
export function classifyOrigin(samples: OriginSample[]): OriginVerdict {
  if (samples.length === 0) return "indeterminate";
  const responded = samples.filter((s) => s.status !== null);
  if (responded.length === 0) return "unreachable";
  // One observation cannot distinguish a placeholder from an auth-gated
  // endpoint answering 401 exactly as it should. Refusing to guess here is the
  // difference between under-reporting a dead host and accusing a live one.
  if (responded.length < 2) return "serving";
  const allErrored = responded.every(
    (s) => (s.status ?? 0) >= ERROR_STATUS_FLOOR,
  );
  if (!allErrored) return "serving";
  const hashes = new Set(responded.map((s) => s.body_hash));
  // A real API says different things about different paths. One body for all of
  // them is a placeholder, whoever wrote it.
  if (hashes.size === 1 && !hashes.has(null)) return "not-routing";
  return "serving";
}

/**
 * Body text, normalised before hashing.
 *
 * A platform placeholder that echoes a unique id per response -- Railway's
 * carries a `request_id` -- would never hash equal to itself, and the
 * identical-body signal would silently never fire. Stripping the ids is what
 * makes the comparison see two copies of one placeholder as one placeholder.
 *
 * Deliberately conservative: only fields whose whole purpose is per-request
 * uniqueness. Stripping more would start making genuinely different bodies look
 * the same, which is the direction that produces a false accusation.
 */
export function normaliseBody(body: string): string {
  return body.replace(
    /"(request_id|requestId|trace_id|traceId|correlation_id|correlationId|x-request-id)"\s*:\s*"[^"]*"/g,
    '"$1":""',
  );
}

export interface OriginCheckDeps {
  /** Injected: returns the status and a body hash, or a null status when the
   * request failed before a response existed. */
  probe: (
    url: string,
  ) => Promise<{ status: number | null; bodyHash: string | null }>;
  now?: () => number;
}

/** Check one origin. */
export async function checkOrigin(
  origin: string,
  surfaces: SurfaceRef[],
  deps: OriginCheckDeps,
): Promise<OriginCheck> {
  const samples: OriginSample[] = [];
  for (const url of sampleUrls(surfaces)) {
    try {
      const { status, bodyHash } = await deps.probe(url);
      samples.push({ url, status, body_hash: bodyHash });
    } catch {
      // A thrown probe is a transport failure like any other, and is recorded
      // as one rather than dropped -- a dropped sample would shrink the set the
      // verdict is drawn from without saying so.
      samples.push({ url, status: null, body_hash: null });
    }
  }
  return {
    origin,
    checked_at: deps.now?.() ?? Date.now(),
    samples,
    verdict: classifyOrigin(samples),
    surface_ids: surfaces.map((s) => s.id),
  };
}

// ── the store ───────────────────────────────────────────────────────────────

export interface OriginStoreDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run?(): Promise<unknown>;
      all?(): Promise<{ results?: unknown[] } | null>;
    };
    all?(): Promise<{ results?: unknown[] } | null>;
  };
}

/**
 * Persist one origin's verdict.
 *
 * ON CONFLICT DO UPDATE, never INSERT OR REPLACE: the latter is SQLite's
 * spelling and Postgres rejects it outright, which is how every write in the
 * burn lane failed silently once its table became sole-store on Neon (#10172).
 *
 * One row per origin, overwritten: the question is "is it there now", and the
 * history that matters lives in the per-surface health record.
 */
export async function persistOriginCheck(
  db: OriginStoreDb | null | undefined,
  check: OriginCheck,
): Promise<{ ok: boolean; reason?: string }> {
  if (!db?.prepare) return { ok: false, reason: "no_store_binding" };
  try {
    await db
      .prepare(
        `INSERT INTO origin_reachability` +
          ` (origin, checked_at, surface_count, samples, verdict)` +
          ` VALUES (?, ?, ?, ?, ?)` +
          ` ON CONFLICT (origin) DO UPDATE SET` +
          ` checked_at = EXCLUDED.checked_at,` +
          ` surface_count = EXCLUDED.surface_count,` +
          ` samples = EXCLUDED.samples,` +
          ` verdict = EXCLUDED.verdict`,
      )
      .bind(
        check.origin,
        check.checked_at,
        check.surface_ids.length,
        check.samples.length,
        check.verdict,
      )
      .run?.();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `write_failed: ${String((error as Error)?.message ?? error)}`,
    };
  }
}

export interface OriginRecord {
  origin: string;
  checked_at: string | null;
  surface_count: number;
  samples: number;
  verdict: OriginVerdict | null;
}

/**
 * Every origin currently believed dead.
 *
 * Reads only the two adverse verdicts, because that is what a consumer acts on:
 * a list of every serving origin is the registry, which they already have.
 *
 * Null on a read failure, NOT an empty array -- "nothing is dead" and "we could
 * not check" are different claims and only one of them is reassuring.
 */
export async function loadDeadOrigins(
  db: OriginStoreDb | null | undefined,
): Promise<OriginRecord[] | null> {
  if (!db?.prepare) return null;
  try {
    const res = await db
      .prepare(
        `SELECT origin, checked_at, surface_count, samples, verdict` +
          ` FROM origin_reachability WHERE verdict IN ('not-routing', 'unreachable')` +
          ` ORDER BY surface_count DESC, origin ASC`,
      )
      .all?.();
    const out: OriginRecord[] = [];
    for (const raw of res?.results ?? []) {
      const row = raw as Record<string, unknown>;
      const at = Number(row.checked_at);
      out.push({
        origin: String(row.origin ?? ""),
        checked_at: Number.isFinite(at) ? new Date(at).toISOString() : null,
        surface_count: Number(row.surface_count) || 0,
        samples: Number(row.samples) || 0,
        verdict: (row.verdict as OriginVerdict) ?? null,
      });
    }
    return out;
  } catch {
    return null;
  }
}

// ── the lane ────────────────────────────────────────────────────────────────

/** Origins checked per tick. 277 origins x up to 3 samples is ~800 requests,
 * which is not a tick. A slice ordered by staleness completes a pass inside a
 * day and never bursts -- the same shape as the attribution sweep. */
export const ORIGIN_BATCH_SIZE = 12;

export interface OriginTickResult {
  ok: boolean;
  checked: number;
  verdicts: Record<OriginVerdict, number>;
  /** Surfaces covered by an adverse verdict this pass. The number that makes
   * the finding actionable: 128 across 11 origins, when this first ran. */
  surfaces_affected: number;
  reason?: string;
}

/**
 * One pass.
 *
 * `ok` is FALSE on an empty batch. A lane reporting success while checking
 * nothing is indistinguishable from one that checked and found everything
 * healthy -- the confusion that let the revenue probe sit dead for two months
 * (#10566).
 */
export async function runOriginReachabilityTick(
  db: OriginStoreDb | null | undefined,
  surfaces: SurfaceRef[],
  deps: OriginCheckDeps & { batch?: number; checkedAt?: Map<string, number> },
): Promise<OriginTickResult> {
  const verdicts: Record<OriginVerdict, number> = {
    serving: 0,
    unreachable: 0,
    "not-routing": 0,
    indeterminate: 0,
  };
  const byOrigin = surfacesByOrigin(surfaces);
  const stale = deps.checkedAt ?? new Map<string, number>();
  const due = [...byOrigin.keys()]
    // Never-checked first: the only state where we have said nothing at all.
    .sort(
      (a, b) =>
        (stale.get(a) ?? -1) - (stale.get(b) ?? -1) || a.localeCompare(b),
    )
    .slice(0, deps.batch ?? ORIGIN_BATCH_SIZE);
  if (due.length === 0) {
    return {
      ok: false,
      checked: 0,
      verdicts,
      surfaces_affected: 0,
      reason: "no_origins_to_check",
    };
  }
  let affected = 0;
  const failures: string[] = [];
  for (const origin of due) {
    const check = await checkOrigin(origin, byOrigin.get(origin) ?? [], deps);
    verdicts[check.verdict] += 1;
    if (check.verdict === "not-routing" || check.verdict === "unreachable") {
      affected += check.surface_ids.length;
    }
    const written = await persistOriginCheck(db, check);
    if (!written.ok) failures.push(`${origin}: ${written.reason}`);
  }
  return {
    ok: failures.length === 0,
    checked: due.length,
    verdicts,
    surfaces_affected: affected,
    ...(failures.length > 0 ? { reason: failures.join("; ") } : {}),
  };
}

/** Every origin's last check time, for the staleness ordering. Empty on a read
 * failure, which re-checks rather than skips: the cost is requests, and the
 * alternative is an origin that silently never gets looked at. */
export async function loadOriginCheckedAt(
  db: OriginStoreDb | null | undefined,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!db?.prepare) return out;
  try {
    const res = await db
      .prepare(`SELECT origin, checked_at FROM origin_reachability`)
      .all?.();
    for (const raw of res?.results ?? []) {
      const row = raw as Record<string, unknown>;
      const at = Number(row.checked_at);
      if (row.origin && Number.isFinite(at)) out.set(String(row.origin), at);
    }
  } catch {
    return new Map();
  }
  return out;
}

// #10489-#10509: look at what each subnet publishes, and record what was found
// — including, and mostly, that nothing was.
//
// WHAT THIS LANE PRODUCES IS A CANDIDATE, NEVER AN ATTRIBUTION. An ss58 string
// appearing on a team's page does not make the address theirs: the common false
// positive is a validator hotkey inside an API response, which is somebody
// else's key published by them. Clearing docs/nametag-evidence-bar.md — a
// public source tying THIS address to THIS entity — is a human judgement, and
// this lane exists to put candidates in front of one, not to skip it.
//
// THE NEGATIVE IS THE DELIVERABLE. Most subnets publish no address at all. The
// issues driving this are explicit that "no declared treasury as of <date>" is
// evidence and an undated silence is not, so a sweep that finds nothing writes
// a row saying so, with the date and how many sources it actually reached.
//
// `unreachable` IS SEPARATE FROM `none-published` ON PURPOSE. One is a
// statement about a subnet, the other about us. Collapsing them would turn our
// own outage into a finding about somebody else — the same conflation
// #10566 let stand for two months.
import { isFinneySs58Address } from "./account-balance.ts";
// The ROW shapes come from the live schema (generated/db/types.ts), not from a
// hand-written guess at them. That is where `swept_at: number | string` comes
// from: node-postgres returns BIGINT as a string unless the value is exactly
// representable, and a hand-rolled `number` would be the #9782 class of bug
// waiting to happen.
import type { AttributionSweeps } from "../generated/db/types.ts";

/** Verdicts, matching the CHECK constraint on attribution_sweeps. */
export type SweepVerdict =
  "none-published" | "candidates-found" | "unreachable" | "no-sources";

export interface SweepCandidate {
  ss58: string;
  source_url: string;
}

export interface SweepResult {
  netuid: number;
  swept_at: number;
  sources_checked: number;
  sources_read: number;
  candidates: SweepCandidate[];
  verdict: SweepVerdict;
}

/** The registry surface kinds worth fetching for an attribution.
 *
 * A team publishes an address on a page about itself, not in a metagraph dump.
 * Fetching every surface would multiply the request budget by ten for the kinds
 * least likely to carry one. */
export const SWEEPABLE_KINDS = new Set([
  "website",
  "docs",
  "source-repo",
  "subnet-api",
  "data-artifact",
]);

/** Bytes read per source. A treasury address on a page is near the top of it;
 * a megabyte of metagraph JSON is not where anyone publishes one, and reading
 * it whole would spend the budget on noise. */
export const SWEEP_MAX_BYTES = 512 * 1024;

/** Sources fetched per subnet, newest-registered first. Bounds a subnet with
 * forty declared surfaces from consuming the whole pass. */
export const SWEEP_MAX_SOURCES = 8;

/** Per-source fetch timeout. A slow source costs the tick its remaining budget
 * otherwise, and the lane would report `unreachable` for the subnets it never
 * got to rather than for the ones it could not read. */
export const SWEEP_FETCH_TIMEOUT_MS = 8_000;

/** ss58 strings in a blob of text, checksum-validated.
 *
 * The shape regex alone matches plenty of base58 that is not an address — a
 * commit hash quoted in prose, a base58 id — so every match goes through the
 * real checksum. An address that fails it is not "probably right", it is not an
 * address.
 */
export function ss58Candidates(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(/\b5[1-9A-HJ-NP-Za-km-z]{46,47}\b/g)) {
    const value = match[0];
    if (seen.has(value)) continue;
    if (!isFinneySs58Address(value)) continue;
    seen.add(value);
  }
  return [...seen];
}

/** The URLs worth fetching for one subnet, from its own registry record. */
export function sweepableSources(
  record: Record<string, unknown> | null | undefined,
): string[] {
  const surfaces = Array.isArray(record?.surfaces) ? record.surfaces : [];
  const urls: string[] = [];
  for (const raw of surfaces) {
    const surface = (raw ?? {}) as Record<string, unknown>;
    if (!SWEEPABLE_KINDS.has(String(surface.kind ?? ""))) continue;
    const url = typeof surface.url === "string" ? surface.url : "";
    // http(s) only. A surface declared with any other scheme is not something
    // this lane can read, and treating it as checked would overstate the reach.
    if (!/^https?:\/\//i.test(url)) continue;
    if (!urls.includes(url)) urls.push(url);
    if (urls.length >= SWEEP_MAX_SOURCES) break;
  }
  return urls;
}

/**
 * Decide the verdict from what actually happened.
 *
 * Four states, and the distinctions are the whole point:
 *
 *   - `no-sources`   — the subnet declares nothing fetchable. We did not look,
 *                      and this must never read as "looked, found nothing".
 *   - `unreachable`  — we tried every source and reached none. About us.
 *   - `candidates-found` — something to put in front of a reviewer.
 *   - `none-published`  — we read at least one source and found no address.
 *                      The expected majority answer, and a real finding.
 */
export function sweepVerdict(
  sourcesChecked: number,
  sourcesRead: number,
  candidates: number,
): SweepVerdict {
  if (sourcesChecked === 0) return "no-sources";
  if (sourcesRead === 0) return "unreachable";
  return candidates > 0 ? "candidates-found" : "none-published";
}

export interface SweepDeps {
  /** Injected so the lane is drivable without network I/O. */
  fetchText: (url: string) => Promise<string | null>;
  now?: () => number;
}

/**
 * Sweep one subnet.
 *
 * A source that throws or times out is counted as CHECKED but not READ, so the
 * gap between the two is visible rather than silently rolled into the finding.
 */
export async function sweepSubnet(
  netuid: number,
  record: Record<string, unknown> | null | undefined,
  deps: SweepDeps,
): Promise<SweepResult> {
  const now = deps.now?.() ?? Date.now();
  const sources = sweepableSources(record);
  const candidates: SweepCandidate[] = [];
  let read = 0;
  for (const url of sources) {
    let text: string | null;
    try {
      text = await deps.fetchText(url);
    } catch {
      // Counted as checked-but-unread below. A throwing source is the same
      // signal as an empty one: reach we did not have.
      text = null;
    }
    if (text == null) continue;
    read += 1;
    for (const ss58 of ss58Candidates(text)) {
      candidates.push({ ss58, source_url: url });
    }
  }
  return {
    netuid,
    swept_at: now,
    sources_checked: sources.length,
    sources_read: read,
    candidates,
    verdict: sweepVerdict(sources.length, read, candidates.length),
  };
}

// ── the store ───────────────────────────────────────────────────────────────

export interface SweepStoreDb {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      run?(): Promise<unknown>;
      all?(): Promise<{ results?: unknown[] } | null>;
    };
    all?(): Promise<{ results?: unknown[] } | null>;
  };
}

/**
 * Persist one pass.
 *
 * ON CONFLICT DO UPDATE, never INSERT OR REPLACE: the latter is SQLite's
 * spelling and Postgres rejects it outright, which is how every write in the
 * burn lane failed silently once its table became sole-store on Neon (#10172).
 *
 * A candidate's `first_seen` is preserved on conflict while `last_seen` moves,
 * so an address that appears once and vanishes keeps the date it was first
 * observed — the retention argument revenue_observations' response_hash makes.
 */
export async function persistSweep(
  db: SweepStoreDb | null | undefined,
  result: SweepResult,
): Promise<{ ok: boolean; reason?: string }> {
  if (!db?.prepare) return { ok: false, reason: "no_store_binding" };
  try {
    await db
      .prepare(
        `INSERT INTO attribution_sweeps` +
          ` (netuid, swept_at, sources_checked, sources_read, candidates, verdict)` +
          ` VALUES (?, ?, ?, ?, ?, ?)` +
          ` ON CONFLICT (netuid) DO UPDATE SET` +
          ` swept_at = EXCLUDED.swept_at,` +
          ` sources_checked = EXCLUDED.sources_checked,` +
          ` sources_read = EXCLUDED.sources_read,` +
          ` candidates = EXCLUDED.candidates,` +
          ` verdict = EXCLUDED.verdict`,
      )
      .bind(
        result.netuid,
        result.swept_at,
        result.sources_checked,
        result.sources_read,
        result.candidates.length,
        result.verdict,
      )
      .run?.();
    for (const candidate of result.candidates) {
      await db
        .prepare(
          `INSERT INTO attribution_candidates` +
            ` (netuid, ss58, source_url, first_seen, last_seen)` +
            ` VALUES (?, ?, ?, ?, ?)` +
            ` ON CONFLICT (netuid, ss58, source_url) DO UPDATE SET` +
            ` last_seen = EXCLUDED.last_seen`,
        )
        .bind(
          result.netuid,
          candidate.ss58,
          candidate.source_url,
          result.swept_at,
          result.swept_at,
        )
        .run?.();
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `write_failed: ${String((error as Error)?.message ?? error)}`,
    };
  }
}

export interface SweepRecord {
  swept_at: string | null;
  sources_checked: number;
  sources_read: number;
  candidates: number;
  verdict: SweepVerdict | null;
}

/**
 * One subnet's sweep state, for the wallets response to carry.
 *
 * Null on a read failure, NOT a synthesised "never swept" — an unread store and
 * a subnet nobody has swept are different facts, and a response that reported
 * the second for the first would be making the claim this lane exists to avoid.
 */
export async function loadSweepRecord(
  db: SweepStoreDb | null | undefined,
  netuid: number,
): Promise<SweepRecord | null> {
  if (!db?.prepare) return null;
  try {
    const res = await db
      .prepare(
        `SELECT swept_at, sources_checked, sources_read, candidates, verdict` +
          ` FROM attribution_sweeps WHERE netuid = ?`,
      )
      .bind(netuid)
      .all?.();
    const row = (res?.results ?? [])[0] as AttributionSweeps | undefined;
    if (!row) return null;
    const sweptAt = Number(row.swept_at);
    return {
      swept_at: Number.isFinite(sweptAt)
        ? new Date(sweptAt).toISOString()
        : null,
      sources_checked: Number(row.sources_checked) || 0,
      sources_read: Number(row.sources_read) || 0,
      candidates: Number(row.candidates) || 0,
      verdict: (row.verdict as SweepVerdict) ?? null,
    };
  } catch {
    return null;
  }
}

// ── the lane ────────────────────────────────────────────────────────────────

/** Subnets swept per tick.
 *
 * A full pass is ~129 subnets x up to 8 sources = a thousand outbound requests,
 * which is not a tick, it is an incident. The lane sweeps a SLICE and picks it
 * by staleness, so the pass completes over a day without ever bursting. */
export const SWEEP_BATCH_SIZE = 8;

/**
 * The subnets to sweep next: least recently swept first, never-swept before
 * that.
 *
 * Self-balancing on purpose. A fixed rotation drifts out of step the moment a
 * tick is skipped or a subnet is added; ordering by staleness means the lane
 * converges on whatever is oldest no matter what happened before it.
 */
export function nextToSweep(
  netuids: number[],
  sweptAt: Map<number, number>,
  batch = SWEEP_BATCH_SIZE,
): number[] {
  return [...netuids]
    .sort((a, b) => {
      // Never-swept sorts first: it is the only state where we have said
      // nothing at all, and that is the gap worth closing before refreshing a
      // finding that already exists.
      const av = sweptAt.get(a) ?? -1;
      const bv = sweptAt.get(b) ?? -1;
      return av - bv || a - b;
    })
    .slice(0, batch);
}

/** Every subnet's last sweep time. Empty on a read failure -- which makes the
 * lane treat everything as never-swept, and re-sweep rather than skip. Erring
 * toward re-reading is the safe direction: the cost is requests, and the
 * alternative is a subnet that silently never gets looked at. */
export async function loadSweptAt(
  db: SweepStoreDb | null | undefined,
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!db?.prepare) return out;
  try {
    const res = await db
      .prepare(`SELECT netuid, swept_at FROM attribution_sweeps`)
      .all?.();
    for (const raw of res?.results ?? []) {
      const row = raw as AttributionSweeps;
      const netuid = Number(row.netuid);
      const at = Number(row.swept_at);
      if (Number.isInteger(netuid) && Number.isFinite(at)) out.set(netuid, at);
    }
  } catch {
    return new Map();
  }
  return out;
}

export interface SweepTickResult {
  ok: boolean;
  swept: number;
  candidates: number;
  /** Verdict counts, so a pass that reached nothing is visible as such rather
   * than as a quiet success. */
  verdicts: Record<SweepVerdict, number>;
  reason?: string;
}

/**
 * One pass of the lane.
 *
 * `ok` is FALSE when the store could not be written, and when the batch was
 * empty. A lane that reports success while sweeping nothing is indistinguishable
 * from one that swept and found nothing -- the exact confusion that let the
 * revenue probe sit dead for two months (#10566).
 */
export async function runAttributionSweepTick(
  db: SweepStoreDb | null | undefined,
  subnets: Array<{ netuid: number; record: Record<string, unknown> }>,
  deps: SweepDeps & { batch?: number },
): Promise<SweepTickResult> {
  const verdicts: Record<SweepVerdict, number> = {
    "none-published": 0,
    "candidates-found": 0,
    unreachable: 0,
    "no-sources": 0,
  };
  const byNetuid = new Map(subnets.map((s) => [s.netuid, s.record]));
  const due = nextToSweep(
    [...byNetuid.keys()],
    await loadSweptAt(db),
    deps.batch ?? SWEEP_BATCH_SIZE,
  );
  if (due.length === 0) {
    return {
      ok: false,
      swept: 0,
      candidates: 0,
      verdicts,
      reason: "no_subnets_to_sweep",
    };
  }
  let candidates = 0;
  const failures: string[] = [];
  for (const netuid of due) {
    const result = await sweepSubnet(netuid, byNetuid.get(netuid), deps);
    verdicts[result.verdict] += 1;
    candidates += result.candidates.length;
    const written = await persistSweep(db, result);
    if (!written.ok) failures.push(`${netuid}: ${written.reason}`);
  }
  return {
    ok: failures.length === 0,
    swept: due.length,
    candidates,
    verdicts,
    ...(failures.length > 0 ? { reason: failures.join("; ") } : {}),
  };
}

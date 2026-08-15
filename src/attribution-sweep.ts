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
import {
  consumeBatch,
  enqueueAll,
  type ConsumeResult,
  type LaneMessage,
  type LaneQueue,
} from "./lane-queue.ts";
import { probeJob } from "./probe-jobs.ts";
// The ROW shapes come from the live schema (generated/db/types.ts), not from a
// hand-written guess at them. That is where `swept_at: number | string` comes
// from: node-postgres returns BIGINT as a string unless the value is exactly
// representable, and a hand-rolled `number` would be the #9782 class of bug
// waiting to happen.
import type { AttributionSweeps } from "../generated/db/types.ts";

/** Verdicts, matching the CHECK constraint on attribution_sweeps. */
export type SweepVerdict =
  | "none-published"
  | "candidates-found"
  | "unreachable"
  | "no-sources"
  | "listings-only";

/**
 * How many DISTINCT addresses one page may yield before it is a LISTING.
 *
 * A team publishes its own address on a page about itself: an owner coldkey, a
 * validator hotkey, maybe a treasury. A page carrying forty is a metagraph
 * dump, and every address on it belongs to somebody else -- the exact false
 * positive this module's header names, and the reason the evidence bar is a
 * human judgement rather than a row count.
 *
 * MEASURED, and calibrated on a gap that is in the data rather than on a round
 * number. Every source URL that had produced a candidate as of 2026-08-15,
 * by distinct addresses found:
 *
 *     1 x22  2 x25  3 x2  4 x2  5 x3  7 x2  8 x2  9  10  11
 *     <---------------- nothing between 12 and 16 ---------------->
 *     17 x2  21  23 x2  25  30  48  79  95  108 x2  135  155  172
 *     190  191  192  256 x3  340  386  388  1230
 *
 * Twelve sits in that empty band. Below it are 61 URLs and 161 candidates
 * across 48 subnets -- a population a reviewer can actually work through.
 * Above it are 17 URLs and 4,741 rows, every one of them `/allHolders`,
 * `/api/miners`, `/snap/metagraph` and their kin.
 *
 * A JUDGEMENT, NOT A LAW. The gap is empty in one observation of one day; a
 * team page listing thirteen addresses would be dropped by this and is not
 * impossible. The cost of that direction is a missed candidate, against a
 * reviewer queue of 4,902 rows that is 97% other people's keys -- and a
 * candidate nobody reads is already a candidate nobody sees.
 */
export const LISTING_ADDRESS_CAP = 12;

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
 *   - `listings-only` — we read sources and found addresses, and every one of
 *                      them was on a bulk listing. A REAL and different
 *                      finding: this subnet publishes a metagraph dump rather
 *                      than a page about itself, so the addresses are other
 *                      people's. Folding it into `none-published` would claim
 *                      we found nothing, and into `candidates-found` would put
 *                      hundreds of strangers' keys in a review queue.
 *   - `none-published`  — we read at least one source and found no address.
 *                      The expected majority answer, and a real finding.
 */
export function sweepVerdict(
  sourcesChecked: number,
  sourcesRead: number,
  candidates: number,
  listings = 0,
): SweepVerdict {
  if (sourcesChecked === 0) return "no-sources";
  if (sourcesRead === 0) return "unreachable";
  if (candidates > 0) return "candidates-found";
  // AFTER the candidates check, so a subnet with one real page and one dump
  // still reports what a reviewer can act on. Listings are only the headline
  // when they are all there was.
  return listings > 0 ? "listings-only" : "none-published";
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
  /** Sources that answered and turned out to be bulk listings. */
  let listings = 0;
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
    const found = ss58Candidates(text);
    // A PAGE, NOT ITS ADDRESSES, is what gets judged. The cap is applied per
    // source and drops all of them together, because "this page is a listing"
    // is a fact about the page -- keeping the first twelve of a metagraph dump
    // would be twelve strangers' keys chosen by document order.
    if (found.length > LISTING_ADDRESS_CAP) {
      listings += 1;
      continue;
    }
    for (const ss58 of found) {
      candidates.push({ ss58, source_url: url });
    }
  }
  return {
    netuid,
    swept_at: now,
    sources_checked: sources.length,
    sources_read: read,
    candidates,
    verdict: sweepVerdict(sources.length, read, candidates.length, listings),
  };
}

// ── the store ───────────────────────────────────────────────────────────────

/** The minimal producer-store surface used here (src/producer-store.ts),
 * structural so tests can inject a plain object. */
export interface SweepStoreDb {
  query?<Row>(text: string, values?: unknown[]): Promise<Row[]>;
  run?(text: string, values?: unknown[]): Promise<{ changes: number }>;
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
  // A DECLINE MUST SAY WHY, at the type level. `reason?: string` let a caller
  // collapse the outcome to a boolean and lose the diagnosis, which is exactly
  // what left the retry report reading "run() declined without throwing" while
  // this function had already computed the answer.
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!db?.run) return { ok: false, reason: "no_store_binding" };
  try {
    await db.run(
      `INSERT INTO attribution_sweeps` +
        ` (netuid, swept_at, sources_checked, sources_read, candidates, verdict)` +
        ` VALUES (?, ?, ?, ?, ?, ?)` +
        ` ON CONFLICT (netuid) DO UPDATE SET` +
        ` swept_at = EXCLUDED.swept_at,` +
        ` sources_checked = EXCLUDED.sources_checked,` +
        ` sources_read = EXCLUDED.sources_read,` +
        ` candidates = EXCLUDED.candidates,` +
        ` verdict = EXCLUDED.verdict`,
      [
        result.netuid,
        result.swept_at,
        result.sources_checked,
        result.sources_read,
        result.candidates.length,
        result.verdict,
      ],
    );
    for (const candidate of result.candidates) {
      await db.run(
        `INSERT INTO attribution_candidates` +
          ` (netuid, ss58, source_url, first_seen, last_seen)` +
          ` VALUES (?, ?, ?, ?, ?)` +
          ` ON CONFLICT (netuid, ss58, source_url) DO UPDATE SET` +
          ` last_seen = EXCLUDED.last_seen`,
        [
          result.netuid,
          candidate.ss58,
          candidate.source_url,
          result.swept_at,
          result.swept_at,
        ],
      );
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
  if (!db?.query) return null;
  try {
    const rows = await db.query<AttributionSweeps>(
      `SELECT swept_at, sources_checked, sources_read, candidates, verdict` +
        ` FROM attribution_sweeps WHERE netuid = ?`,
      [netuid],
    );
    const row = rows[0];
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

// ── the queue lane ──────────────────────────────────────────────────────────
//
// WHY THIS IS A QUEUE AND NOT A BIGGER CRON SLICE. The cron lane this replaced
// swept a slice of eight subnets per tick, because 128 subnets x up to 8 sources
// is ~1000 outbound requests and one scheduled invocation cannot do that. A full
// pass took sixteen hours. That was never a cadence -- it was the invocation
// budget, dressed as one.
//
// A queue removes the constraint rather than working around it. One message per
// subnet is one invocation per subnet, so the whole registry is swept from a
// single tick.
//
// AND IT REMOVES THE SCHEDULING MACHINERY ENTIRELY. The old lane ordered subnets
// by staleness and took the eight oldest, which meant a store read on every tick
// purely to decide what to skip. Enqueuing everything skips nothing, so the
// staleness ordering, the slice size, and the producer's database handle all go
// with it -- `swept_at` is now only a fact the API serves, never an input to
// scheduling.
//
// It also turns two silent failures into visible ones:
//
//   - a subnet whose fetch fails is RETRIED on its own, instead of being
//     dropped until the next hour came round to it again;
//   - a subnet that keeps failing lands in the dead-letter queue, which
//     src/dead-letter.ts records as a lane verdict. Under the cron it simply
//     produced a `unreachable` row forever and nothing said the lane itself was
//     struggling.

/** One subnet to sweep. Deliberately just the netuid: the registry record is
 * read by the consumer at delivery time, so a message that sits in the queue
 * for a minute cannot sweep a stale copy of the subnet's surfaces. */
export interface SweepMessage {
  netuid: number;
}

export async function enqueueSweeps(
  queue: LaneQueue<SweepMessage> | null | undefined,
  netuids: number[],
) {
  return enqueueAll(
    queue,
    netuids.map((netuid) => probeJob("attribution-sweep", { netuid })),
    "no_subnets_to_sweep",
  );
}

/** Sweep one subnet, and report whether the result was durably WRITTEN: a sweep
 * that happened but was not stored is a sweep that did not happen, as far as
 * anything reading the store is concerned. */
export async function handleSweepBatch(
  messages: LaneMessage[],
  db: SweepStoreDb | null | undefined,
  deps: SweepDeps & {
    /** The subnet's registry record, read at DELIVERY time so a queued message
     * cannot sweep a stale copy of its surfaces. */
    recordFor: (netuid: number) => Promise<Record<string, unknown> | null>;
  },
): Promise<ConsumeResult> {
  return consumeBatch(messages, {
    parse: (body) => {
      const netuid = Number((body as SweepMessage | null)?.netuid);
      return Number.isInteger(netuid) && netuid >= 0 ? netuid : null;
    },
    run: async (netuid) => {
      const record = await deps.recordFor(netuid);
      const result = await sweepSubnet(netuid, record, deps);
      // The store already says WHY it declined; returning `.ok` alone threw
      // that away and left the retry reading "run() declined without throwing".
      const written = await persistSweep(db, result);
      return written.ok || written.reason;
    },
  });
}

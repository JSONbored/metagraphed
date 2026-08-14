// Daily schema-snapshot baseline capture as a Worker cron writing R2 (#9096,
// following the #233 github-signals template) — the last retirement of a
// PR-based sync lane.
//
// Provenance: this replaces .github/workflows/sync-schema-snapshots.yml (daily,
// `0 5 * * *`), which ran `npm run schemas:snapshot` on a GitHub runner,
// diffed public/metagraph/schemas/index.json, and opened an auto-merged bot PR
// whenever it drifted. Its failure mode was SILENT STALENESS with a twist: the
// committed copy is the DRIFT BASELINE every later capture compares against
// (scripts/snapshot-openapi.ts loadExistingSchemaIndex, and
// scripts/build-artifacts.ts previousSchemaIndexArtifact), so a frozen copy
// does not merely go stale — it makes every capture report `drift_status:
// "new"` forever, which is exactly what an audit found (22 days stale, every
// entry "new", i.e. never once refreshed since first capture).
//
// ===========================================================================
// WHAT THIS CRON DOES *NOT* DO, AND WHY — read before "fixing" it.
// ===========================================================================
// It does not perform the live OpenAPI capture itself. That capture fetches
// arbitrary subnet-declared URLs and then runs the document through
// scripts/lib.ts's `sanitizeOpenApiDocument`, whose URL-safety leaf
// (`isUnsafeUrl` -> `isUnsafeIpAddress`) is built on node:net's `BlockList`
// CIDR table and `isIP`, and whose fetch path is `safeFetch` — DNS resolution
// with a per-hop pinned-address dispatcher, which has no Workers equivalent at
// all. Re-implementing that guard against the Worker's weaker literal
// hostname regexes would put a SECOND, differently-behaving copy of an SSRF
// control on the untrusted-document path, which is precisely the failure this
// repo's "never two implementations" rule exists to prevent. So the live
// capture stays where its guard lives: `scripts/snapshot-openapi.ts`, run by
// the publish (scripts/build.ts's `schemas-snapshot` step) on every publish —
// daily plus every registry push, i.e. at least as often as the retired
// workflow ran.
//
// WHAT THIS CRON OWNS is the thing the retired workflow actually existed for:
// the DURABLE BASELINE. It reads the freshly published index and writes it to
// a store outside the publish pipeline's trees, applying LAST-GOOD RETENTION
// the publish does not have — see below. Both baseline readers now read that
// store first, with the committed file as the fallback seed, so the drift
// chain no longer depends on a bot PR landing on main.
//
// LAST-GOOD RETENTION (#8379's failure-honesty rule, applied here). A capture
// is a live network fetch against third-party hosts. When one blips, the
// published index degrades that surface from `captured` (with a hash) to
// `not-found`, WIPING the hash — and the next capture, having no
// previous_hash to compare against, reports `drift_status: "new"` for a
// document that never changed. A single transient 502 therefore destroys a
// surface's whole drift history. This cron keeps the store's last-good
// captured entry for such a surface as long as it is younger than
// SCHEMA_SNAPSHOT_RETENTION_MS, and only lets a surface fall out of `captured`
// once the failure has genuinely persisted. Entries are retained VERBATIM (no
// synthetic marker field), so their age stays legible from their own
// `snapshot.observed_at` and no consumer sees a shape it does not already
// handle.
//
// Subrequest budget: one artifact read, one previous-store read, one
// conditional write, plus telemetry — a fixed handful per invocation, nowhere
// near the 1000-subrequests-per-invocation platform ceiling. There is no
// per-surface fetch here, which is the whole point of the split above.

import type { StorageReadResult } from "../workers/storage.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";

type Row = Record<string, unknown>;

/**
 * Literal R2 key for the Worker-cron-written schema-index baseline store.
 *
 * Deliberately OUTSIDE the publish pipeline's `latest/` / `runs/` / `by-hash/`
 * trees (same posture as the github-signals, operational-surfaces and
 * surface-health stores): a publish run must never overwrite, orphan, or
 * atomically-swap this object — it has exactly one writer (this cron), and the
 * whole point is that its lifecycle is independent of the publish whose output
 * it is the durable memory of.
 */
export const SCHEMA_INDEX_R2_KEY = "generated/schemas-index.json";

/** The published index this baseline is promoted from. */
export const SCHEMA_INDEX_ARTIFACT_PATH = "/metagraph/schemas/index.json";

/**
 * How long a last-good captured entry may be retained for a surface the
 * current publish could not capture. 30 days, matching github-signals-core's
 * retention window: long enough that a weekend outage or a certificate lapse
 * does not destroy a drift chain, short enough that a permanently-dead schema
 * URL stops being advertised as captured within a month.
 */
export const SCHEMA_SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The capture lane's declared cadence (#11146 phase 1): how old a captured
 * schema may be before a reader should treat it as stale.
 *
 * WHY A NUMBER RATHER THAN A STAMPED VERDICT. The artifact is published once
 * and served for hours, so an age computed at BUILD time is wrong the moment
 * it is read -- and `buildTimestamp()` is the 1970 epoch placeholder in every
 * local build, which would publish a twelve-day-old capture as fresh. So the
 * payload carries the two facts a reader needs -- each entry's `observed_at`
 * and this cadence -- and the subtraction happens against the reader's own
 * clock, where "now" is genuinely now.
 *
 * The lane itself stays manual by ADR 0006. Declaring the cadence does not run
 * it; it makes the lane's silence MEASURABLE, which is the difference between
 * an unpublished gap and a published one.
 *
 * 48 hours: two days of tolerance over a daily-ish refresh, so one skipped run
 * is not noise while a lane that stopped shows within two days.
 */
export const SCHEMA_CAPTURE_CADENCE_HOURS = 48;

/** What `drift_status` is measured against -- never the live upstream spec. */
export const SCHEMA_DRIFT_BASIS = "previous-capture";

/** Statuses that mean "we have a real document behind this entry". */
const CAPTURED_STATUS = "captured";

/**
 * The store document. Deliberately the PUBLISHED index carried through
 * verbatim — same `schema_version`, `contract_version`, `generated_at`,
 * `observed_at`, `notes` and `source: "openapi-snapshot"` — with only
 * `summary`/`schemas` replaced by their post-retention values and two
 * provenance fields added. That matters: `source` names where the DATA came
 * from, and scripts/build-artifacts.ts's `reusableSchemaIndexArtifact` refuses
 * any baseline whose `source` is not `"openapi-snapshot"`. Rewriting it to
 * name this cron would silently discard the whole captured index on the next
 * build and fall back to a not-captured placeholder for every surface.
 */
export interface SchemaIndexArtifact extends Row {
  summary: Row;
  schemas: Row[];
  /** When this cron promoted the published index into the store. */
  promoted_at: string;
  promoted_by: "worker-cron";
}

/** Index a document's schema entries by surface_id. */
export function schemaEntriesById(doc: unknown): Map<string, Row> {
  const rows = (doc as { schemas?: unknown } | null)?.schemas;
  const byId = new Map<string, Row>();
  for (const row of Array.isArray(rows) ? (rows as Row[]) : []) {
    const id = row?.surface_id;
    if (typeof id === "string" && id) byId.set(id, row);
  }
  return byId;
}

/**
 * The instant an entry's captured document was observed. Reads the entry's own
 * snapshot rather than the index-level stamp, so retention ages each surface by
 * when IT was last seen rather than by when the index as a whole was written.
 */
export function entryObservedAtMs(entry: Row | undefined): number | null {
  const observedAt = (entry?.snapshot as Row | undefined)?.observed_at;
  if (typeof observedAt !== "string" || !observedAt) return null;
  const ms = Date.parse(observedAt);
  return Number.isFinite(ms) ? ms : null;
}

export interface RetentionOutcome {
  schemas: Row[];
  retained_count: number;
}

/**
 * Merge the freshly published entries with the store's last-good ones.
 *
 * A published entry that is `captured` always wins — it is the newest truth.
 * A published entry that is NOT captured yields to a store entry that IS
 * captured and is younger than the retention window; past that window the
 * published (honest) failure entry stands. Entries the store has but the
 * publish no longer lists at all are DROPPED: the surface left the registry.
 */
export function retainLastGoodSchemas(
  publishedSchemas: Row[],
  previousById: Map<string, Row>,
  nowMs: number,
): RetentionOutcome {
  let retained = 0;
  const schemas = publishedSchemas.map((entry) => {
    if (entry?.status === CAPTURED_STATUS) return entry;
    const id = entry?.surface_id;
    const previous = typeof id === "string" ? previousById.get(id) : undefined;
    if (!previous || previous.status !== CAPTURED_STATUS) return entry;
    const observedAtMs = entryObservedAtMs(previous);
    if (
      observedAtMs == null ||
      nowMs - observedAtMs > SCHEMA_SNAPSHOT_RETENTION_MS
    ) {
      return entry;
    }
    retained += 1;
    return previous;
  });
  return { schemas, retained_count: retained };
}

/**
 * Which copy of the schema index the build should reconcile: the one this build
 * CAPTURED, or the durable store.
 *
 * ## THE DEADLOCK THIS ENDS (#11147)
 *
 * The publish captures every registered spec live (`schemas-snapshot`), writes
 * the index and the per-surface detail documents, and then
 * `reusableSchemaIndexArtifact` validated the STORE against THIS BUILD'S detail
 * documents -- because the store was preferred unconditionally. `detailMatches`
 * compares document hashes, so a subnet that changed its spec since the store
 * was written failed, and one failure discarded all 57 captured schemas.
 *
 * The fresher the capture, the more certain the discard. Measured 2026-08-14:
 * every captured schema frozen at `observed_at: 2026-08-02`, 24 of 52 subnets'
 * captured path count differing from their live spec, and 23 of those 24 still
 * reporting `drift_status: "unchanged"` -- the store agreeing with itself.
 *
 * ## THE RULE
 *
 * Prefer whichever copy was OBSERVED most recently. Nothing needs to know
 * whether a capture ran: a build that captured has a newer `observed_at` by
 * construction, and a build that did not (local dev, the Validate lane, the
 * determinism test) reads the committed seed whose stamp is unchanged, so the
 * store still wins and those builds stay byte-reproducible.
 *
 * The store keeps its real job. When the fresh index wins, the store's
 * last-good entries are merged back in through `retainLastGoodSchemas` -- the
 * SAME retention the cron applies -- so a surface whose spec was unreachable
 * during THIS capture keeps the entry it had, and only genuinely persistent
 * failure ages it out. Preferring fresh therefore costs no drift history.
 *
 * `nowMs` is the build's own timestamp rather than a wall clock, so the merge
 * is a function of its inputs and a rebuild produces the same bytes.
 */
export function chooseSchemaIndexBaseline(
  captured: Row | null | undefined,
  store: Row | null | undefined,
  nowMs: number,
): Row | null {
  const storeUsable = store && Array.isArray(store.schemas) ? store : null;
  const capturedUsable =
    captured && Array.isArray(captured.schemas) ? captured : null;
  if (!capturedUsable) return storeUsable ?? (captured as Row | null) ?? null;
  if (!storeUsable) return capturedUsable;
  const capturedAt = indexObservedAtMs(capturedUsable);
  const storeAt = indexObservedAtMs(storeUsable);
  // Not strictly newer -- including both unstamped, and including equal, which
  // is what a build that did not capture sees -- leaves the store in charge.
  if (capturedAt == null || (storeAt != null && capturedAt <= storeAt)) {
    return storeUsable;
  }
  const merged = retainLastGoodSchemas(
    capturedUsable.schemas as Row[],
    schemaEntriesById(storeUsable),
    nowMs,
  );
  return {
    ...capturedUsable,
    summary: summarizeSchemaEntries(merged.schemas),
    schemas: merged.schemas,
  };
}

/**
 * When the index as a whole was observed. Reads the index stamp rather than any
 * entry's, because this answers "which capture run is newer", not "how old is
 * this surface" -- `entryObservedAtMs` answers that one.
 */
export function indexObservedAtMs(doc: Row | null | undefined): number | null {
  const observedAt = doc?.observed_at ?? doc?.generated_at;
  if (typeof observedAt !== "string" || !observedAt) return null;
  // The build placeholder is not a time. A stamp of 1970 means "this build had
  // no clock", which must never read as older-or-newer than a real capture.
  if (observedAt === "1970-01-01T00:00:00.000Z") return null;
  const ms = Date.parse(observedAt);
  return Number.isFinite(ms) ? ms : null;
}

/** Recount the index summary over whatever survived retention. */
export function summarizeSchemaEntries(schemas: Row[]): Row {
  const countBy = (key: string): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const entry of schemas) {
      const value = String(entry[key]);
      counts[value] = (counts[value] || 0) + 1;
    }
    return Object.fromEntries(
      Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
    );
  };
  return {
    surface_count: schemas.length,
    schema_count: schemas.filter((entry) => entry.status === CAPTURED_STATUS)
      .length,
    by_status: countBy("status"),
    by_drift_status: countBy("drift_status"),
  };
}

// Key-sorted stringify, matching the local-copy convention in
// github-signals-core.ts — keeping this module free of script-side imports
// matters more than deduping ~10 lines.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Row;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/**
 * Content identity of the baseline with the volatile stamps excluded — the
 * cron's write-only-when-changed gate, equivalent to the retired workflow's
 * `git diff --quiet` gate.
 *
 * Per-entry `snapshot.observed_at` is excluded too: the publish re-stamps it
 * on every run even when a document's hash is byte-identical, so leaving it in
 * would make every single tick a "change" and defeat the gate entirely.
 */
export function schemaIndexContentDigest(artifact: Row): string {
  const schemas = Array.isArray(artifact.schemas)
    ? (artifact.schemas as Row[])
    : [];
  return stableStringify({
    ...artifact,
    generated_at: null,
    observed_at: null,
    promoted_at: null,
    schemas: schemas.map((entry) => ({
      ...entry,
      snapshot:
        entry.snapshot && typeof entry.snapshot === "object"
          ? {
              ...(entry.snapshot as Row),
              observed_at: null,
              generated_at: null,
            }
          : (entry.snapshot ?? null),
    })),
  });
}

export interface SchemaSnapshotsSyncDeps {
  readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  /** Clock seam for tests; stamps generated_at and ages retention. */
  now?: () => number;
  /** Telemetry seam for tests; defaults to the real recordExceptionEvent. */
  recordException?: typeof recordExceptionEvent;
}

interface Ctx {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface SchemaSnapshotsSyncResult {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  changed?: boolean;
  surface_count?: number;
  schema_count?: number;
  retained_count?: number;
}

/**
 * The daily cron tick: promote the freshly published schema index into the
 * durable baseline store, retaining last-good captures for surfaces this
 * publish could not reach, and write ONLY when the content actually moved.
 *
 * WITHOUT the METAGRAPH_ARCHIVE R2 binding this no-ops LOUDLY — console.error
 * plus one recordExceptionEvent. A lane that exists to end silent staleness
 * must not itself go quiet when it cannot write.
 */
export async function runSchemaSnapshotsSync(
  env: Env,
  ctx?: Ctx,
  deps: SchemaSnapshotsSyncDeps = {},
): Promise<SchemaSnapshotsSyncResult> {
  const bucket = env.METAGRAPH_ARCHIVE;
  if (!bucket?.get || !bucket?.put) {
    console.error(
      "[schema-snapshots-sync] METAGRAPH_ARCHIVE is not bound; the OpenAPI " +
        "drift baseline cannot be refreshed, so every later capture will " +
        'report drift_status "new" against a frozen seed.',
    );
    const pending = Promise.resolve(
      (deps.recordException ?? recordExceptionEvent)(env, {
        error: new Error("METAGRAPH_ARCHIVE not bound"),
        route: "cron:schema-snapshots-sync",
        errorCode: "schema_snapshots_bucket_missing",
      }),
    ).catch(() => false);
    ctx?.waitUntil?.(pending);
    return { ok: false, skipped: true, reason: "r2_binding_missing" };
  }
  if (typeof deps.readArtifact !== "function") {
    return { ok: false, reason: "reader_unavailable" };
  }
  try {
    const publishedRead = await deps.readArtifact(
      env,
      SCHEMA_INDEX_ARTIFACT_PATH,
    );
    if (!publishedRead?.ok) {
      return { ok: false, reason: "schema_index_artifact_unavailable" };
    }
    const published = publishedRead.data as Row | null;
    const publishedSchemas = Array.isArray(published?.schemas)
      ? (published?.schemas as Row[])
      : [];
    if (publishedSchemas.length === 0) {
      // An index with zero entries is a broken input, not a registry with no
      // openapi surfaces — never let it wipe the baseline.
      return { ok: false, reason: "empty_schema_index" };
    }

    let previousDoc: unknown = null;
    try {
      const object = await bucket.get(SCHEMA_INDEX_R2_KEY);
      previousDoc = object ? await object.json() : null;
    } catch {
      // A cold or unreadable previous store degrades to "no retention
      // credit", the same as the lane's very first run.
      previousDoc = null;
    }

    const nowMs = (deps.now ?? Date.now)();
    const { schemas, retained_count } = retainLastGoodSchemas(
      publishedSchemas,
      schemaEntriesById(previousDoc),
      nowMs,
    );
    const summary = summarizeSchemaEntries(schemas);
    const artifact: SchemaIndexArtifact = {
      ...(published as Row),
      summary,
      schemas,
      promoted_at: new Date(nowMs).toISOString(),
      promoted_by: "worker-cron",
    };

    const previousDigest = Array.isArray((previousDoc as Row | null)?.schemas)
      ? schemaIndexContentDigest(previousDoc as Row)
      : null;
    if (previousDigest === schemaIndexContentDigest(artifact)) {
      return {
        ok: true,
        changed: false,
        surface_count: schemas.length,
        schema_count: summary.schema_count as number,
        retained_count,
      };
    }

    await bucket.put(SCHEMA_INDEX_R2_KEY, JSON.stringify(artifact), {
      httpMetadata: { contentType: "application/json" },
    });
    return {
      ok: true,
      changed: true,
      surface_count: schemas.length,
      schema_count: summary.schema_count as number,
      retained_count,
    };
  } catch (error) {
    // One failed tick is one stale day, not an outage — contained, but never
    // silent (handleScheduled records the ok:false cron outcome too).
    console.error("[schema-snapshots-sync]", String((error as Error)?.message));
    return { ok: false, reason: "unreachable" };
  }
}

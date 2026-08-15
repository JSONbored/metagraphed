// The full registry resync, as a Worker lane (#10236).
//
// ## What was missing
//
// src/registry-sync-lane.ts is INCREMENTAL by design. It keeps a head sha in
// KV, compares it to main, and syncs the registry files that changed in
// between. Its own comment names the thing it deliberately does not do:
//
//   FIRST RUN HAS NO BASE, and must not guess one. [...] recording the head
//   and syncing from the NEXT commit costs one merge of latency once, and is
//   the only option that cannot be wrong. The scheduled full resync is what
//   closes any pre-existing gap.
//
// That reasoning is right and the second half did not exist. The "scheduled
// full resync" was scripts/backfill-registry-postgres.ts, invoked from GitHub
// Actions -- and no workflow calls it, which is the same discovery #9779 made
// about the incremental half. So the cursor initialised on 2026-08-08 02:25,
// the three registry merges from 08-07 fell before it, and `subnets`,
// `providers` and `surfaces` sat 145-160h stale with `registry-sync` reporting
// `ok: no registry files changed` on every tick. True for the window it looks
// at; the gap was outside that window and nothing else was looking.
//
// ## Why this is a reconciler, not a backfill
//
// It reruns forever rather than once. The incremental lane cannot lose a
// change while it works -- its cursor only advances on a successful POST -- so
// a one-off would close today's gap and leave no cover for the next time the
// lane is unbound, unscheduled, or replaced. A resync that runs on its own
// schedule is the thing that makes those failures self-healing instead of
// permanent.
//
// ## Paging, and why the pass is pinned to one commit
//
// ~265 files today, one GitHub request each. That is fine for subrequest
// limits and slow for one invocation, so a pass spans several ticks with its
// position in KV.
//
// The head sha is stored WITH the offset. A pass that re-resolved head each
// tick would mix files from different commits, and a merge landing mid-pass
// would be written half-old-half-new with no record of which. Pinning means a
// pass always describes one commit; the incremental lane carries anything
// newer, and the next pass picks it up.
import {
  buildRegistrySyncPayload,
  isEmptyPayload,
  isRegistryPath,
  type ResolvedRegistryFile,
  type Row,
  summaryCounts,
} from "./registry-sync-payload.ts";
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import { laneHealthStore } from "./lane-health-store.ts";
import { REPO, fileAt, ghJson } from "./registry-sync-lane.ts";
import {
  RegistryResyncPassStateSchema,
  type RegistryResyncPassState,
} from "../schemas-src/internal-wire.ts";

export const REGISTRY_RESYNC_LANE = "registry-resync";
const STATE_KEY = "registry-resync:state";
const COMPLETED_KEY = "registry-resync:last-complete";

/** Files resolved per tick. One GitHub request each; ~265 files is three
 * ticks. Small enough that a tick stays well inside the invocation budget,
 * large enough that a pass finishes the same day it starts. */
export const RESYNC_PAGE_SIZE = 100;

/**
 * How long after a completed pass the next one may start.
 *
 * A reconciler over a git-backed registry has nothing to gain from running
 * more often than the registry changes, and the incremental lane already
 * carries every merge within a minute. 20h rather than 24 so the pass does not
 * drift later each day and eventually skip one.
 */
export const RESYNC_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

/** The two directories the registry lives in, in the order a pass walks them. */
const REGISTRY_DIRS = ["registry/subnets", "registry/providers"] as const;

export interface RegistryResyncResult {
  ok: boolean;
  reason?: string;
  detail?: string;
  head?: string;
  /** Files resolved this tick. */
  files?: number;
  /** Position after this tick, and the pass total. */
  offset?: number;
  total?: number;
  /** True on the tick that finishes a pass. */
  complete?: boolean;
  written?: Record<string, unknown>;
}

interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete?(key: string): Promise<void>;
}

interface ServiceLike {
  fetch(request: Request): Promise<Response>;
}

/**
 * The lane's KV pass state, INFERRED from the schema that validates it
 * (#11194). Was a hand-written interface beside a four-clause guard that
 * checked the same three fields -- two statements of one rule, and
 * validate:type-duplicates is the gate that says so.
 */
type PassState = RegistryResyncPassState;

export interface RegistryResyncDeps {
  kv?: KvLike | null;
  registrySyncApi?: ServiceLike | null;
  laneHealthDb?: LaneHealthDb | null;
  now?: () => number;
}

/** Every registry file at `ref`, both directories, sorted for a stable pass. */
async function listRegistryPaths(
  env: Record<string, unknown>,
  ref: string,
): Promise<string[] | null> {
  const paths: string[] = [];
  for (const dir of REGISTRY_DIRS) {
    const listing = await ghJson(
      env,
      `/repos/${REPO}/contents/${encodeURI(dir)}?ref=${ref}`,
    );
    // A directory that cannot be listed fails the PASS rather than being
    // treated as empty. An empty listing and an unreachable one are the same
    // shape here, and the second one would delete every row the first would
    // have written.
    if (!Array.isArray(listing)) return null;
    for (const entry of listing as { path?: string; type?: string }[]) {
      if (entry?.type !== "file") continue;
      if (typeof entry.path === "string" && isRegistryPath(entry.path)) {
        paths.push(entry.path);
      }
    }
  }
  return paths.sort();
}

/**
 * One tick of the resync.
 *
 * Returns a summary rather than throwing, matching the rest of the cron
 * family: a tick that cannot run is one missed report, not an outage.
 */
export async function runRegistryResyncLane(
  env: unknown,
  deps: RegistryResyncDeps = {},
): Promise<RegistryResyncResult> {
  const result = await runResyncTick(env, deps);
  const bag = (env ?? {}) as Record<string, unknown>;
  await recordLaneVerdict(laneHealthStore(bag, deps.laneHealthDb), {
    lane: REGISTRY_RESYNC_LANE,
    verdict: result.ok ? "ok" : "stale",
    age_ms: null,
    detail: resyncDetail(result),
    checked_at: (deps.now ?? Date.now)(),
  });
  return result;
}

/**
 * One line carrying COUNTS, not just an outcome.
 *
 * "resynced 0 of 3444 surfaces" must not read the same as a real pass, which
 * is the failure #10236 asks this lane to make impossible for itself.
 */
export function resyncDetail(result: RegistryResyncResult): string {
  if (!result.ok) {
    return result.detail
      ? `${result.reason}: ${result.detail}`
      : `${result.reason}`;
  }
  if (result.reason && result.files === undefined) return result.reason;
  const position = `${result.offset ?? 0}/${result.total ?? 0}`;
  const counts = `${result.files ?? 0} file(s): ${summaryCounts(result.written)}`;
  return result.complete
    ? `pass complete at ${position} -- ${counts}`
    : `${position} -- ${counts}`;
}

async function runResyncTick(
  env: unknown,
  deps: RegistryResyncDeps,
): Promise<RegistryResyncResult> {
  const bag = (env ?? {}) as Record<string, unknown>;
  const kv = deps.kv ?? (bag.METAGRAPH_CONTROL as KvLike | undefined);
  const api =
    deps.registrySyncApi ?? (bag.REGISTRY_SYNC_API as ServiceLike | undefined);
  const now = deps.now ?? Date.now;
  if (!kv?.get) return { ok: false, reason: "kv unavailable" };
  if (!api?.fetch)
    return { ok: false, reason: "registry-sync binding unavailable" };
  if (typeof bag.REGISTRY_SYNC_SECRET !== "string" || !bag.REGISTRY_SYNC_SECRET)
    return { ok: false, reason: "registry sync secret not provisioned" };

  let state = await readState(kv);
  if (!state) {
    // Between passes. Starting one is the only branch that consults the clock,
    // so a pass ALREADY UNDER WAY always continues -- an interval check on
    // every tick would strand a half-finished pass for a day.
    // Read as a STRING first. `Number(null)` is 0, not NaN, so a
    // Number()-then-isFinite check reads a never-run lane as "completed at the
    // epoch" -- and with a real clock that is always more than the interval
    // ago, which makes it due. It is only wrong under a fake clock, which is
    // to say: it would have shipped green and only ever been wrong in
    // production, on the very first tick, forever.
    const raw = await kv.get(COMPLETED_KEY);
    const last = raw === null || raw === "" ? null : Number(raw);
    if (
      last !== null &&
      Number.isFinite(last) &&
      now() - last < RESYNC_MIN_INTERVAL_MS
    ) {
      return { ok: true, reason: "not due" };
    }
    const headCommit = await ghJson(bag, `/repos/${REPO}/commits/main`);
    const head = (headCommit as { sha?: string } | null)?.sha;
    if (typeof head !== "string" || !head)
      return { ok: false, reason: "could not resolve head" };
    const paths = await listRegistryPaths(bag, head);
    if (!paths) return { ok: false, reason: "could not list registry", head };
    if (paths.length === 0)
      return { ok: false, reason: "registry listed as empty", head };
    state = { head, paths, offset: 0 };
  }

  const page = state.paths.slice(state.offset, state.offset + RESYNC_PAGE_SIZE);
  const resolved: ResolvedRegistryFile[] = [];
  for (const path of page) {
    const overlay = await fileAt(bag, path, state.head);
    // A file that will not resolve is SKIPPED, not emitted as a deletion. It
    // is present in the listing, so it exists at this commit; treating a failed
    // read as "gone" would delete the subnet and everything referencing it.
    if (overlay) resolved.push({ path, overlay: overlay as Row });
  }

  const payload = buildRegistrySyncPayload(resolved, state.head);
  if (!isEmptyPayload(payload)) {
    const response = await api.fetch(
      new Request("https://registry-sync.internal/sync", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-registry-sync-token": bag.REGISTRY_SYNC_SECRET,
        },
        body: JSON.stringify(payload),
      }),
    );
    if (!response.ok) {
      // The offset does NOT advance, so the next tick retries this page. Same
      // discipline as the incremental lane's cursor, and for the same reason:
      // advancing past a rejected write turns one failed request into a
      // permanent hole.
      await writeState(kv, state);
      return {
        ok: false,
        reason: "sync rejected",
        detail: `status ${response.status}`,
        head: state.head,
        files: resolved.length,
        offset: state.offset,
        total: state.paths.length,
      };
    }
    const written = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    return finishTick(kv, state, page.length, resolved.length, now, written);
  }
  return finishTick(kv, state, page.length, resolved.length, now, null);
}

async function finishTick(
  kv: KvLike,
  state: PassState,
  pageSize: number,
  files: number,
  now: () => number,
  written: Record<string, unknown> | null,
): Promise<RegistryResyncResult> {
  const offset = state.offset + pageSize;
  const complete = offset >= state.paths.length;
  if (complete) {
    await kv.put(COMPLETED_KEY, String(now()));
    // Cleared BEFORE the completion is reported, and by overwrite when the KV
    // binding has no delete: a state left behind would restart the finished
    // pass from its last page on the very next tick, forever.
    if (kv.delete) await kv.delete(STATE_KEY);
    else await kv.put(STATE_KEY, "");
  } else {
    await writeState(kv, { ...state, offset });
  }
  return {
    ok: true,
    head: state.head,
    files,
    offset: Math.min(offset, state.paths.length),
    total: state.paths.length,
    ...(complete ? { complete: true } : {}),
    ...(written ? { written } : {}),
  };
}

async function readState(kv: KvLike): Promise<PassState | null> {
  const raw = await kv.get(STATE_KEY);
  if (!raw) return null;
  try {
    // PARSED, NOT CAST (#11194). The four-clause guard this replaces WAS the
    // schema, written as control flow; RegistryResyncPassStateSchema states
    // the same rule where the shape is declared, so a field added to
    // PassState cannot be persisted without also being validated.
    const parsed = RegistryResyncPassStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // A malformed state is discarded rather than throwing: the next tick
    // starts a clean pass, which is the recovery either way.
  }
  return null;
}

async function writeState(kv: KvLike, state: PassState): Promise<void> {
  await kv.put(STATE_KEY, JSON.stringify(state));
}

// The registry writer (#9779).
//
// WHAT WAS BROKEN. workers/registry-sync-api.ts describes itself as "the ONLY
// write path into the registry database" and nothing called it. Its callers
// were scripts/sync-registry-to-postgres.ts (merge-triggered) and
// scripts/backfill-registry-postgres.ts (scheduled), both invoked from GitHub
// Actions, and no workflow in .github/workflows/ invokes either. The measured
// consequence: surface_history frozen at 2026-08-02, and commit aac4ccd36 --
// which REMOVES endpoints, exactly what action='delete' exists to record --
// never written down. GET /api/v1/subnets/{netuid}/surface-history has been
// serving a stale latest_change_at ever since.
//
// A WORKER CRON RATHER THAN A WORKFLOW, because this repo does not run data
// lanes from GitHub Actions: a scheduled producer there races the Worker lanes
// that own the same tables, and its failures land somewhere nothing watches.
// This writes through the SAME service binding and the SAME shared-secret gate
// the scripts used, so the write path itself is unchanged.
//
// A POLL, NOT A WEBHOOK. A webhook needs repo configuration this code cannot
// assert and cannot repair; a poll is self-healing -- if a tick is missed, the
// next one still sees the same moved head. Cost is one conditional request per
// tick and nothing else: the sha is compared against KV before anything is
// fetched, so an unchanged main is a single API call.
import { recordLaneVerdict, type LaneHealthDb } from "./lane-health.ts";
import {
  buildRegistrySyncPayload,
  isEmptyPayload,
  isRegistryPath,
  type ResolvedRegistryFile,
  type Row,
} from "./registry-sync-payload.ts";
import { laneHealthStore } from "./lane-health-store.ts";

/** Where the registry lives. Not configurable: this lane exists to mirror THIS
 * repo's registry, and a wrong value would silently sync someone else's. */
const REPO = "JSONbored/metagraphed";
const KV_KEY = "registry-sync:last-synced-sha";
export const REGISTRY_SYNC_LANE = "registry-sync";
const API = "https://api.github.com";
/** Enough for a normal merge; a bulk change beyond this resyncs over several
 * ticks because the cursor only advances on success. */
const MAX_FILES_PER_TICK = 60;
const FETCH_TIMEOUT_MS = 10_000;

export interface RegistrySyncLaneResult {
  ok: boolean;
  reason?: string;
  detail?: string;
  head?: string;
  base?: string;
  files?: number;
  written?: Record<string, unknown>;
}

interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

interface ServiceLike {
  fetch(request: Request): Promise<Response>;
}

function githubHeaders(env: Record<string, unknown>): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    // GitHub rejects API requests with no user-agent.
    "user-agent": "metagraphed-registry-sync",
    "x-github-api-version": "2022-11-28",
  };
  const token = env.GITHUB_TOKEN;
  if (typeof token === "string" && token.trim() !== "") {
    headers.authorization = `Bearer ${token.trim()}`;
  }
  return headers;
}

async function ghJson(
  env: Record<string, unknown>,
  path: string,
): Promise<unknown | null> {
  try {
    const response = await fetch(`${API}${path}`, {
      headers: githubHeaders(env),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

/** One file's parsed overlay at a commit, or null when it is not there. */
async function fileAt(
  env: Record<string, unknown>,
  path: string,
  ref: string,
): Promise<Row | null> {
  const raw = await ghJson(
    env,
    `/repos/${REPO}/contents/${encodeURI(path)}?ref=${ref}`,
  );
  const content = (raw as { content?: string; encoding?: string } | null)
    ?.content;
  if (typeof content !== "string") return null;
  try {
    return JSON.parse(atob(content.replace(/\n/g, ""))) as Row;
  } catch {
    // A registry file that does not parse is a real problem, but it is the
    // Gate's problem: skipping it here keeps the rest of the commit syncable
    // rather than failing the whole tick on one bad file.
    return null;
  }
}

/**
 * One tick.
 *
 * Returns a summary rather than throwing, matching the cron family: a tick
 * that cannot run is one missed report, not an outage.
 *
 * THE CURSOR ADVANCES ONLY ON A SUCCESSFUL POST. If the sync route rejects the
 * payload, the sha stays where it was and the next tick retries the same
 * range. Advancing first would turn one failed request into a permanent hole
 * in surface_history -- which is the exact failure this lane exists to end.
 */
export async function runRegistrySyncLane(
  env: unknown,
  deps: {
    kv?: KvLike | null;
    registrySyncApi?: ServiceLike | null;
    laneHealthDb?: LaneHealthDb | null;
    now?: () => number;
  } = {},
): Promise<RegistrySyncLaneResult> {
  const result = await runRegistrySyncTick(env, deps);
  // RECORDED, ALWAYS. A lane whose outcome lives only in a returned object is
  // a lane nothing watches -- which is exactly how the thing this replaces
  // went unnoticed from 2026-08-02 until somebody read surface_history by
  // hand. The durable verdict is the point, not a nicety.
  //
  // "no new commits" is the overwhelmingly common outcome and it is `ok`: the
  // lane did its job by looking. Only a tick that could NOT do its job is
  // `stale`, which is what a watcher should act on.
  const bag = (env ?? {}) as Record<string, unknown>;
  await recordLaneVerdict(laneHealthStore(bag, deps.laneHealthDb), {
    lane: REGISTRY_SYNC_LANE,
    verdict: result.ok ? "ok" : "stale",
    age_ms: null,
    detail: laneDetail(result),
    checked_at: (deps.now ?? Date.now)(),
  });
  return result;
}

/** One line a human can act on, rather than a JSON blob in a TEXT column. */
function laneDetail(result: RegistrySyncLaneResult): string {
  if (!result.ok) {
    return result.detail
      ? `${result.reason}: ${result.detail}`
      : `${result.reason}`;
  }
  if (result.reason) return result.reason;
  const w = result.written ?? {};
  return (
    `${result.files ?? 0} file(s): ${w.subnets_written ?? 0} subnet(s), ` +
    `${w.surfaces_written ?? 0} surface(s), ${w.surfaces_deleted ?? 0} deleted`
  );
}

async function runRegistrySyncTick(
  env: unknown,
  deps: {
    kv?: KvLike | null;
    registrySyncApi?: ServiceLike | null;
  },
): Promise<RegistrySyncLaneResult> {
  const bag = (env ?? {}) as Record<string, unknown>;
  const kv = deps.kv ?? (bag.METAGRAPH_CONTROL as KvLike | undefined);
  const api =
    deps.registrySyncApi ?? (bag.REGISTRY_SYNC_API as ServiceLike | undefined);
  if (!kv?.get) return { ok: false, reason: "kv unavailable" };
  if (!api?.fetch)
    return { ok: false, reason: "registry-sync binding unavailable" };
  if (typeof bag.REGISTRY_SYNC_SECRET !== "string" || !bag.REGISTRY_SYNC_SECRET)
    return { ok: false, reason: "registry sync secret not provisioned" };

  const headCommit = await ghJson(bag, `/repos/${REPO}/commits/main`);
  const head = (headCommit as { sha?: string } | null)?.sha;
  if (typeof head !== "string" || !head)
    return { ok: false, reason: "could not resolve head" };

  const base = await kv.get(KV_KEY);
  if (base === head) return { ok: true, reason: "no new commits", head };

  // FIRST RUN HAS NO BASE, and must not guess one. Comparing against an
  // arbitrary point would either resync the entire registry or silently skip
  // everything before it; recording the head and syncing from the NEXT commit
  // costs one merge of latency once, and is the only option that cannot be
  // wrong. The scheduled full resync is what closes any pre-existing gap.
  if (!base) {
    await kv.put(KV_KEY, head);
    return { ok: true, reason: "cursor initialised", head };
  }

  const diff = await ghJson(bag, `/repos/${REPO}/compare/${base}...${head}`);
  const changed = (
    diff as { files?: { filename?: string; status?: string }[] } | null
  )?.files;
  if (!Array.isArray(changed))
    return { ok: false, reason: "could not resolve diff", base, head };

  const registryFiles = changed
    .filter((f) => typeof f.filename === "string" && isRegistryPath(f.filename))
    .slice(0, MAX_FILES_PER_TICK);
  if (registryFiles.length === 0) {
    await kv.put(KV_KEY, head);
    return { ok: true, reason: "no registry files changed", base, head };
  }

  const resolved: ResolvedRegistryFile[] = [];
  for (const file of registryFiles) {
    const path = file.filename!;
    const overlay = await fileAt(bag, path, head);
    if (overlay) {
      resolved.push({ path, overlay });
      continue;
    }
    // Gone at head. Read it at BASE to learn which netuid to delete -- the
    // path alone does not carry one, because the filename is the slug.
    const previous = await fileAt(bag, path, base);
    resolved.push({
      path,
      overlay: null,
      deletedNetuid: Number.isInteger(previous?.netuid)
        ? (previous!.netuid as number)
        : null,
    });
  }

  const payload = buildRegistrySyncPayload(resolved, head);
  if (isEmptyPayload(payload)) {
    await kv.put(KV_KEY, head);
    return {
      ok: true,
      reason: "nothing to write",
      base,
      head,
      files: resolved.length,
    };
  }

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
    return {
      ok: false,
      reason: "sync rejected",
      detail: `status ${response.status}`,
      base,
      head,
      files: resolved.length,
    };
  }
  const written = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  await kv.put(KV_KEY, head);
  return {
    ok: true,
    base,
    head,
    files: resolved.length,
    ...(written ? { written } : {}),
  };
}

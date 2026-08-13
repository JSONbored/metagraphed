// Daily link-rot capture as a Worker cron writing R2 — the same lane shape as
// github-signals-sync (#233 pattern): the cron captures, the artifact build
// projects, and freshness never depends on a bot PR landing.
//
// WHAT IT ANSWERS. Three populations of URL that the registry asserts are real
// and that NOTHING re-checked after the PR adding them merged:
//
//   #9914  777 surface source_urls — the evidence that a subnet publishes what
//          we say it publishes. A dead source_url is the exact condition that
//          auto-CLOSES a contributor PR, so leaving it unchecked after merge
//          means the bar only applies on the way in.
//   #9917  384 provider URLs — including our own gittensory entry, cited by
//          five surfaces.
//   #9907  514 surface URLs whose `kind` keeps them out of the health prober
//          -- every public_safe one, not only those carrying an uptime-probe
//          config, which had silently excluded 19 of them (#11007).
//
// 1,076 distinct URLs between them — the populations overlap heavily. See
// link-status-core.ts for why 102 of those are answered from the repo instead
// of the network, and how the remaining 974 fit one invocation's
// 1000-subrequest budget.
//
// WHAT IT DELIBERATELY DOES NOT DO. It never writes health, uptime, latency or
// incidents. A docs page has no uptime, and letting reference links into those
// artifacts would corrupt the numbers that describe live services.

import type { StorageReadResult } from "../workers/storage.ts";
import {
  checkLinks,
  collectLinkTargets,
  githubAuthHeader,
  isConfirmedDeadLink,
  linkCheckStrategy,
  nextLinkRecord,
  LINK_STATUS_MAX_CHECKS_PER_RUN,
  LINK_STATUS_R2_KEY,
  type LinkStatusArtifact,
  type LinkStatusRecord,
} from "./link-status-core.ts";
import { OPERATIONAL_SURFACE_KINDS } from "./health-probe-core.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";

type Row = Record<string, unknown>;

export const LINK_STATUS_SUBNETS_ARTIFACT_PATH = "/metagraph/subnets.json";
export const LINK_STATUS_PROVIDERS_ARTIFACT_PATH = "/metagraph/providers.json";

export { LINK_STATUS_R2_KEY };

export interface LinkStatusSyncDeps {
  readArtifact?: (env: Env, path: string) => Promise<StorageReadResult>;
  fetchImpl?: typeof fetch;
  /** Clock seam for tests; stamps checked_at/generated_at. */
  now?: () => number;
  /** Telemetry seam for tests. */
  recordException?: typeof recordExceptionEvent;
}

interface Ctx {
  waitUntil?: (promise: Promise<unknown>) => void;
}

export interface LinkStatusSyncResult {
  ok: boolean;
  reason?: string;
  skipped?: boolean;
  target_count?: number;
  checked_count?: number;
  dead_count?: number;
  changed?: boolean;
}

const OPERATIONAL_KIND_SET = new Set(OPERATIONAL_SURFACE_KINDS);

/**
 * Which URLs this tick actually spends subrequests on.
 *
 * Least-recently-checked first, so if the registry outgrows the per-run ceiling
 * the lane still cycles through everything instead of permanently starving the
 * tail. A URL never checked before sorts first (epoch 0).
 */
export function urlsForRun(
  urls: string[],
  prior: Map<string, LinkStatusRecord>,
  limit = LINK_STATUS_MAX_CHECKS_PER_RUN,
): string[] {
  if (urls.length <= limit) return urls;
  const checkedAtMs = (url: string) => {
    const at = prior.get(url)?.checked_at;
    const ms = at ? Date.parse(at) : 0;
    return Number.isFinite(ms) ? ms : 0;
  };
  return [...urls]
    .sort((a, b) => checkedAtMs(a) - checkedAtMs(b) || a.localeCompare(b))
    .slice(0, limit);
}

/**
 * The daily tick.
 *
 * Unlike github-signals, a missing GITHUB_SIGNALS_TOKEN does NOT abort the run:
 * only the 429 github.com URLs need it, and refusing to check the other ~536
 * because GitHub is unauthenticated would throw away most of the lane's value.
 * The GitHub subset is skipped for the tick and keeps its prior record — the
 * "absence of evidence is not death" rule (src/surface-verification.ts)
 * applied to our own missing credential.
 */
export async function runLinkStatusSync(
  env: Env,
  ctx?: Ctx,
  deps: LinkStatusSyncDeps = {},
): Promise<LinkStatusSyncResult> {
  if (typeof deps.readArtifact !== "function") {
    return { ok: false, reason: "reader_unavailable" };
  }
  const bucket = env.METAGRAPH_ARCHIVE;
  if (!bucket?.get || !bucket?.put) {
    return { ok: false, reason: "r2_binding_missing" };
  }

  try {
    const [subnetsRead, providersRead] = await Promise.all([
      deps.readArtifact(env, LINK_STATUS_SUBNETS_ARTIFACT_PATH),
      deps.readArtifact(env, LINK_STATUS_PROVIDERS_ARTIFACT_PATH),
    ]);
    if (!subnetsRead?.ok) {
      return { ok: false, reason: "subnets_artifact_unavailable" };
    }

    const subnets = ((subnetsRead.data as Row | null)?.subnets as Row[]) || [];
    // Providers are optional: an unreadable providers artifact costs the
    // provider population for this tick, but must not cost the other two.
    const providers = providersRead?.ok
      ? ((providersRead.data as Row | null)?.providers as Row[]) || []
      : [];
    const targets = collectLinkTargets(
      subnets,
      providers,
      OPERATIONAL_KIND_SET,
    );
    if (targets.length === 0) {
      // Zero targets from a readable artifact is a broken input, not an empty
      // registry — never let it wipe the store.
      return { ok: false, reason: "no_link_targets" };
    }

    const now = deps.now ?? Date.now;
    const checkedAt = new Date(now()).toISOString();

    const previousDoc = await readJsonObject(bucket, LINK_STATUS_R2_KEY);
    const prior = new Map<string, LinkStatusRecord>(
      (((previousDoc as Row | null)?.links as LinkStatusRecord[]) || []).map(
        (record) => [record.url, record],
      ),
    );
    const githubAuth = githubAuthHeader(env);

    // Route every target, then spend the network budget only on what is left.
    const resolved = new Map<string, LinkStatusRecord>();
    const toFetch: string[] = [];
    for (const target of targets) {
      const strategy = linkCheckStrategy(target.url);
      if (strategy === "self") {
        // Verified against the repo by the build gate, not over the network.
        continue;
      }
      if (strategy === "github-api" && !githubAuth) {
        // Unauthenticated GitHub gives Cloudflare's shared egress 60 requests
        // an hour across the whole fleet — far below the 429 needed here, so an
        // unauthenticated run would mass-"dead" every github.com link. Skipping
        // the subset keeps the other ~536 checks useful.
        continue;
      }
      toFetch.push(target.url);
    }

    const selected = urlsForRun(toFetch, prior);
    const results = await checkLinks(selected, {
      fetchImpl: deps.fetchImpl,
      githubAuth,
    });
    for (const result of results) {
      resolved.set(
        result.url,
        nextLinkRecord(prior.get(result.url), result, checkedAt),
      );
    }

    // Carry forward every URL this tick did not reach, so a skipped subset
    // never reads as a recovery (or a death) it did not earn.
    const links: LinkStatusRecord[] = [];
    for (const target of targets) {
      const record = resolved.get(target.url) ?? prior.get(target.url);
      if (record) links.push(record);
    }
    links.sort((a, b) => a.url.localeCompare(b.url));

    const artifact: LinkStatusArtifact = {
      schema_version: 1,
      generated_at: checkedAt,
      checked_count: resolved.size,
      dead_count: links.filter((record) => isConfirmedDeadLink(record)).length,
      links,
    };

    await bucket.put(LINK_STATUS_R2_KEY, JSON.stringify(artifact), {
      httpMetadata: { contentType: "application/json" },
    });
    return {
      ok: true,
      changed: true,
      target_count: targets.length,
      checked_count: artifact.checked_count,
      dead_count: artifact.dead_count,
    };
  } catch (error) {
    console.error("[link-status-sync]", String((error as Error)?.message));
    const pending = Promise.resolve(
      (deps.recordException ?? recordExceptionEvent)(env, {
        error: error as Error,
        route: "cron:link-status-sync",
        errorCode: "link_status_sync_failed",
      }),
    ).catch(() => false);
    ctx?.waitUntil?.(pending);
    return { ok: false, reason: "unreachable" };
  }
}

async function readJsonObject(
  bucket: R2Bucket,
  key: string,
): Promise<unknown | null> {
  try {
    const object = await bucket.get(key);
    return object ? await object.json() : null;
  } catch {
    // A cold or unreadable store degrades to "no prior credit", the same as a
    // first run — never to a wipe.
    return null;
  }
}

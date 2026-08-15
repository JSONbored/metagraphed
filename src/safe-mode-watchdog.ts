// Watch for SafeMode — the emergency chain pause — ever being used (#8696/#9169).
//
// WHY THIS IS A WORKER CRON, NOT A GITHUB ACTION. The check is two reads --
// one storage read against the public archive RPC and one page of indexed
// extrinsics -- neither of which needs a repository secret or a third-party
// trigger hop. It watches the CHAIN, not this Worker, so running it inside the
// Worker is not circular the way a deploy-drift or self-health check would be.
// Same move as the account-events rollup and the lakehouse seam watchdog.
//
// SafeMode is the single most consequential thing available on this runtime,
// and nothing surfaced it. #8697's audit concluded it had "never been called"
// and proposed alerting on first use. That census was run 2026-07-29 against an
// index that did not yet reach genesis (the backfill completed 2026-08-02), and
// re-running it found one call: block 4,222,830, `force_release_deposit`,
// FAILED, from an unprivileged signer.
//
// That correction is what shapes this monitor:
//
//  * It keys on SUCCESS, not on activity. The one historical call is an
//    unprivileged account being rejected — noise. A monitor whose first act is
//    to cry wolf about a three-year-old failed transaction teaches its reader
//    to ignore it. Keying on success also means the baseline is empty BY
//    CONSTRUCTION, so no magic block number has to be carried around and no
//    re-index or replay can resurface the old row through it.
//
//  * It reads STORAGE, not just history. `SafeMode.EnteredUntil` is the
//    authoritative "are we paused right now" signal, and safe mode can be
//    entered by root without a signed SafeMode extrinsic ever appearing. An
//    extrinsic-only monitor would miss exactly the case that matters most.
//
// Zero alerts is the correct steady state: it means nothing has gone wrong, not
// that the monitor is broken. The summary line prints every run for that
// reason, matching check-emission-drift.ts.
//
// ## HOW THIS MONITOR WENT BLIND, AND WHY IT STAYED THAT WAY (#10765)
//
// From 2026-08-04 to 2026-08-11 every hourly tick of this watchdog returned
// `ok:false, reason:"unreachable"`, and the single most consequential thing
// this repo watches for was not being watched. Three separate defects stacked,
// and each one alone was enough:
//
//  1. THE HISTORY READ WAS A SELF-FETCH. It asked `https://api.metagraph.sh`
//     for its extrinsics -- a custom domain of the very Worker this cron runs
//     on. Cloudflare refuses that and answers 522, every time, deterministically
//     (the same trap #10194 published a false outage with). The read now goes
//     through the in-process cold-tier loader the public route itself uses, so
//     there is no hop to refuse.
//
//  2. IT ASKED FOR MORE THAN THE ROUTE ALLOWS. `limit=200` against a route
//     whose published ceiling is 100, so even reached, it was a 400. That
//     second fault was invisible underneath the first, and fixing only the
//     522 would have swapped one deterministic failure for another.
//
//  3. AND A FAILED HISTORY READ DISCARDED THE PAUSE CHECK. This is the one
//     that matters. The storage read -- `SafeMode.EnteredUntil`, the
//     AUTHORITATIVE "are we paused right now" signal -- succeeded on every one
//     of those ticks. Its result was then thrown away, because the extrinsics
//     read threw on the next line and the whole tick fell into the catch. A
//     secondary, historical read failing must not silence the primary one, so
//     the two halves now fail independently: history that cannot be read is
//     reported as UNREAD (never as "no SafeMode activity"), and the pause
//     verdict is still computed and still alerts.
import { chainRpc } from "./chain-rpc.ts";
import { bytesToHex, storageMapPrefix } from "../src/twox-storage-key.ts";
import { loadExtrinsicFeedColdTier } from "./extrinsics-cold-tier.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";
import type { StoreEnv } from "./read-store.ts";
import type { TelemetryEnv } from "./usage-telemetry.ts";

/**
 * What this module reads from its environment, and nothing else.
 *
 * Named rather than left as `Record<string, unknown>` (#11339): a Record
 * READS as loose but is not, because `Env` is an interface and TypeScript
 * never gives interfaces implicit index signatures -- so every caller
 * holding a real `Env` wrote `env as unknown as Record<string, unknown>`
 * to get past it. Listing the keys costs nothing and states the contract.
 */
type SafeModeWatchdogEnv = StoreEnv &
  TelemetryEnv & {
    SAFE_MODE_RPC_URL?: unknown;
  };

/** Public archive RPC. A var, not a secret: the endpoint is public. */
export const SAFE_MODE_RPC_URL_DEFAULT = "https://archive.chain.opentensor.ai";

/**
 * How many SafeMode extrinsics one tick reads.
 *
 * ONE HUNDRED, matching the extrinsics route's own published ceiling rather
 * than exceeding it the way the retired HTTP call did. The set is a single row
 * historically, so the bound is not doing arithmetic -- it is there so this
 * monitor cannot become the expensive query on a table that only grows.
 *
 * NEWEST FIRST, which is what makes the truncation safe in the only direction
 * that matters: a SafeMode call made from here on lands at the top of the page,
 * so the alerting rule sees it even if the tail is cut.
 */
export const SAFE_MODE_EXTRINSIC_LIMIT = 100;

/** `SafeMode.EnteredUntil`: Option<BlockNumber>. Set iff the chain is paused. */
const ENTERED_UNTIL_KEY = bytesToHex(
  storageMapPrefix("SafeMode", "EnteredUntil"),
);

interface Extrinsic {
  block_number?: number;
  call_function?: string;
  success?: boolean;
  signer?: string | null;
}

/**
 * The whole decision, as a pure function of what was read (#8696).
 *
 * Split out so the alerting rule is testable without a chain or an API —
 * matching check-publish-freshness.ts's `evaluateFreshness`. The rule is small
 * and its edges are the entire point: a FAILED historical call must not alert,
 * and an active pause must, even with no extrinsic behind it.
 *
 * `extrinsics: null` is HISTORY WE COULD NOT READ, and it is a third state that
 * has to exist separately from the empty list (#10765). The tier declines by
 * returning null, and collapsing that into `[]` would publish `succeeded: 0` --
 * an assertion that no SafeMode call has ever landed, made by a monitor that
 * just failed to look. Every count below is therefore null in that case rather
 * than zero, and the caller reports the blind half on its own channel.
 */
export function evaluateSafeMode({
  enteredUntil,
  extrinsics,
}: {
  enteredUntil: string | null;
  extrinsics: Extrinsic[] | null;
}): { paused: boolean; reasons: string[]; summary: Record<string, unknown> } {
  // `null` is an unset key. "0x" is a present-but-empty value, which is not a
  // block number and must not read as a pause.
  //
  // COMPUTED FIRST AND UNCONDITIONALLY, because this is the authoritative
  // signal and it does not depend on the history read at all -- safe mode can
  // be entered by root with no signed extrinsic ever appearing. #10765's fault
  // was letting the other half's failure reach this one.
  const paused = typeof enteredUntil === "string" && enteredUntil !== "0x";
  const succeeded = extrinsics?.filter((x) => x.success === true) ?? null;
  const reasons: string[] = [];
  if (paused) {
    reasons.push(
      `SafeMode is ACTIVE — SafeMode.EnteredUntil is set (${enteredUntil}). The chain is paused.`,
    );
  }
  for (const x of succeeded ?? []) {
    reasons.push(
      `a SafeMode extrinsic SUCCEEDED — block ${x.block_number}, ${x.call_function}, signer ${x.signer ?? "root"}`,
    );
  }
  return {
    paused,
    reasons,
    summary: {
      chain_paused: paused,
      entered_until_raw: enteredUntil,
      /** False when the history half was blind this tick. The pause verdict
       * beside it is still trustworthy; these three counts are not. */
      history_read: extrinsics !== null,
      safe_mode_extrinsics: extrinsics?.length ?? null,
      succeeded: succeeded?.length ?? null,
      // Recorded so a reader can see the monitor is looking at real data
      // rather than an empty response, and so the known historical failure is
      // visible WITHOUT being alerted on.
      known_failed:
        extrinsics
          ?.filter((x) => x.success === false)
          .map((x) => `${x.block_number}:${x.call_function}`) ?? null,
    },
  };
}

type Fetcher = typeof fetch;

/** Its own timeout is the one thing this lane did differently, so it is the one
 * thing passed through: everything else came from the shared client (#11194). */
const RPC_TIMEOUT_MS = 20_000;

async function rpc(
  url: string,
  method: string,
  params: unknown[],
  doFetch: Fetcher,
): Promise<unknown> {
  return chainRpc(url, method, params, {
    fetchImpl: doFetch as typeof fetch,
    timeoutMs: RPC_TIMEOUT_MS,
  });
}

/** Reads the SafeMode extrinsic history, or null when the tier declined. */
export type SafeModeExtrinsicReader = (
  env: SafeModeWatchdogEnv | null | undefined,
) => Promise<Extrinsic[] | null>;

/**
 * Every indexed SafeMode extrinsic. Small by construction -- one, historically.
 *
 * IN PROCESS, NOT OVER HTTP (#10765). This used to fetch our own public API,
 * which is a custom domain of the Worker the cron runs on: Cloudflare refuses
 * that self-fetch with a 522 and it never once succeeded. The cold-tier loader
 * below is the exact reader `handleExtrinsics` falls through to, so this asks
 * the same tier the same question with no hop to refuse and no route-level
 * `limit` ceiling to trip over.
 *
 * NULL IS A DECLINE, NOT AN ANSWER. `loadExtrinsicFeedColdTier` returns null
 * when it cannot express the query safely or the lakehouse will not serve it --
 * the same distinction the retired envelope check was reaching for when it
 * refused a `ok:false` body. An empty feed, by contrast, IS an answer: it says
 * the decoded range holds no SafeMode call.
 */
export const readSafeModeExtrinsics: SafeModeExtrinsicReader = async (env) => {
  const feed = await loadExtrinsicFeedColdTier(env, {
    limit: SAFE_MODE_EXTRINSIC_LIMIT,
    module: "SafeMode",
  });
  if (feed === null) return null;
  return (feed.extrinsics ?? []) as Extrinsic[];
};

/**
 * One watchdog tick.
 *
 * Returns a summary rather than throwing, matching runFreshnessWatchdog: a tick
 * that cannot run is one missed report, not an outage, and a cron that throws is
 * a cron nobody can read the result of. `fetchImpl` is injectable so both the
 * measured and the failed path are testable without a chain.
 */
export async function runSafeModeWatchdog(
  env: SafeModeWatchdogEnv | null | undefined,
  deps: {
    fetchImpl?: Fetcher;
    readExtrinsics?: SafeModeExtrinsicReader;
    recordExceptionEvent?: typeof recordExceptionEvent;
  } = {},
): Promise<Record<string, unknown>> {
  const doFetch = deps.fetchImpl ?? fetch;
  const readExtrinsics = deps.readExtrinsics ?? readSafeModeExtrinsics;
  const record = deps.recordExceptionEvent ?? recordExceptionEvent;
  const rpcUrl = String(env?.SAFE_MODE_RPC_URL || SAFE_MODE_RPC_URL_DEFAULT);
  try {
    // THE PRIMARY READ, and the only one whose failure makes the whole tick
    // unreachable: without it there is no answer to "are we paused right now",
    // which is what this monitor is for.
    const entered = (await rpc(
      rpcUrl,
      "state_getStorage",
      [ENTERED_UNTIL_KEY],
      doFetch,
    )) as string | null;
    // THE SECONDARY READ, isolated (#10765). Its failure costs the history
    // half and nothing else -- for a week it cost the pause check too, because
    // a throw here landed in the catch below and the verdict was never
    // computed. A null from the reader and a throw from it mean the same thing
    // to the rule, so both arrive as null.
    let extrinsics: Extrinsic[] | null = null;
    let historyError: unknown = null;
    try {
      extrinsics = await readExtrinsics(env);
    } catch (err) {
      historyError = err;
    }
    const { reasons, summary } = evaluateSafeMode({
      enteredUntil: entered,
      extrinsics,
    });
    // #9440: this watchdog reported on NO channel at all. It computed
    // `reasons` correctly and returned them to handleScheduled, whose return
    // value workers/api.entry.ts discards -- so the chain entering SafeMode,
    // the single most consequential event this repo watches for, was detected
    // every tick and told to nobody.
    //
    // Notification only, deliberately no lane_health row: that table backs the
    // PUBLIC self-health card, whose vocabulary is ok/stale/unknown and whose
    // consumers read a non-ok lane as "our data is behind". SafeMode is a
    // CHAIN condition, not a staleness of ours -- filing it as a stale lane
    // would publish a false statement about our own freshness.
    if (reasons.length > 0) {
      await record(env, {
        error: new Error(`SafeMode watchdog: ${reasons.join(", ")}`),
        route: "watchdog:safe-mode",
        // fingerprintDetail (#10813). This route reports TWO independent
        // subjects: the chain being paused, and this monitor's own read failing.
        // Both fingerprinted `watchdog:safe-mode:Error`, which is also the storm
        // guard's throttle key -- so a `safe_mode_active`, the single condition
        // this watchdog exists to report, could be dropped as a repeat of a
        // routine `extrinsics: HTTP 522` that fired minutes earlier. Measured
        // 2026-08-11: 16 `watchdog_unreachable` captures in four days, every one
        // of them holding that window open. Same fix #10673 made for lane-alarm,
        // for the same reason.
        fingerprintDetail: "safe_mode_active",
        errorCode: "safe_mode_active",
      }).catch(() => false);
    }
    // A BLIND HALF IS STILL REPORTED, on the monitor's own channel rather than
    // the chain's. It carries `watchdog_unreachable` and not `safe_mode_active`
    // because nothing about the chain has been observed here -- and it is
    // reported at all because "the history read has been failing for a week"
    // is exactly the fact that went unnoticed while the 522 ran.
    if (extrinsics === null) {
      await record(env, {
        error:
          historyError ??
          new Error("SafeMode history: the extrinsics tier declined the read"),
        route: "watchdog:safe-mode",
        // See above: the two subjects must not share a throttle window.
        fingerprintDetail: "watchdog_unreachable",
        errorCode: "watchdog_unreachable",
      }).catch(() => false);
    }
    return {
      // `ok` describes whether the TICK ran, not whether SafeMode is quiet.
      // The PAUSE check ran whenever this is true, even on a blind history
      // half -- `history_read` in the summary is what says which.
      ok: true,
      alerted: reasons.length > 0,
      reasons,
      ...summary,
    };
  } catch (err) {
    // A tick that cannot run is one missed report -- but an UNREACHABLE
    // SafeMode monitor is itself worth reporting, because its silence is
    // indistinguishable from "the chain is fine". That equivalence is the
    // whole reason this monitor exists.
    await record(env, {
      error: err,
      route: "watchdog:safe-mode",
      // See above: the two subjects must not share a throttle window.
      fingerprintDetail: "watchdog_unreachable",
      errorCode: "watchdog_unreachable",
    }).catch(() => false);
    return {
      ok: false,
      reason: "unreachable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

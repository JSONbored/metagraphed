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
import { bytesToHex, storageMapPrefix } from "../src/twox-storage-key.ts";
import { recordExceptionEvent } from "./usage-telemetry.ts";

/** Public archive RPC. A var, not a secret: the endpoint is public. */
export const SAFE_MODE_RPC_URL_DEFAULT = "https://archive.chain.opentensor.ai";
export const SAFE_MODE_API_BASE_DEFAULT = "https://api.metagraph.sh";

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
 */
export function evaluateSafeMode({
  enteredUntil,
  extrinsics,
}: {
  enteredUntil: string | null;
  extrinsics: Extrinsic[];
}): { paused: boolean; reasons: string[]; summary: Record<string, unknown> } {
  // `null` is an unset key. "0x" is a present-but-empty value, which is not a
  // block number and must not read as a pause.
  const paused = typeof enteredUntil === "string" && enteredUntil !== "0x";
  const succeeded = extrinsics.filter((x) => x.success === true);
  const reasons: string[] = [];
  if (paused) {
    reasons.push(
      `SafeMode is ACTIVE — SafeMode.EnteredUntil is set (${enteredUntil}). The chain is paused.`,
    );
  }
  for (const x of succeeded) {
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
      safe_mode_extrinsics: extrinsics.length,
      succeeded: succeeded.length,
      // Recorded so a reader can see the monitor is looking at real data
      // rather than an empty response, and so the known historical failure is
      // visible WITHOUT being alerted on.
      known_failed: extrinsics
        .filter((x) => x.success === false)
        .map((x) => `${x.block_number}:${x.call_function}`),
    },
  };
}

type Fetcher = typeof fetch;

async function rpc(
  url: string,
  method: string,
  params: unknown[],
  doFetch: Fetcher,
): Promise<unknown> {
  const res = await doFetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

/** Every indexed SafeMode extrinsic. Small by construction -- one, historically. */
async function safeModeExtrinsics(
  base: string,
  doFetch: Fetcher,
): Promise<Extrinsic[]> {
  const res = await doFetch(
    `${base}/api/v1/extrinsics?call_module=SafeMode&limit=200`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!res.ok) throw new Error(`extrinsics: HTTP ${res.status}`);
  const body = (await res.json()) as {
    ok?: boolean;
    data?: { extrinsics?: Extrinsic[] };
  };
  // A degraded tier answers with a well-formed empty list (#9110/#9114), which
  // would read here as "no SafeMode activity" -- the exact false negative this
  // monitor must not produce. Treat it as an error, not as an answer.
  if (body.ok !== true) throw new Error("extrinsics: not an ok envelope");
  return body.data?.extrinsics ?? [];
}

/**
 * One watchdog tick.
 *
 * Returns a summary rather than throwing, matching runFreshnessWatchdog: a tick
 * that cannot run is one missed report, not an outage, and a cron that throws is
 * a cron nobody can read the result of. `fetchImpl` is injectable so both the
 * measured and the failed path are testable without a chain.
 */
export async function runSafeModeWatchdog(
  env: Record<string, unknown> | null | undefined,
  deps: {
    fetchImpl?: Fetcher;
    recordExceptionEvent?: typeof recordExceptionEvent;
  } = {},
): Promise<Record<string, unknown>> {
  const doFetch = deps.fetchImpl ?? fetch;
  const record = deps.recordExceptionEvent ?? recordExceptionEvent;
  const rpcUrl = String(env?.SAFE_MODE_RPC_URL || SAFE_MODE_RPC_URL_DEFAULT);
  const apiBase = String(env?.SAFE_MODE_API_BASE || SAFE_MODE_API_BASE_DEFAULT);
  try {
    const entered = (await rpc(
      rpcUrl,
      "state_getStorage",
      [ENTERED_UNTIL_KEY],
      doFetch,
    )) as string | null;
    const extrinsics = await safeModeExtrinsics(apiBase, doFetch);
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
      await record(env as never, {
        error: new Error(`SafeMode watchdog: ${reasons.join(", ")}`),
        route: "watchdog:safe-mode",
        errorCode: "safe_mode_active",
      }).catch(() => false);
    }
    return {
      // `ok` describes whether the TICK ran, not whether SafeMode is quiet.
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
    await record(env as never, {
      error: err,
      route: "watchdog:safe-mode",
      errorCode: "watchdog_unreachable",
    }).catch(() => false);
    return {
      ok: false,
      reason: "unreachable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

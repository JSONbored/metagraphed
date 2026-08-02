// Watch for SafeMode — the emergency chain pause — ever being used (#8696).
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
import { fileURLToPath } from "node:url";
import { bytesToHex, storageMapPrefix } from "../src/twox-storage-key.ts";

const RPC_URL =
  process.env.SAFE_MODE_RPC_URL || "https://archive.chain.opentensor.ai";
const API_BASE = process.env.SAFE_MODE_API_BASE || "https://api.metagraph.sh";

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

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC_URL, {
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

/** Every indexed SafeMode extrinsic. Small by construction — one, historically. */
async function safeModeExtrinsics(): Promise<Extrinsic[]> {
  const res = await fetch(
    `${API_BASE}/api/v1/extrinsics?call_module=SafeMode&limit=200`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!res.ok) throw new Error(`extrinsics: HTTP ${res.status}`);
  const body = (await res.json()) as {
    ok?: boolean;
    data?: { extrinsics?: Extrinsic[] };
  };
  // A degraded tier answers with a well-formed empty list (#9110/#9114), which
  // would read here as "no SafeMode activity" — the exact false-negative this
  // monitor must not produce. Treat it as an error, not as an answer.
  if (body.ok !== true) throw new Error("extrinsics: not an ok envelope");
  return body.data?.extrinsics ?? [];
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

async function main(): Promise<void> {
  const entered = (await rpc("state_getStorage", [ENTERED_UNTIL_KEY])) as
    string | null;
  const extrinsics = await safeModeExtrinsics();
  const { reasons, summary } = evaluateSafeMode({
    enteredUntil: entered,
    extrinsics,
  });
  console.log(JSON.stringify(summary, null, 2));

  if (reasons.length === 0) {
    console.log(
      "OK: SafeMode has never been successfully used and is not active.",
    );
    return;
  }

  for (const reason of reasons) console.error(`ALERT: ${reason}`);

  // Same optional-webhook convention as check-emission-drift.ts: quietly
  // no-ops when unset rather than failing the run.
  const webhook = process.env.LIVE_ALERT_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          content:
            `🚨 metagraphed: SafeMode activity on finney.\n` +
            reasons.map((r) => `• ${r}`).join("\n") +
            `\nSafeMode is the emergency chain pause. This has never ` +
            `successfully happened before, so treat it as real until proven ` +
            `otherwise (#8696).`,
        }),
      });
    } catch (err) {
      console.error(
        `alert webhook failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Non-zero exit so the workflow records a failure -- a monitor whose alerts
  // only go to a webhook is invisible when the webhook is misconfigured.
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

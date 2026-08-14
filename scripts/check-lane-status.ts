// Did every lakehouse PRODUCER finish a pass recently enough?
// (JSONbored/metagraphed-infra#571)
//
// ## What this is for
//
// `scripts/check-lakehouse-freshness.ts` watches lakehouse TABLES -- did a
// snapshot arrive. This watches the LANES that write them, and the two are not
// the same question: a lane can die while the tables it does not own stay
// fresh, and a lane that writes no Iceberg table at all is invisible to the
// other check entirely.
//
// The account-summary projection is the case that forced this. Its producer was
// SIGKILLed on every pass from 2026-08-14 15:07Z onward, and nothing said so.
// `/api/v1/accounts/{ss58}` silently returned to the lakehouse read it used
// before the projection existed -- correct, and ~30,000x more expensive: 4,374
// MB scanned per request instead of a ~36 KB GET. There is no error, no
// degraded header and no failed check; the only symptom is one route's latency
// drifting back to 5-18s, which is exactly the shape of thing that goes
// unnoticed for weeks.
//
// Two sibling lanes had the same hole already: `account-events-rollup-status`
// and `rpc-usage-export-status` have been written every hour for months with
// nothing ever reading them. That is why this sweeps the status objects as a
// FAMILY rather than adding an alarm for one lane.
//
// ## Why the STATUS OBJECT and not the data
//
// Each lane already publishes its own verdict, precisely because a container
// lane's stderr reaches nobody. The object is the report; this is the reader it
// never had. Asking the lane's OUTPUT instead ("is account_events_daily fresh")
// answers a different question -- a lane can fail after its last successful
// append and leave the table looking fine.
//
// ## A KILLED lane does not look like a lane that never ran
//
// This is the distinction the whole check turns on. `checked_at` is written
// only on COMPLETION, and the mid-scan heartbeat overwrites the whole object.
// So a SIGKILLed pass leaves `{phase: "scanning", started_at: ...}` with NO
// `checked_at` at all -- not a stale timestamp, an absent one. Treating that as
// "never ran, nothing to say" is how the outage above stayed quiet, so it is
// reported as its own failure with the phase and start time it died at.
//
// ## Every status object must be CLASSIFIED
//
// The bucket is listed and any `*-status.json` missing from `EXPECTED_LANES`
// FAILS, exactly as an unclassified table does on the lakehouse side. Absent
// means nobody has thought about it; `maxAgeMs: null` with a reason means
// somebody decided it cannot go stale. The two are different facts and only one
// of them is safe -- and a new lane added in the private repo is precisely the
// thing that would otherwise arrive here unwatched.
import { fileURLToPath } from "node:url";

import { r2ApiBaseUrl, r2ObjectUrl } from "./r2-rest.ts";

const BUCKET = process.env.R2_ARTIFACTS_BUCKET ?? "metagraphed-artifacts";
export const PREFIX = "metagraph/lakehouse/";

/** The lane name a verdict line opens with, which every detail string starts with. */
function laneOf(detail: string): string {
  return detail.split(" ")[0] ?? "";
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * How a producer stamps its own verdict.
 *
 * Two shapes exist and neither is going to be talked into the other: the python
 * lanes write `{checked_at, ok}` from a `finally`, while the decoder writes
 * `{updated_at, status}` through `iceberg_r2.py`'s shared writer. Reading one
 * shape's fields out of the other yields `undefined`, which would evaluate as
 * "no completion recorded" and make every decode run look dead.
 */
export type LaneShape = "checked_at" | "updated_at";

export interface LaneRule {
  /** How old the newest COMPLETED pass may be, or null when staleness is meaningless. */
  maxAgeMs: number | null;
  /** Why this bound, in the producer's own terms. */
  reason: string;
  shape: LaneShape;
}

/**
 * Every lane status object under `metagraph/lakehouse/`, and how stale each may be.
 *
 * BOUNDS ARE MISSED TICKS, not wall-clock guesses -- the reasoning
 * `missedTicksMs` gives the Neon watchdogs and `check-lakehouse-freshness`
 * gives the tables. A bound near one producer interval alerts on a lane that is
 * merely working, and a watchdog people learn to ignore is worse than none.
 *
 * The decode container's cron is `17 * * * *`, and every lane in
 * `entrypoint-decode-r2.sh` writes its status on EVERY tick -- including the
 * ticks where it decides it has nothing to do, which is why a skip is not a
 * silence here. Six hours is six missed ticks, matching the bound the lakehouse
 * check already gives the decoder's own tables.
 *
 * `account-summary` is the exception, and deliberately: it is gated by a 20-hour
 * floor and A SKIP DOES NOT REPUBLISH, so its `checked_at` advances about once a
 * day rather than hourly.
 */
export const EXPECTED_LANES: Readonly<Record<string, LaneRule>> = {
  "decode-run-status.json": {
    maxAgeMs: 6 * HOUR,
    shape: "updated_at",
    reason: "the decoder itself, hourly on the :17 tick",
  },
  // TESTNET IS A SERVED NETWORK. `check-lakehouse-freshness` had to widen to
  // `chain_testnet` for the same reason -- a stalled testnet decode would
  // otherwise be invisible while the mainnet lane kept this green.
  "testnet/decode-run-status.json": {
    maxAgeMs: 6 * HOUR,
    shape: "updated_at",
    reason: "the testnet decoder, same hourly tick",
  },
  "state-mirror-status.json": {
    maxAgeMs: 6 * HOUR,
    shape: "checked_at",
    reason: "state_mirror_r2.py, every decode tick",
  },
  "account-events-rollup-status.json": {
    maxAgeMs: 6 * HOUR,
    shape: "checked_at",
    reason: "account_events_rollup_r2.py, every decode tick",
  },
  "daily-rollup-status.json": {
    maxAgeMs: 6 * HOUR,
    shape: "checked_at",
    reason: "daily_rollup_r2.py export+reconcile, every decode tick",
  },
  "rpc-usage-export-status.json": {
    maxAgeMs: 6 * HOUR,
    shape: "checked_at",
    reason: "rpc_usage_export_r2.py, every decode tick",
  },
  "account-summary-status.json": {
    // TWO DAYS, and the number is chosen against the READER rather than the
    // producer alone. `ACCOUNT_SUMMARY_MAX_AGE_MS` is three days: past it the
    // route stops trusting the projection and silently pays the old 4,374 MB
    // scan again. Alerting at two days means the lane is reported dead a full
    // day BEFORE the surface it protects quietly regresses, which is the only
    // bound that makes this check worth running.
    maxAgeMs: 2 * DAY,
    shape: "checked_at",
    reason:
      "account_summary_r2.py, 20h floor and a skip does not republish; " +
      "fires one day before the reader's 3d trust bound expires",
  },
};

/**
 * Lanes known to be failing right now, so a NEW one still stands out.
 *
 * Same discipline as `KNOWN_FROZEN` on the lakehouse side: the entry records an
 * outage that is already tracked, and the sweep reports a lane that LEAVES this
 * set so the baseline has to shrink. A baseline that is only ever added to
 * becomes a way of not looking.
 */
export const KNOWN_STALE: Readonly<Record<string, string>> = {
  "account-summary-status.json":
    "SIGKILLed inside window 20 of 21 on every pass since 2026-08-14 15:07Z; " +
    "metagraphed-infra#570 moves it to its own sized container class",
};

export interface LaneReading {
  lane: string;
  /** The parsed status object, or null when it could not be read or parsed. */
  body: Record<string, unknown> | null;
  nowMs: number;
}

function parseStamp(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function age(ms: number): string {
  const hours = ms / HOUR;
  return hours < 48 ? `${hours.toFixed(1)}h` : `${(ms / DAY).toFixed(1)}d`;
}

/**
 * The verdict for one lane, as a pure function so the rule is testable without
 * a bucket.
 *
 * `ok: false` is checked BEFORE staleness on purpose. A lane that ran on time
 * and failed is a different fault from one that stopped running, and reporting
 * the fresh timestamp first would describe a broken lane as healthy.
 */
export function evaluate(
  reading: LaneReading,
  rule: LaneRule | undefined,
): { ok: boolean; detail: string } {
  const { lane, body, nowMs } = reading;
  if (!rule) {
    return {
      ok: false,
      detail: `${lane} is not classified in EXPECTED_LANES -- add a bound, or an explicit null with a reason`,
    };
  }
  if (rule.maxAgeMs === null) {
    return { ok: true, detail: `${lane}: exempt (${rule.reason})` };
  }
  if (body === null) {
    return {
      ok: false,
      detail: `${lane} could not be read or parsed (${rule.reason})`,
    };
  }

  if (rule.shape === "updated_at") {
    const status = body["status"];
    const stamp = parseStamp(body["updated_at"]);
    if (stamp === null) {
      return {
        ok: false,
        detail: `${lane} has no usable updated_at (${rule.reason})`,
      };
    }
    if (status !== "ok") {
      return {
        ok: false,
        detail: `${lane} reports status=${JSON.stringify(status)} as of ${age(nowMs - stamp)} ago (${rule.reason})`,
      };
    }
    if (nowMs - stamp > rule.maxAgeMs) {
      return {
        ok: false,
        detail: `${lane} last updated ${age(nowMs - stamp)} ago, over its ${age(rule.maxAgeMs)} bound (${rule.reason})`,
      };
    }
    return { ok: true, detail: `${lane}: ${age(nowMs - stamp)}` };
  }

  // A COMPLETED pass sets `ok`; a killed one leaves the heartbeat's `ok: null`
  // behind. `=== false` rather than a truthiness test keeps those apart, so an
  // interrupted run is reported as interrupted below rather than as a failure
  // the lane actually recorded.
  if (body["ok"] === false) {
    const failures = body["failures"];
    const why =
      failures && typeof failures === "object"
        ? ` -- ${JSON.stringify(failures).slice(0, 200)}`
        : "";
    return {
      ok: false,
      detail: `${lane} reported ok:false on its last pass${why} (${rule.reason})`,
    };
  }

  const completed = parseStamp(body["checked_at"]);
  if (completed === null) {
    // THE KILLED CASE, and the reason this check exists. `checked_at` is
    // written only on completion and the mid-scan heartbeat overwrites the
    // whole object, so its absence means the last thing that happened was a
    // start that never finished -- reported with what the lane managed to say
    // before it died.
    const started = parseStamp(body["started_at"]);
    const phase = body["phase"];
    const where =
      typeof body["window"] === "string" ? `, window ${body["window"]}` : "";
    if (started !== null) {
      return {
        ok: false,
        detail:
          `${lane} STARTED ${age(nowMs - started)} ago and never completed ` +
          `(phase=${JSON.stringify(phase)}${where}) (${rule.reason})`,
      };
    }
    return {
      ok: false,
      detail: `${lane} records no completed pass at all (${rule.reason})`,
    };
  }
  if (nowMs - completed > rule.maxAgeMs) {
    return {
      ok: false,
      detail: `${lane} last completed ${age(nowMs - completed)} ago, over its ${age(rule.maxAgeMs)} bound (${rule.reason})`,
    };
  }
  return { ok: true, detail: `${lane}: ${age(nowMs - completed)}` };
}

/**
 * Status object keys under the prefix, as lane names relative to it.
 *
 * Only `*-status.json`: the prefix also holds `decode-watermark.json` and
 * `decode-gaps.json`, which are lane STATE rather than a verdict and have no
 * freshness meaning of their own.
 */
export function laneNamesFrom(keys: readonly string[]): string[] {
  return keys
    .filter((k) => k.startsWith(PREFIX) && k.endsWith("-status.json"))
    .map((k) => k.slice(PREFIX.length))
    .sort((a, b) => a.localeCompare(b));
}

async function listLaneKeys(
  accountId: string,
  apiToken: string,
): Promise<string[]> {
  const url =
    `${r2ApiBaseUrl()}/accounts/${accountId}/r2/buckets/${BUCKET}/objects` +
    `?prefix=${encodeURIComponent(PREFIX)}&per_page=1000`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiToken}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`listing ${BUCKET}/${PREFIX} failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as {
    success?: boolean;
    result?: { key?: string }[];
  };
  if (!body.success)
    throw new Error(`listing ${BUCKET}/${PREFIX} returned success:false`);
  return (body.result ?? []).map((o) => o.key ?? "").filter(Boolean);
}

async function readLane(
  accountId: string,
  apiToken: string,
  lane: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(
      r2ObjectUrl(accountId, BUCKET, `${PREFIX}${lane}`),
      {
        headers: { Authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  if (!accountId || !apiToken) {
    // Loud, not skipped: a watchdog that quietly passes without credentials is
    // the "gate that cannot fail" this repo has been bitten by before.
    process.stderr.write(
      "CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required -- this reads live R2.\n",
    );
    process.exit(1);
  }

  const keys = await listLaneKeys(accountId, apiToken);
  const lanes = laneNamesFrom(keys);
  if (lanes.length === 0) {
    // An empty listing is not "every lane is fine". Something is wrong with the
    // prefix, the bucket or the token, and passing on it would be the same
    // silent no-op this check exists to end.
    process.stderr.write(
      `lane-status: NO status objects found under ${PREFIX} -- wrong bucket, prefix or token?\n`,
    );
    process.exit(1);
  }

  // A DECLARED LANE THAT VANISHED is a failure too. The listing drives the
  // sweep, so a lane whose object was deleted would otherwise simply stop being
  // checked -- the quietest possible way for a producer to disappear.
  const seen = new Set(lanes);
  const missing = Object.keys(EXPECTED_LANES).filter((l) => !seen.has(l));

  const nowMs = Date.now();
  const failures: string[] = [];
  const lines: string[] = [];
  for (const lane of lanes) {
    const rule = EXPECTED_LANES[lane];
    const body = rule ? await readLane(accountId, apiToken, lane) : null;
    const verdict = evaluate({ lane, body, nowMs }, rule);
    lines.push(`${verdict.ok ? "ok   " : "STALE"} ${verdict.detail}`);
    if (!verdict.ok) failures.push(verdict.detail);
  }
  for (const lane of missing) {
    const detail = `${lane} is declared in EXPECTED_LANES but no longer exists in the bucket`;
    lines.push(`STALE ${detail}`);
    failures.push(detail);
  }
  process.stdout.write(lines.join("\n") + "\n");

  const failed = new Set(failures.map(laneOf));
  const baseline = Object.keys(KNOWN_STALE);
  const recovered = baseline.filter((l) => seen.has(l) && !failed.has(l));
  // PARENTHESISED, and it matters: `a ?? "" in KNOWN_STALE` parses as
  // `a ?? ("" in KNOWN_STALE)` because `in` binds tighter than `??`, which
  // yields the lane name, negates to false, and leaves `regressions` empty
  // forever -- a watchdog that can only ever report "0 NEW".
  const regressions = failures.filter(
    (f) => !Object.hasOwn(KNOWN_STALE, laneOf(f)),
  );

  process.stdout.write(
    `\nlane-status: ${failures.length} failing of ${lanes.length} -- ` +
      `${failures.length - regressions.length} known (baseline ${baseline.length}), ` +
      `${regressions.length} NEW, ${recovered.length} recovered.\n`,
  );
  if (recovered.length > 0) {
    process.stderr.write(
      "\nRECOVERED -- delete these from KNOWN_STALE so the baseline keeps shrinking:\n" +
        recovered.map((l) => `  ${l}`).join("\n") +
        "\n",
    );
  }
  if (regressions.length === 0 && recovered.length === 0) return;

  const webhook = process.env.LIVE_ALERT_WEBHOOK_URL;
  if (webhook && regressions.length > 0) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          content:
            `⚠️ metagraphed: ${regressions.length} lakehouse lane(s) NEWLY dead or failing.\n` +
            regressions
              .slice(0, 10)
              .map((f) => `• ${f}`)
              .join("\n") +
            `\nA dead lane throws no error -- the routes it feeds fall back and just get slower (infra#571).`,
        }),
      });
    } catch (err) {
      process.stderr.write(
        `alert webhook failed: ${err instanceof Error ? err.message : err}\n`,
      );
    }
  }
  process.stderr.write(
    `\nlane-status: ${failures.length} of ${lanes.length} lane(s) FAILING.\n`,
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();

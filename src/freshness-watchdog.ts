// Freshness watchdog — the one alarm that survives the boxes.
//
// WHY THIS EXISTS. Every alerting mechanism this project had lived on the
// indexer box (Prometheus/Alertmanager, alertmanager-discord, and a cross-box
// dead-man's-switch where each box watched its peers). All of it dies with the
// box, and none of it ports: there are no peers left to watch each other. What
// replaces it has to be able to answer one question from the edge — "is the data
// still moving?" — because a serverless stack that has silently stopped
// ingesting serves a perfectly healthy-looking 200 from stale artifacts. That
// failure is invisible to an uptime check by construction.
//
// WHY FRESHNESS IS THE RIGHT SIGNAL. The freshness artifact already carries each
// source's OWN staleness policy (`stale_after_hours` plus a `stale_behavior` of
// "block" or "warn") and whether it is `required_for_publish`. So this watchdog
// invents no thresholds and owns no config — it enforces the contract the data
// already declares about itself. When a publish lane stalls, its sources age out
// against their own stated limits and this notices, whatever the cause.
//
// This is deliberately NOT a second health system: it reads one artifact the
// build already writes, and reports. It has no opinion about what to do next.

export interface FreshnessSource {
  id?: unknown;
  lane?: unknown;
  timestamp?: unknown;
  as_of?: unknown;
  stale_after_hours?: unknown;
  stale_behavior?: unknown;
  required_for_publish?: unknown;
}

export interface StaleSource {
  id: string;
  lane: string;
  behavior: string;
  ageHours: number;
  limitHours: number;
  required: boolean;
}

export interface FreshnessVerdict {
  checked: number;
  skipped: number;
  stale: StaleSource[];
  // "block" + required_for_publish. Separated because these are the ones that
  // mean the publish pipeline itself is broken, not that one optional adapter
  // is behind -- 65 warn-level adapters aging out together is a different
  // (and less urgent) event than one required source blocking a publish.
  critical: StaleSource[];
  signature: string;
}

const HOUR_MS = 3_600_000;

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value ? value : fallback;
}

// The artifact carries both `timestamp` and `as_of`; prefer `timestamp` (the
// source's own stamp) and fall back to `as_of` (when it was captured), matching
// how the freshness route itself presents them.
function parseStamp(source: FreshnessSource): number | null {
  for (const raw of [source.timestamp, source.as_of]) {
    if (typeof raw !== "string" || !raw) continue;
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

/**
 * Compare every source against the staleness limit it declares for itself.
 *
 * A source with no parseable stamp or no positive limit is SKIPPED, not treated
 * as stale: "this source does not declare a freshness policy" and "this source
 * has gone quiet" are different statements, and reporting the first as the
 * second would bury real stalls under permanent noise from sources that were
 * never time-bounded to begin with.
 */
export function evaluateFreshness(
  sources: unknown,
  nowMs: number,
): FreshnessVerdict {
  const list: FreshnessSource[] = Array.isArray(sources)
    ? (sources as FreshnessSource[])
    : [];
  const stale: StaleSource[] = [];
  let skipped = 0;

  for (const source of list) {
    const limitHours = Number(source?.stale_after_hours);
    const stampMs = parseStamp(source ?? {});
    if (!Number.isFinite(limitHours) || limitHours <= 0 || stampMs === null) {
      skipped += 1;
      continue;
    }
    const ageHours = (nowMs - stampMs) / HOUR_MS;
    if (ageHours <= limitHours) continue;
    stale.push({
      id: str(source.id, "unknown"),
      lane: str(source.lane, "unknown"),
      behavior: str(source.stale_behavior, "warn"),
      // One decimal is all anyone reads off an alert, and rounding keeps the
      // signature below stable across ticks instead of churning every second.
      ageHours: Math.round(ageHours * 10) / 10,
      limitHours,
      required: source.required_for_publish === true,
    });
  }

  stale.sort((a, b) => b.ageHours - a.ageHours || a.id.localeCompare(b.id));
  const critical = stale.filter((s) => s.behavior === "block" && s.required);

  return {
    checked: list.length - skipped,
    skipped,
    stale,
    critical,
    // Identity of the CONDITION, not of this tick: which sources are stale and
    // at what severity, with the ages left out so a standing outage keeps one
    // stable signature as it ages. See shouldReport.
    signature: stale
      .map((s) => `${s.id}:${s.behavior}${s.required ? ":req" : ""}`)
      .sort()
      .join(","),
  };
}

/**
 * Decide whether this verdict is worth saying out loud.
 *
 * Quiet when healthy, and quiet when nothing has CHANGED. The abuse scan's
 * comment in workers/api.ts already states the rule this follows: a job that
 * re-reports the same standing set every tick trains whoever watches the channel
 * to ignore it, at which point the alarm is worse than none. So a stall is
 * announced when it starts, when its membership changes, and when it clears --
 * not once an hour forever.
 */
export function shouldReport(
  verdict: FreshnessVerdict,
  lastSignature: string | null,
): boolean {
  const previous = lastSignature ?? "";
  if (verdict.signature === previous) return false;
  // Recovery is worth saying precisely once: previously stale, now clean.
  if (!verdict.signature) return previous !== "";
  return true;
}

import { fileURLToPath } from "node:url";

// Scheduled staleness alarm for the published registry (#8286).
//
// The publish pipeline was stale for four days in July 2026 and nobody knew:
// it was found by a UI audit noticing "snapshot 4d ago" banners, not by an
// alert. That mattered twice over -- the staleness also HID a second bug,
// because the KV pointer only moves on a publish that completes, so four days
// of no completed publishes meant four days of not knowing the pointer was
// broken (#8276).
//
// This reads the SAME freshness signal a visitor sees -- meta.published_at on
// the live public API -- rather than an internal build stamp, so the check
// cannot pass while the public surface is stale.

const DEFAULT_API_BASE = "https://api.metagraph.sh";
// The publish runs daily (publish-cloudflare.yml: cron "17 7 * * *"), so 2x the
// cadence is 48h. One missed run is not yet an incident -- two is.
const DEFAULT_MAX_AGE_HOURS = 48;
const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10_000;

export type FreshnessVerdict =
  | { status: "fresh"; ageMs: number; publishedAt: string }
  | { status: "stale"; ageMs: number; publishedAt: string; maxAgeMs: number }
  | { status: "unknown"; reason: string };

/**
 * Pure threshold decision, split out from any I/O so the boundary behaviour is
 * directly testable. Age exactly at the threshold is FRESH: a publish that
 * lands right on the limit is on time, not late.
 */
export function evaluateFreshness({
  publishedAt,
  now,
  maxAgeMs,
}: {
  publishedAt: unknown;
  now: number;
  maxAgeMs: number;
}): FreshnessVerdict {
  if (typeof publishedAt !== "string" || !publishedAt.trim()) {
    return { status: "unknown", reason: "no published_at in the API response" };
  }
  const publishedMs = Date.parse(publishedAt);
  if (!Number.isFinite(publishedMs)) {
    return {
      status: "unknown",
      reason: `unparseable published_at: ${publishedAt}`,
    };
  }
  // A timestamp in the future is a clock or pipeline fault, not freshness --
  // report it rather than silently treating it as the healthiest possible age.
  if (publishedMs > now + 60_000) {
    return {
      status: "unknown",
      reason: `published_at is in the future: ${publishedAt}`,
    };
  }
  const ageMs = Math.max(0, now - publishedMs);
  return ageMs > maxAgeMs
    ? { status: "stale", ageMs, publishedAt, maxAgeMs }
    : { status: "fresh", ageMs, publishedAt };
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (!days && minutes) parts.push(`${minutes}m`);
  return parts.join(" ") || "0m";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A single transient fetch failure is not staleness. Retry before reporting,
 * so a blip in Cloudflare or the runner's network never pages anyone.
 */
async function readPublishedAt(apiBase: string): Promise<{
  publishedAt?: unknown;
  error?: string;
}> {
  let lastError = "unknown error";
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`${apiBase}/api/v1/build`, {
        headers: { "user-agent": "metagraphed-freshness-check" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
      } else {
        const body = (await res.json()) as {
          meta?: { published_at?: unknown };
        };
        return { publishedAt: body?.meta?.published_at };
      }
    } catch (error) {
      lastError = String((error as Error)?.message || error).slice(0, 200);
    }
    if (attempt < FETCH_ATTEMPTS) {
      console.error(
        `freshness check: attempt ${attempt}/${FETCH_ATTEMPTS} failed (${lastError}) — retrying`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
  return { error: lastError };
}

async function main(): Promise<void> {
  const apiBase = process.env.METAGRAPH_API_BASE || DEFAULT_API_BASE;
  const maxAgeHours =
    Number(process.env.METAGRAPH_MAX_PUBLISH_AGE_HOURS) ||
    DEFAULT_MAX_AGE_HOURS;
  const maxAgeMs = maxAgeHours * 3_600_000;

  const { publishedAt, error } = await readPublishedAt(apiBase);
  if (error) {
    // Unreachable after retries is itself worth surfacing, but as a distinct
    // condition from "we know it is stale" -- don't claim knowledge we lack.
    console.error(
      `::error::Could not read publish freshness from ${apiBase}/api/v1/build after ${FETCH_ATTEMPTS} attempts: ${error}`,
    );
    process.exit(1);
  }

  const verdict = evaluateFreshness({ publishedAt, now: Date.now(), maxAgeMs });

  if (verdict.status === "fresh") {
    console.log(
      `Published data is fresh: ${formatDuration(verdict.ageMs)} old (threshold ${maxAgeHours}h), last publish ${verdict.publishedAt}.`,
    );
    return;
  }

  if (verdict.status === "unknown") {
    console.error(`::error::Publish freshness is unknown — ${verdict.reason}.`);
    process.exit(1);
  }

  console.error(
    `::error::Published data is STALE: ${formatDuration(verdict.ageMs)} old, ` +
      `past the ${maxAgeHours}h threshold (2x the daily publish cadence). ` +
      `Last successful publish: ${verdict.publishedAt}. ` +
      `Check the most recent "Publish Cloudflare Backend" run — a stale publish also ` +
      `masks pointer/upload faults, because the KV pointer only moves on a run that completes (#8276).`,
  );
  process.exit(1);
}

// Run only as a script, so tests can import the pure helpers above without
// firing the check (same guard as scripts/assert-published-probe-health.ts).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}

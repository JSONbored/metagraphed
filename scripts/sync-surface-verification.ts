// Snapshot per-surface probe evidence into registry/verification/surface-health.json (#8689).
//
// Closes the loop that left `machine-verified` at exactly ZERO surfaces: the
// 15-minute cron prober has always produced per-surface uptime history, but
// nothing carried that evidence to the `verified_at` field flattenSurfaces
// reads. This script is that carrier. See src/surface-verification.ts for why
// the evidence comes from the health prober rather than verify-candidates.ts,
// and for the promotion bar itself.
//
// COMMITTED, not fetched at build time. tests/artifacts-build-determinism.test.ts asserts the
// artifact build is byte-identical across rebuilds; a network call inside the
// build would end that, and would also make every build depend on the API being
// up. Same posture as registry/verification/promotions.json.
//
// Usage:
//   node scripts/sync-surface-verification.ts --write     (default: dry-run)
//   node scripts/sync-surface-verification.ts --dry-run
import path from "node:path";
import { loadSubnets, repoRoot, stableStringify, writeJson } from "./lib.ts";
import {
  verifyFromProbeEvidence,
  type SurfaceProbeRecord,
} from "../src/surface-verification.ts";

type Row = Record<string, unknown>;

const API_BASE = process.env.METAGRAPH_API_BASE || "https://api.metagraph.sh";
const dryRun = !process.argv.includes("--write");
// One probe of our own API per subnet. Serial with a small delay rather than a
// fan-out: this is ~120 requests against our own edge, and a burst would trip
// the very rate limiter #8608 just tightened.
const REQUEST_SPACING_MS = 50;
const REQUEST_TIMEOUT_MS = 15_000;

async function fetchUptime(netuid: number): Promise<Row | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const response = await fetch(
      `${API_BASE}/api/v1/subnets/${netuid}/uptime`,
      {
        headers: {
          accept: "application/json",
          "user-agent": "metagraphed-surface-verification-sync/1.0",
        },
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as { ok?: boolean; data?: Row };
    return body?.ok && body.data ? body.data : null;
  } catch {
    // A subnet we cannot reach contributes NO evidence, which means its
    // surfaces stay unverified. Never a throw: one unreachable subnet must not
    // abandon the other ~119.
    return null;
  }
}

const subnets = await loadSubnets();
const netuids = [
  ...new Set(
    subnets
      .map((subnet) => Number((subnet as Row).netuid))
      .filter((netuid) => Number.isInteger(netuid) && netuid >= 0),
  ),
].sort((a, b) => a - b);

const records: Record<string, SurfaceProbeRecord> = {};
let reachedSubnets = 0;

for (const netuid of netuids) {
  const data = await fetchUptime(netuid);
  if (!data) continue;
  reachedSubnets += 1;
  for (const surface of (data.surfaces as Row[]) || []) {
    const surfaceId = surface?.surface_id;
    if (typeof surfaceId !== "string" || !surfaceId) continue;
    const reliability = (surface.reliability as Row | undefined) || {};
    records[surfaceId] = {
      day_count: Number(surface.day_count ?? 0),
      samples: Number(surface.samples ?? reliability.sample_count ?? 0),
      uptime_ratio: Number(
        surface.uptime_ratio ?? reliability.uptime_ratio ?? 0,
      ),
      // The uptime rollup carries no last_ok of its own, so the window's own
      // observation instant is what the evidence attests to.
      last_ok:
        typeof surface.last_ok === "string"
          ? surface.last_ok
          : typeof data.observed_at === "string"
            ? data.observed_at
            : null,
      classification:
        typeof surface.classification === "string"
          ? surface.classification
          : null,
    };
  }
  if (REQUEST_SPACING_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS));
  }
}

const surfaceIds = Object.keys(records).sort();
let verified = 0;
const reasons: Record<string, number> = {};
for (const id of surfaceIds) {
  const verdict = verifyFromProbeEvidence(records[id]);
  if (verdict.verified) verified += 1;
  else {
    // Bucket by the failing CONDITION, not the formatted reason, so the summary
    // stays a fixed small set instead of one bucket per distinct number.
    const bucket = verdict.reason.replace(/[\d.]+/g, "N");
    reasons[bucket] = (reasons[bucket] || 0) + 1;
  }
}

const artifact = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  notes:
    "Per-surface probe evidence from the live cron prober, snapshotted for " +
    "deterministic Git review. Consumed by scripts/lib.ts flattenSurfaces to " +
    "derive machine verification; see src/surface-verification.ts for the bar.",
  source: "live-cron-prober",
  subnets_reached: reachedSubnets,
  subnets_total: netuids.length,
  surface_count: surfaceIds.length,
  verified_count: verified,
  unverified_reasons: reasons,
  surfaces: Object.fromEntries(surfaceIds.map((id) => [id, records[id]])),
};

if (!dryRun) {
  await writeJson(
    path.join(repoRoot, "registry/verification/surface-health.json"),
    artifact,
  );
}

console.log(
  stableStringify({
    mode: dryRun ? "dry-run" : "write",
    subnets_reached: reachedSubnets,
    subnets_total: netuids.length,
    surface_count: surfaceIds.length,
    verified_count: verified,
    unverified_reasons: reasons,
  }),
);

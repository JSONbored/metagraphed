// Snapshot per-surface probe evidence into registry/verification/surface-health.json (#8689).
//
// Closes the loop that left `machine-verified` at exactly ZERO surfaces: the
// 15-minute cron prober has always produced per-surface uptime history, but
// nothing carried that evidence to the `verified_at` field flattenSurfaces
// reads. This script is that carrier. See src/surface-verification.ts for why
// the evidence comes from the health prober rather than verify-candidates.ts,
// and for the promotion bar itself.
//
// #9096: the SCHEDULED writer of this snapshot is now the Worker cron
// (src/surface-verification-sync.ts), which computes the same evidence
// straight from D1 and writes the `generated/surface-health.json` R2 store —
// replacing the retired sync-surface-verification.yml bot-PR lane. This script
// stays as the way to refresh the committed SEED by hand, and shares the
// record extractor + artifact assembler with the cron
// (src/surface-verification.ts) so the two writers cannot diverge on semantics
// that decide surface trust levels.
//
// COMMITTED, not fetched at build time. tests/artifacts-build-determinism.test.ts asserts the
// artifact build is byte-identical across rebuilds; a network call inside the
// build would end that, and would also make every build depend on the API being
// up. Same posture as registry/verification/promotions.json.
// (loadSurfaceProbeEvidence's store read is credential-gated for exactly this
// reason — see its header in scripts/lib.ts.)
//
// Usage:
//   node scripts/sync-surface-verification.ts --write     (default: dry-run)
//   node scripts/sync-surface-verification.ts --dry-run
import path from "node:path";
import {
  loadSubnets,
  repoRoot,
  stableStringify,
  SURFACE_HEALTH_PATH,
  writeJson,
} from "./lib.ts";
import {
  buildSurfaceHealthArtifact,
  collectSurfaceProbeRecords,
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
  collectSurfaceProbeRecords(data, records);
  if (REQUEST_SPACING_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, REQUEST_SPACING_MS));
  }
}

const artifact = buildSurfaceHealthArtifact({
  records,
  subnetsReached: reachedSubnets,
  subnetsTotal: netuids.length,
  generatedAt: new Date().toISOString(),
});

if (!dryRun) {
  await writeJson(path.join(repoRoot, SURFACE_HEALTH_PATH), artifact);
}

console.log(
  stableStringify({
    mode: dryRun ? "dry-run" : "write",
    subnets_reached: artifact.subnets_reached,
    subnets_total: artifact.subnets_total,
    surface_count: artifact.surface_count,
    verified_count: artifact.verified_count,
    unverified_reasons: artifact.unverified_reasons,
  }),
);

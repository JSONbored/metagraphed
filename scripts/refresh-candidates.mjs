// Tolerant candidate-discovery + verification refresh for the PRODUCTION publish
// (issue #599 / ADR 0006). candidate-discovery and candidate-verification are
// block-behavior freshness sources (validate.mjs validateFreshnessForPublish):
// once either is >24h old the scheduled publish HARD-FAILS. #571 retired the
// scheduled sync-subnets PR that used to refresh them, so without this the
// event-driven + daily-floor publish starts failing ~24h after the last manual sync.
//
// Refreshes both fresh each publish, stamping their observed_at with the build
// timestamp — but NEVER fails the publish: both scripts make heavy live network
// calls (taomarketcap, GitHub, candidate URL probes) and write their artifacts
// only after a successful run, so on failure the last committed
// candidates/verification stay intact and the build proceeds (the >24h freshness
// gate is the backstop, exactly as for the native snapshot in #598). The native
// snapshot must already be refreshed first (discover-candidates reads it), so
// this runs AFTER the native-snapshot step in build.mjs productionSteps.
// Production-only; local/PR builds use the committed candidates/verification.
import { spawnSync } from "node:child_process";
import { stableStringify } from "./lib.mjs";

const buildTimestamp = process.env.METAGRAPH_BUILD_TIMESTAMP || "";
const env = {
  ...process.env,
  // Pin the discovery/verification observed_at to the publish timestamp so the
  // regenerated artifacts are fresh-by-construction (build-artifacts reads these
  // envs first when stamping native_snapshot_captured_at / observed_at).
  METAGRAPH_DISCOVERY_OBSERVED_AT: buildTimestamp,
  METAGRAPH_PERSIST_DISCOVERY_OBSERVED_AT: "1",
  METAGRAPH_VERIFICATION_OBSERVED_AT: buildTimestamp,
};

const steps = [
  ["discover-candidates", ["scripts/discover-candidates.ts", "--write"]],
  ["verify-candidates", ["scripts/verify-candidates.mjs", "--write"]],
  // The provenance review queue is a pure transform of the candidates +
  // verification just refreshed above; regenerate it in lockstep so the publish's
  // `npm run validate` (which drift-checks the committed queue) sees a consistent
  // state instead of failing whenever discovery finds something new.
  ["review-queue", ["scripts/review-queue.mjs", "--write"]],
];

for (const [label, args] of steps) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env,
  });
  if (result.status === 0) {
    console.log(stableStringify({ step: label, status: "refreshed" }));
  } else {
    console.warn(
      `::warning::${label} failed (live network); keeping the last committed data. Publish continues (issue #599).`,
    );
    console.log(
      stableStringify({
        step: label,
        status: "fallback-to-last",
        exit_code: result.status,
      }),
    );
  }
}

process.exit(0);

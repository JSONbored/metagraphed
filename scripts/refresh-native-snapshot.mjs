// Tolerant native chain-snapshot refresh for the PRODUCTION publish (ADR 0006
// step 2). Runs the finney chain fetch fresh each publish so the published
// subnet registry stays current WITHOUT the retired scheduled sync-subnets PR
// (issue #597) — but it must NEVER fail the data publish.
//
// Chain RPC rate-limits made ~half of standalone sync runs fail, so this wraps
// scripts/sync-subnets.mjs and SWALLOWS failure: sync-subnets writes the
// snapshot only after a successful fetch, so on failure the previous committed
// snapshot is left intact and build-artifacts proceeds with the last-good data
// (the only consequence is the existing 7-day completeness soft-demotion if the
// snapshot is very stale — never a broken publish).
//
// Runs in build.mjs productionSteps before build-artifacts; local/PR builds keep
// using the committed snapshot (this step is production-only).
import { spawnSync } from "node:child_process";
import { stableStringify } from "./lib.mjs";
import { initSentry } from "./observability.mjs";

initSentry("refresh-native-snapshot");

const startedAt = process.env.METAGRAPH_BUILD_TIMESTAMP || null;

const result = spawnSync(
  process.execPath,
  ["scripts/sync-subnets.mjs", "--write"],
  { cwd: process.cwd(), stdio: "inherit", env: process.env },
);

if (result.status === 0) {
  console.log(
    stableStringify({
      step: "native-snapshot",
      status: "refreshed",
      started_at: startedAt,
    }),
  );
} else {
  // Tolerant by design — a transient chain RPC failure must not block the
  // publish. The last committed snapshot remains the build input.
  console.warn(
    "::warning::native snapshot refresh failed (chain RPC); keeping the last snapshot. Publish continues (ADR 0006 step 2).",
  );
  console.log(
    stableStringify({
      step: "native-snapshot",
      status: "fallback-to-last",
      exit_code: result.status,
      started_at: startedAt,
    }),
  );
}

process.exit(0);

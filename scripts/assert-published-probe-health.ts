#!/usr/bin/env node
// Publish guard: refuse to publish unprobed health data.
//
// The publish job restores the refresh job's probe-health artifacts and then
// runs validate/test, which rebuild artifacts in-place WITHOUT a probe-result
// cache and clobber the probe-derived health/pools/freshness (real
// probe_finished_at + "ok" statuses become the 1970 epoch placeholder + all
// "unknown"). After re-restoring the reviewed artifacts, this guard asserts they
// actually carry live probe health, so a regression can never again silently
// publish an all-"unknown" dataset — which would also leave the RPC pools with
// zero eligible endpoints and break the read-only proxy.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HEALTH_PATH = "dist/metagraph-r2/metagraph/health/latest.json";

interface ProbeHealthArtifact {
  probe_finished_at?: unknown;
  surfaces?: unknown;
}

interface ProbeHealthAssessment {
  finishedAt: string;
  okCount: number;
  total: number;
  problems: string[];
}

export function assessProbeHealth(
  health: ProbeHealthArtifact | null | undefined,
): ProbeHealthAssessment {
  const finishedAt = String(health?.probe_finished_at || "");
  const surfaces = Array.isArray(health?.surfaces) ? health.surfaces : [];
  const okCount = surfaces.filter(
    (s) => s && (s as Record<string, unknown>).status === "ok",
  ).length;
  const problems: string[] = [];
  if (!finishedAt || finishedAt.startsWith("1970")) {
    problems.push(
      `probe_finished_at is epoch/empty (${finishedAt || "unset"})`,
    );
  }
  if (okCount === 0) {
    problems.push(`0 of ${surfaces.length} surfaces are status=ok`);
  }
  return { finishedAt, okCount, total: surfaces.length, problems };
}

function main(): number {
  if (!existsSync(HEALTH_PATH)) {
    // Operational health is now live-only (served from KV/D1; no static
    // health/latest.json is built or published), so there is nothing to guard
    // against here — the 15-minute cron is the single source of truth.
    console.log(
      `${HEALTH_PATH} not present — operational health is live-only; publish-guard skipped.`,
    );
    return 0;
  }
  let health: ProbeHealthArtifact;
  try {
    health = JSON.parse(readFileSync(HEALTH_PATH, "utf8"));
  } catch (error) {
    console.error(
      `::error::${HEALTH_PATH} is unreadable: ${(error as Error).message}`,
    );
    return 1;
  }
  const { finishedAt, okCount, total, problems } = assessProbeHealth(health);
  if (problems.length) {
    console.error(
      `::error::Reviewed artifacts lack live probe health — refusing to publish unprobed data: ${problems.join("; ")}`,
    );
    return 1;
  }
  console.log(
    `probe health OK: probe_finished_at=${finishedAt}, ${okCount}/${total} surfaces ok`,
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}

import { spawnSync } from "node:child_process";
import { stableStringify } from "./lib.mjs";

const productionBuild = isProductionPublishBuild();
const startedAt = new Date().toISOString();
const effectiveBuildTimestamp =
  process.env.METAGRAPH_BUILD_TIMESTAMP || (productionBuild ? startedAt : null);
const steps = productionBuild ? productionSteps() : localSteps();
const results = [];

for (const step of steps) {
  const started = performance.now();
  const result = spawnSync(process.execPath, step.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...(effectiveBuildTimestamp
        ? { METAGRAPH_BUILD_TIMESTAMP: effectiveBuildTimestamp }
        : {}),
      ...(step.env || {}),
    },
    stdio: "pipe",
  });
  const elapsedMs = Math.round(performance.now() - started);
  results.push({
    name: step.name,
    status: result.status === 0 ? "passed" : "failed",
    elapsed_ms: elapsedMs,
  });

  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");

  if (result.status !== 0) {
    console.error(
      stableStringify({
        mode: productionBuild ? "production-publish" : "local",
        failed_step: step.name,
        results,
      }),
    );
    process.exit(result.status || 1);
  }
}

console.log(
  stableStringify({
    mode: productionBuild ? "production-publish" : "local",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    result_count: results.length,
    results,
  }),
);

function localSteps() {
  return [
    nodeStep("bundle-schemas", "scripts/bundle-schemas.mjs", "--write"),
    nodeStep("build-artifacts", "scripts/build-artifacts.mjs", {
      METAGRAPH_PRESERVE_PROBE_HEALTH: "1",
    }),
    // After build-artifacts (which wipes the R2 staging root) and before
    // r2-manifest: build the non-default network registries (testnet) into the
    // R2 staging tree so they're picked up by the manifest + upload.
    nodeStep("build-network-registries", "scripts/build-network-registry.mjs"),
    nodeStep("generate-types", "scripts/generate-types.mjs"),
    nodeStep("generate-client", "scripts/generate-client.mjs", "--write"),
    nodeStep("r2-manifest", "scripts/r2-manifest.mjs", "--write"),
  ];
}

function productionSteps() {
  const refreshEnv = {
    METAGRAPH_DISCOVERY_OBSERVED_AT: effectiveBuildTimestamp,
    METAGRAPH_PERSIST_DISCOVERY_OBSERVED_AT: "1",
    METAGRAPH_VERIFICATION_OBSERVED_AT: effectiveBuildTimestamp,
  };
  return [
    nodeStep("bundle-schemas", "scripts/bundle-schemas.mjs", "--write"),
    // Refresh publish-blocking native subnet, generated candidate discovery,
    // and candidate verification inputs during the scheduled publish build.
    // sync-subnets.yml remains manual-only for reviewed Git backfills, but the
    // production data publish must be self-sufficient so the freshness gate does
    // not depend on a recently merged sync PR.
    nodeStep("sync-subnets", "scripts/sync-subnets.mjs", "--write"),
    nodeStep(
      "discover-candidates",
      "scripts/discover-candidates.mjs",
      "--write",
      refreshEnv,
    ),
    nodeStep(
      "verify-candidates",
      "scripts/verify-candidates.mjs",
      "--write",
      refreshEnv,
    ),
    // Capture live OpenAPI/Swagger specs (full document + auth) before
    // build-artifacts, so the per-surface schema files carry the real spec for
    // get_api_schema. build-artifacts grabs the document before its staging wipe
    // and re-attaches it; the index stays light. Degrades to digests if a spec
    // is unreachable (snapshot-openapi handles unavailable surfaces).
    nodeStep("schemas-snapshot", "scripts/snapshot-openapi.mjs", "--write"),
    // Re-snapshot adapters from live GitHub metadata so the publish is
    // self-sufficient for freshness: adapter-snapshots are then fresh by
    // construction at publish time (the publish already re-probes health),
    // so the freshness gate never depends on a recently-merged sync PR.
    // Auth posture (METAGRAPH_REQUIRE_ADAPTER_AUTH) + token are supplied by
    // the caller (publish-cloudflare.yml); without a token this carries
    // forward committed adapter data rather than failing.
    nodeStep("adapters-snapshot", "scripts/snapshot-adapters.mjs", "--write"),
    // Capture one sanitized live request/response sample per no-auth GET
    // surface (issue #352) before build-artifacts, mirroring schemas-snapshot:
    // build-artifacts grabs the fixtures/{surface_id}.json files before its
    // staging wipe, re-attaches them, and builds the fixtures.json index that
    // powers the get_fixture MCP tool. Degrades gracefully — every unreachable
    // surface is skipped (the step always exits 0), so a flaky surface never
    // blocks the publish. Without this step the index is empty and get_fixture
    // returns nothing.
    nodeStep("capture-fixtures", "scripts/capture-fixtures.mjs", "--write"),
    nodeStep("build-artifacts", "scripts/build-artifacts.mjs"),
    nodeStep("probes-smoke", "scripts/probes-smoke.mjs", {
      METAGRAPH_WRITE_PROBE_RESULTS: "1",
    }),
    nodeStep(
      "build-artifacts-with-probe-health",
      "scripts/build-artifacts.mjs",
      {
        METAGRAPH_PRESERVE_PROBE_HEALTH: "1",
      },
    ),
    // After the final build-artifacts (R2 staging wipe) and before r2-manifest.
    nodeStep("build-network-registries", "scripts/build-network-registry.mjs"),
    nodeStep("generate-types", "scripts/generate-types.mjs"),
    nodeStep("generate-client", "scripts/generate-client.mjs", "--write"),
    nodeStep("r2-manifest", "scripts/r2-manifest.mjs", "--write"),
  ];
}

function nodeStep(name, script, ...argsOrEnv) {
  const env =
    typeof argsOrEnv.at(-1) === "object" && !Array.isArray(argsOrEnv.at(-1))
      ? argsOrEnv.pop()
      : {};
  return {
    name,
    args: [script, ...argsOrEnv],
    env,
  };
}

function isProductionPublishBuild() {
  if (process.env.METAGRAPH_PRODUCTION_BUILD === "1") {
    return true;
  }
  return (
    process.env.GITHUB_ACTIONS === "true" &&
    process.env.GITHUB_WORKFLOW === "Publish Cloudflare Backend" &&
    process.env.GITHUB_REF === "refs/heads/main"
  );
}

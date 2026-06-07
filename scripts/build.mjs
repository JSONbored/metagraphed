import { spawnSync } from "node:child_process";
import { stableStringify } from "./lib.mjs";

const productionBuild = isProductionPublishBuild();
const startedAt = new Date().toISOString();
const steps = productionBuild ? productionSteps() : localSteps();
const results = [];

for (const step of steps) {
  const started = performance.now();
  const result = spawnSync(process.execPath, step.args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
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
    nodeStep("build-artifacts", "scripts/build-artifacts.mjs"),
    nodeStep("generate-types", "scripts/generate-types.mjs"),
    nodeStep("generate-client", "scripts/generate-client.mjs", "--write"),
    nodeStep("r2-manifest", "scripts/r2-manifest.mjs", "--write"),
  ];
}

function productionSteps() {
  return [
    nodeStep("bundle-schemas", "scripts/bundle-schemas.mjs", "--write"),
    nodeStep("build-artifacts", "scripts/build-artifacts.mjs"),
    nodeStep("probes-smoke", "scripts/probes-smoke.mjs", {
      METAGRAPH_WRITE_PROBE_RESULTS: "1",
    }),
    nodeStep(
      "build-artifacts-with-probe-health",
      "scripts/build-artifacts.mjs",
    ),
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

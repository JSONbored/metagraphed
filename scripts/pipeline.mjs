import { spawnSync } from "node:child_process";
import { stableStringify } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const refresh = args.has("--refresh");
const check = args.has("--check") || !refresh;

const commands = check ? checkCommands() : refreshCommands();
const startedAt = new Date().toISOString();
const results = [];

for (const command of commands) {
  const started = performance.now();
  const result = spawnSync("npm", ["run", command.script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...(command.env || {}),
    },
    stdio: "pipe",
  });
  const elapsedMs = Math.round(performance.now() - started);
  results.push({
    script: command.script,
    status: result.status === 0 ? "passed" : "failed",
    elapsed_ms: elapsedMs,
  });

  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");

  if (result.status !== 0) {
    console.error(
      stableStringify({
        mode: check ? "check" : "refresh",
        failed_script: command.script,
        results,
      }),
    );
    process.exit(result.status || 1);
  }
}

console.log(
  stableStringify({
    mode: check ? "check" : "refresh",
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    result_count: results.length,
    results,
  }),
);

function checkCommands() {
  return [
    step("sync:subnets:dry-run"),
    step("discover:candidates:dry-run"),
    step("verify:candidates:dry-run"),
    step("curate:baseline:dry-run"),
    step("review:promote:dry-run"),
    step("schemas:snapshot:dry-run"),
    step("adapters:snapshot:dry-run"),
    step("openapi:generate:dry-run"),
    step("r2:manifest:dry-run"),
    step("validate"),
    step("validate:schemas"),
    step("validate:api"),
    step("validate:openapi"),
    step("validate:types"),
    step("validate:artifact-budgets"),
    step("validate:docs"),
    step("validate:intake"),
    step("validate:workflows"),
    step("worker:test"),
    step("worker:deploy:dry-run"),
    step("scan:public-safety"),
    step("test"),
  ];
}

function refreshCommands() {
  const commands = [
    step("sync:subnets"),
    step("discover:candidates"),
    step("verify:candidates"),
    step("curate:baseline"),
    step("review:promote"),
    step("adapters:snapshot"),
    step("build"),
    step("schemas:snapshot"),
    step("r2:manifest"),
  ];

  if (process.env.METAGRAPH_WRITE_PROBE_RESULTS === "1") {
    commands.splice(8, 0, step("probes:smoke"));
    commands.splice(9, 0, step("build-summary:refresh"));
  }

  return [
    ...commands,
    step("validate"),
    step("validate:schemas"),
    step("validate:api"),
    step("validate:openapi"),
    step("validate:types"),
    step("validate:artifact-budgets"),
    step("validate:docs"),
    step("validate:intake"),
    step("validate:workflows"),
    step("worker:test"),
    step("worker:deploy:dry-run"),
    step("scan:public-safety"),
    step("test"),
  ];
}

function step(script, env = {}) {
  return { script, env };
}

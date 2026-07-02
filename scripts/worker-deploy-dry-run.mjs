import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot, stripJsonComments } from "./lib.mjs";

const configPath = path.join(repoRoot, "wrangler.jsonc");
const workerPath = path.join(repoRoot, "workers/api.mjs");
const assetsIgnorePath = path.join(repoRoot, "public/.assetsignore");
const rawConfig = await fs.readFile(configPath, "utf8");
const config = JSON.parse(stripJsonComments(rawConfig));
const assetsIgnore = await fs.readFile(assetsIgnorePath, "utf8");
const errors = [];

check(config.name === "metagraphed", "wrangler name must be metagraphed");
check(
  config.main === "workers/api.mjs",
  "wrangler main must point to workers/api.mjs",
);
check(
  config.compatibility_date === "2026-06-06",
  "compatibility_date must be locked to 2026-06-06",
);
check(
  Array.isArray(config.compatibility_flags) &&
    config.compatibility_flags.includes("nodejs_compat"),
  "nodejs_compat flag is required",
);
check(
  config.assets?.directory === "./public",
  "assets.directory must be ./public",
);
check(config.assets?.binding === "ASSETS", "ASSETS binding is required");
check(
  Array.isArray(config.assets?.run_worker_first) &&
    config.assets.run_worker_first.includes("/api/*"),
  "API routes must run Worker first",
);
check(
  Array.isArray(config.assets?.run_worker_first) &&
    config.assets.run_worker_first.includes("/rpc/*"),
  "RPC proxy routes must run Worker first",
);
check(
  Array.isArray(config.assets?.run_worker_first) &&
    config.assets.run_worker_first.includes("/metagraph/*"),
  "Metagraph artifact routes must run Worker first",
);
check(
  assetsIgnore.includes(".DS_Store") && assetsIgnore.includes("Thumbs.db"),
  "public/.assetsignore must block OS metadata uploads",
);
check(
  ["true", "false"].includes(config.vars?.METAGRAPH_ENABLE_RPC_PROXY),
  "RPC proxy enable flag must be explicitly 'true' or 'false'",
);
check(
  config.vars?.METAGRAPH_R2_LATEST_PREFIX === "latest/",
  "R2 latest prefix must default to latest/",
);
check(
  Array.isArray(config.r2_buckets) &&
    config.r2_buckets.some((bucket) => bucket.binding === "METAGRAPH_ARCHIVE"),
  "METAGRAPH_ARCHIVE R2 binding is required",
);
check(config.observability?.enabled === true, "observability must be enabled");

await fs.access(workerPath);

if (errors.length > 0) {
  console.error(`Worker deploy dry-run failed with ${errors.length} issue(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Worker deploy dry-run passed.");

function check(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  readJson,
  repoRoot,
  stableStringify,
  stripJsonComments,
} from "./lib.mjs";

const configPath = path.join(repoRoot, "wrangler.jsonc");
const assetsIgnorePath = path.join(repoRoot, "public/.assetsignore");
const rawConfig = await fs.readFile(configPath, "utf8");
const config = JSON.parse(stripJsonComments(rawConfig));
const assetsIgnore = await fs.readFile(assetsIgnorePath, "utf8");
const manifest = await readJson(
  path.join(repoRoot, "public/metagraph/r2-manifest.json"),
);
const contracts = await readJson(
  path.join(repoRoot, "public/metagraph/contracts.json"),
);
const apiIndex = await readJson(
  path.join(repoRoot, "public/metagraph/api-index.json"),
);
const errors = [];
const warnings = [];
const kvBinding = Array.isArray(config.kv_namespaces)
  ? config.kv_namespaces.find(
      (namespace) => namespace.binding === "METAGRAPH_CONTROL",
    )
  : null;
const requireKvBinding =
  process.env.METAGRAPH_REQUIRE_KV_BINDING === "1" ||
  Boolean(process.env.METAGRAPH_KV_NAMESPACE_ID);

check(config.name === "metagraphed", "wrangler name must be metagraphed");
// workers/api.sentry.mjs is the real deployed entry point as of
// metagraphed#6502/#6479/#6485 -- a thin Sentry deploy-entry wrapper that
// imports and re-exports workers/api.mjs's own handler + Durable Object
// classes unchanged (see that file's own header for why it's a separate
// file, not an inline wrap: @sentry/cloudflare's withSentry() crashes in
// this repo's plain-Node vitest tests). Either value is a legitimate,
// verified-working entry point; this check's real intent is "the main
// Worker's own handler, wrapped or not," not a literal string pin to the
// pre-Sentry file.
check(
  config.main === "workers/api.mjs" || config.main === "workers/api.sentry.mjs",
  "wrangler main must point to workers/api.mjs or its Sentry deploy-entry wrapper, workers/api.sentry.mjs",
);
check(Boolean(config.compatibility_date), "compatibility_date is required");
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
  "RPC routes must run Worker first",
);
check(
  Array.isArray(config.assets?.run_worker_first) &&
    config.assets.run_worker_first.includes("/metagraph/*"),
  "Metagraph artifact routes must run Worker first for CORS, cache headers, and R2 fallback",
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
check(config.observability?.enabled === true, "observability must be enabled");
check(
  Array.isArray(config.r2_buckets) &&
    config.r2_buckets.some((bucket) => bucket.binding === "METAGRAPH_ARCHIVE"),
  "METAGRAPH_ARCHIVE R2 binding is required",
);
check(
  manifest.bucket_binding === "METAGRAPH_ARCHIVE",
  "R2 manifest bucket binding must match Worker binding",
);
check(
  manifest.artifact_count === manifest.artifacts.length,
  "R2 manifest artifact count must match artifacts length",
);
check(
  manifest.artifacts.every(
    (artifact) => artifact.sha256 && artifact.path?.startsWith("/metagraph/"),
  ),
  "R2 manifest artifacts must include sha256 and /metagraph paths",
);
check(
  contracts.primary_domain === "api.metagraph.sh",
  "contracts primary domain must be api.metagraph.sh",
);
check(
  apiIndex.primary_domain === "api.metagraph.sh",
  "api index primary domain must be api.metagraph.sh",
);

if (!kvBinding && requireKvBinding) {
  errors.push(
    "METAGRAPH_CONTROL KV binding is required when METAGRAPH_KV_NAMESPACE_ID is configured.",
  );
} else if (!kvBinding) {
  warnings.push(
    "METAGRAPH_CONTROL KV binding is not configured in wrangler.jsonc; Worker will still serve static assets and R2 fallback can use METAGRAPH_R2_LATEST_PREFIX.",
  );
}
if (
  kvBinding?.id &&
  process.env.METAGRAPH_KV_NAMESPACE_ID &&
  kvBinding.id !== process.env.METAGRAPH_KV_NAMESPACE_ID
) {
  errors.push(
    "METAGRAPH_CONTROL KV binding id does not match METAGRAPH_KV_NAMESPACE_ID.",
  );
}
if (!process.env.METAGRAPH_KV_NAMESPACE_ID) {
  warnings.push(
    "METAGRAPH_KV_NAMESPACE_ID is not set; kv:publish remains dry-run/local only.",
  );
}
if (!process.env.CLOUDFLARE_ACCOUNT_ID) {
  warnings.push(
    "CLOUDFLARE_ACCOUNT_ID is not set; this script did not validate live account resources.",
  );
}

for (const forbidden of ["subnet.health", "localhost", "127.0.0.1"]) {
  check(
    !JSON.stringify({ config, contracts, apiIndex }).includes(forbidden),
    `Cloudflare config/contracts must not reference ${forbidden}`,
  );
}

if (errors.length > 0) {
  console.error(
    `Cloudflare verification failed with ${errors.length} issue(s):`,
  );
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  stableStringify({
    mode: "dry-run",
    status: "passed",
    warnings,
    r2_artifact_count: manifest.artifact_count,
    api_route_count: apiIndex.routes.length,
  }),
);

function check(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

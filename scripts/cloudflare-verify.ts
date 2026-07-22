import { promises as fs } from "node:fs";
import path from "node:path";
import {
  readJson,
  repoRoot,
  stableStringify,
  stripJsonComments,
} from "./lib.mjs";

type Row = Record<string, unknown>;

const configPath = path.join(repoRoot, "wrangler.jsonc");
const assetsIgnorePath = path.join(repoRoot, "public/.assetsignore");
const rawConfig = await fs.readFile(configPath, "utf8");
const config: Row = JSON.parse(stripJsonComments(rawConfig));
const assetsIgnore = await fs.readFile(assetsIgnorePath, "utf8");
const manifest: Row = await readJson(
  path.join(repoRoot, "public/metagraph/r2-manifest.json"),
);
const contracts: Row = await readJson(
  path.join(repoRoot, "public/metagraph/contracts.json"),
);
const apiIndex: Row = await readJson(
  path.join(repoRoot, "public/metagraph/api-index.json"),
);
const errors: string[] = [];
const warnings: string[] = [];
const kvBinding = Array.isArray(config.kv_namespaces)
  ? (config.kv_namespaces as Row[]).find(
      (namespace) => namespace.binding === "METAGRAPH_CONTROL",
    )
  : null;
const requireKvBinding =
  process.env.METAGRAPH_REQUIRE_KV_BINDING === "1" ||
  Boolean(process.env.METAGRAPH_KV_NAMESPACE_ID);

check(config.name === "metagraphed", "wrangler name must be metagraphed");
// workers/api.sentry.ts is the real deployed entry point as of
// metagraphed#6502/#6479/#6485 -- a thin Sentry deploy-entry wrapper that
// imports and re-exports workers/api.mjs's own handler + Durable Object
// classes unchanged (see that file's own header for why it's a separate
// file, not an inline wrap: @sentry/cloudflare's withSentry() crashes in
// this repo's plain-Node vitest tests). Either value is a legitimate,
// verified-working entry point; this check's real intent is "the main
// Worker's own handler, wrapped or not," not a literal string pin to one
// exact filename. Accepts both .mjs and .ts spellings of each -- the
// TypeScript migration (metagraphed#7510) converts workers/ file by file,
// so api.mjs and api.sentry.mjs may each independently still be .mjs or
// already be .ts depending on migration progress.
check(
  ["workers/api.mjs", "workers/api.ts"].includes(config.main as string) ||
    ["workers/api.sentry.mjs", "workers/api.sentry.ts"].includes(
      config.main as string,
    ),
  "wrangler main must point to workers/api.(mjs|ts) or its Sentry deploy-entry wrapper, workers/api.sentry.(mjs|ts)",
);
check(Boolean(config.compatibility_date), "compatibility_date is required");
check(
  Array.isArray(config.compatibility_flags) &&
    (config.compatibility_flags as string[]).includes("nodejs_compat"),
  "nodejs_compat flag is required",
);
check(
  (config.assets as Row | undefined)?.directory === "./public",
  "assets.directory must be ./public",
);
check(
  (config.assets as Row | undefined)?.binding === "ASSETS",
  "ASSETS binding is required",
);
check(
  Array.isArray((config.assets as Row | undefined)?.run_worker_first) &&
    ((config.assets as Row).run_worker_first as string[]).includes("/api/*"),
  "API routes must run Worker first",
);
check(
  Array.isArray((config.assets as Row | undefined)?.run_worker_first) &&
    ((config.assets as Row).run_worker_first as string[]).includes("/rpc/*"),
  "RPC routes must run Worker first",
);
check(
  Array.isArray((config.assets as Row | undefined)?.run_worker_first) &&
    ((config.assets as Row).run_worker_first as string[]).includes(
      "/metagraph/*",
    ),
  "Metagraph artifact routes must run Worker first for CORS, cache headers, and R2 fallback",
);
check(
  assetsIgnore.includes(".DS_Store") && assetsIgnore.includes("Thumbs.db"),
  "public/.assetsignore must block OS metadata uploads",
);
check(
  ["true", "false"].includes(
    (config.vars as Row | undefined)?.METAGRAPH_ENABLE_RPC_PROXY as string,
  ),
  "RPC proxy enable flag must be explicitly 'true' or 'false'",
);
check(
  (config.vars as Row | undefined)?.METAGRAPH_R2_LATEST_PREFIX === "latest/",
  "R2 latest prefix must default to latest/",
);
check(
  (config.observability as Row | undefined)?.enabled === true,
  "observability must be enabled",
);
check(
  Array.isArray(config.r2_buckets) &&
    (config.r2_buckets as Row[]).some(
      (bucket) => bucket.binding === "METAGRAPH_ARCHIVE",
    ),
  "METAGRAPH_ARCHIVE R2 binding is required",
);
check(
  manifest.bucket_binding === "METAGRAPH_ARCHIVE",
  "R2 manifest bucket binding must match Worker binding",
);
check(
  manifest.artifact_count === (manifest.artifacts as unknown[]).length,
  "R2 manifest artifact count must match artifacts length",
);
check(
  (manifest.artifacts as Row[]).every(
    (artifact) =>
      artifact.sha256 &&
      (artifact.path as string | undefined)?.startsWith("/metagraph/"),
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
    api_route_count: (apiIndex.routes as unknown[]).length,
  }),
);

function check(condition: unknown, message: string): void {
  if (!condition) {
    errors.push(message);
  }
}

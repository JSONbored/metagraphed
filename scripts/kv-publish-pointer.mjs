import { spawnSync } from "node:child_process";
import path from "node:path";
import { hashJson, readJson, repoRoot, stableStringify } from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const manifest = await readJson(
  path.join(repoRoot, "public/metagraph/r2-manifest.json"),
);
const freshness = await readJson(
  path.join(repoRoot, "public/metagraph/freshness.json"),
);
const endpointPools = await readJson(
  path.join(repoRoot, "public/metagraph/endpoint-pools.json"),
);
const sourceHealth = await readJson(
  path.join(repoRoot, "public/metagraph/source-health.json"),
);

const pointer = {
  contract_version: manifest.contract_version,
  generated_at: manifest.generated_at,
  latest_prefix: manifest.latest_prefix,
  run_prefix: manifest.run_prefix,
  manifest_hash: hashJson(manifest),
  artifact_count: manifest.artifact_count,
  native_snapshot_captured_at: freshness.summary.native_snapshot_captured_at,
  health_surface_count: freshness.summary.health_surface_count,
};
const featureFlags = {
  contract_version: manifest.contract_version,
  generated_at: manifest.generated_at,
  d1_enabled: false,
  owned_nodes_enabled: false,
  rpc_proxy_enabled: false,
  rpc_proxy_feature_flag: "METAGRAPH_ENABLE_RPC_PROXY",
  rpc_proxy_requires_waf: true,
  rpc_proxy_requires_rate_limit: true,
};
const endpointPoolStatus = {
  contract_version: manifest.contract_version,
  generated_at: endpointPools.generated_at,
  pools: (endpointPools.pools || []).map((pool) => ({
    id: pool.id,
    kind: pool.kind,
    endpoint_count: pool.endpoint_count,
    eligible_count: pool.eligible_count,
    best_endpoint_id: pool.best_endpoint_id,
  })),
};
const sourceFreshness = {
  contract_version: manifest.contract_version,
  generated_at: freshness.generated_at,
  freshness: freshness.summary,
  source_health: sourceHealth.summary,
};
const kvEntries = [
  ["metagraph:latest", pointer],
  ["metagraph:feature-flags", featureFlags],
  ["metagraph:endpoint-pools", endpointPoolStatus],
  ["metagraph:source-freshness", sourceFreshness],
];

if (!write) {
  console.log(
    stableStringify({
      mode: "dry-run",
      keys: kvEntries.map(([key]) => key),
      values: Object.fromEntries(kvEntries),
    }),
  );
  process.exit(0);
}

if (!process.env.METAGRAPH_KV_NAMESPACE_ID) {
  console.error(
    "METAGRAPH_KV_NAMESPACE_ID is required to publish the latest pointer.",
  );
  process.exit(1);
}
if (process.env.METAGRAPH_ALLOW_KV_WRITE !== "1") {
  console.error("Refusing to write KV without METAGRAPH_ALLOW_KV_WRITE=1.");
  process.exit(1);
}

for (const [key, value] of kvEntries) {
  putKv(key, value);
}

console.log(`Published ${kvEntries.length} KV control record(s).`);

function putKv(key, value) {
  const wranglerBin = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const result = spawnSync(
    wranglerBin,
    [
      "kv",
      "key",
      "put",
      key,
      JSON.stringify(value),
      "--namespace-id",
      process.env.METAGRAPH_KV_NAMESPACE_ID,
      "--remote",
    ],
    {
      encoding: "utf8",
      stdio: "pipe",
    },
  );

  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(result.status || 1);
  }
}

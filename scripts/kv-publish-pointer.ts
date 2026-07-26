import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  artifactFilePath,
  hashJson,
  readJson,
  repoRoot,
  stableStringify,
} from "./lib.ts";

type Row = Record<string, unknown>;

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const manifest: Row = await readJson(
  path.join(repoRoot, "public/metagraph/r2-manifest.json"),
);
// build-summary.json is R2-only (#1003); resolve via artifactFilePath (dist/).
// r2-manifest.json stays committed (publish infra), read from public/ above.
const buildSummary: Row = await readJson(
  artifactFilePath("build-summary.json"),
);
// Tier-aware: freshness.json is R2-only (ADR 0001), so resolve it through
// artifactFilePath (dist/) rather than a hardcoded public/ path.
const freshness: Row = await readJson(artifactFilePath("freshness.json"));

const pointer = {
  contract_version: manifest.contract_version,
  generated_at: manifest.generated_at,
  // Real wall-clock publish time (distinct from the deterministic generated_at
  // build stamp). The Worker surfaces this as meta.published_at so consumers
  // read true freshness instead of the epoch content marker.
  published_at: buildSummary.published_at || null,
  // The Worker resolves live artifacts through latest_prefix (workers/storage.ts's
  // latestR2Key: `${latest_prefix}${relativePath}`), so this MUST name a prefix
  // the upload actually writes.
  //
  // #8276: this pointed at manifest.run_prefix until #8237 content-addressed the
  // history tier. Under the old scheme r2-upload wrote every artifact to
  // runs/<run>/<path>, so the run prefix was both immutable AND complete --
  // pointing at it meant a pointer write that failed after the R2 upload left
  // readers on the previous run rather than on half-overwritten latest/ objects.
  // #8237 replaced that tree with by-hash/<sha256>, so runs/<run>/<path> is no
  // longer written at all: the 2026-07-26T10-59-03-643Z publish uploaded 5,666
  // objects, flipped the pointer to its run prefix, and every artifact read
  // 404'd because nothing was ever written under it. (The publish's own "Smoke
  // live API" step caught it and failed the workflow -- after the flip.)
  //
  // latest/ is the only complete, readable tree the upload still produces
  // (uploaded_latest_count covers every artifact, every run). Tradeoff, stated
  // plainly: it is mutable, so a reader during an in-flight publish can observe
  // a mix of old and new objects -- the atomicity the run prefix used to buy is
  // genuinely gone, and restoring it needs the Worker to resolve reads through
  // the manifest's per-artifact by-hash keys (too large for the KV pointer as
  // shaped today). Tracked in #8277. A 404 on every artifact is strictly worse
  // than a brief mixed read, so this takes the tradeoff rather than the outage.
  latest_prefix: manifest.latest_prefix,
  run_prefix: manifest.run_prefix,
  manifest_hash: hashJson(manifest),
  artifact_count: manifest.artifact_count,
  native_snapshot_captured_at: (freshness.summary as Row)
    .native_snapshot_captured_at,
  health_surface_count: (freshness.summary as Row).health_surface_count,
};
// metagraph:latest is the ONLY KV control record: the pointer the Worker reads to
// resolve the live R2 artifact prefix. (The former feature-flags /
// endpoint-pools / source-freshness sidecars were written here every publish but
// read by nothing — Worker, UI, or otherwise — so they were removed; reintroduce
// such a blob only together with its reader so it can't drift unread.)
const kvEntries: [string, unknown][] = [["metagraph:latest", pointer]];

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

function putKv(key: string, value: unknown): void {
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
      process.env.METAGRAPH_KV_NAMESPACE_ID as string,
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

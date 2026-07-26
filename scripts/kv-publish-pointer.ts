import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  artifactFilePath,
  hashJson,
  readJson,
  repoRoot,
  stableStringify,
} from "./lib.ts";
import { r2ObjectExists, requireCloudflareCredentials } from "./r2-rest.ts";

type Row = Record<string, unknown>;

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
// Readback sample size for assertPointerPrefixServes below. Small on purpose:
// this is a pre-flight sanity check on the prefix, not a full-tree audit, and
// it spends the same Cloudflare API budget the upload just spent (#8261).
const SAMPLE_MAX = 12;
const SAMPLE_SPREAD = 8;
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

await assertPointerPrefixServes();

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

/**
 * Refuse to flip the pointer unless the prefix it names actually serves.
 *
 * The pointer flip is the single most dangerous write in the publish:
 * workers/storage.ts's latestR2Key builds EVERY live artifact key as
 * `${latest_prefix}${relativePath}`, so a prefix that does not serve takes the
 * entire R2-backed API down in one KV write -- /api/v1/subnets, /coverage and
 * every per-subnet artifact at once. That is exactly what happened on
 * 2026-07-26 (#8276): #8237 moved the history tier to by-hash/<sha256>, nothing
 * was written under runs/<runId>/ any more, the pointer still named it, and the
 * upload reported a clean 5,666/5,666 objects on the way out.
 *
 * The publish's own live smoke step DID catch that -- but it runs after
 * kv:publish, so it reported an outage that was already serving. This check is
 * the same question asked in the other order: read back through the exact key
 * the Worker will build, BEFORE claiming the prefix.
 *
 * Fails closed on a definite miss (non-zero exit, pointer unchanged, previous
 * working pointer still live). Does NOT fail on an indeterminate read -- a
 * flaky network must not block a publish whose data is fine.
 */
async function assertPointerPrefixServes(): Promise<void> {
  const prefix = String(pointer.latest_prefix || "");
  const bucketName = String(manifest.bucket_name || "");
  if (!prefix || !bucketName) {
    console.error(
      `Refusing to publish: pointer latest_prefix (${prefix || "empty"}) or manifest bucket_name (${bucketName || "empty"}) is missing.`,
    );
    process.exit(1);
  }

  const artifacts = (manifest.artifacts as Row[]) || [];
  const relativeOf = (a: Row): string =>
    String(a.path || "").replace(/^\/metagraph\//, "");

  // Sample the artifacts whose loss is TOTAL, not just any artifact: these are
  // the exact shapes that 404'd on 2026-07-26. A per-subnet detail is included
  // because it exercises a nested path, which a flat-only sample would miss.
  const critical = ["subnets.json", "coverage.json"];
  const chosen = new Map<string, string>();
  for (const name of critical) {
    const hit = artifacts.find((a) => relativeOf(a) === name);
    if (hit) chosen.set(name, name);
  }
  const nested = artifacts.find((a) =>
    /^subnets\/\d+\.json$/.test(relativeOf(a)),
  );
  if (nested) chosen.set(relativeOf(nested), relativeOf(nested));

  // Plus a small deterministic spread across the manifest, to catch a
  // partially-populated tree rather than an entirely absent one.
  const step = Math.max(1, Math.floor(artifacts.length / SAMPLE_SPREAD));
  for (let i = 0; i < artifacts.length && chosen.size < SAMPLE_MAX; i += step) {
    const rel = relativeOf(artifacts[i]!);
    if (rel) chosen.set(rel, rel);
  }

  if (chosen.size === 0) {
    console.error(
      "Refusing to publish: no artifacts available to verify the pointer prefix against.",
    );
    process.exit(1);
  }

  const { accountId, apiToken } = requireCloudflareCredentials();
  const missing: string[] = [];
  let indeterminate = 0;
  for (const relative of chosen.keys()) {
    const key = `${prefix}${relative}`;
    const result = await r2ObjectExists(accountId, bucketName, key, apiToken);
    if (result.exists) continue;
    if (result.determinate) missing.push(key);
    else indeterminate += 1;
  }

  if (missing.length > 0) {
    console.error(
      `Refusing to publish the KV pointer: latest_prefix "${prefix}" does not serve ` +
        `${missing.length} of ${chosen.size} sampled artifact(s) in bucket "${bucketName}".\n` +
        `The Worker builds every live key as \`${prefix}<path>\`, so flipping the pointer ` +
        `would 404 the entire R2-backed API. Missing key(s):\n` +
        missing.map((k) => `  - ${k}`).join("\n"),
    );
    process.exit(1);
  }

  console.log(
    `Pointer prefix "${prefix}" verified against ${chosen.size} sampled artifact(s)` +
      (indeterminate > 0
        ? ` (${indeterminate} read(s) indeterminate — not treated as failure).`
        : "."),
  );
}

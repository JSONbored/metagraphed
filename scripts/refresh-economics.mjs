// Live economics writer (#1009 follow-up). Builds the economics blob from the
// current native snapshot + merged overlays — byte-shape-identical to the R2
// economics.json, with the same contract_version stamp — and publishes it to KV
// 'economics:current' (read by resolveLiveEconomics) so /api/v1/economics serves
// fresher-than-6h data DECOUPLED from the fragile 6h publish, falling back to the
// committed R2 economics.json when the KV blob is cold/stale/invalid.
//
// KV-only: a single atomic PUT of the JSON blob via the same arg-array wrangler
// idiom as kv-publish-pointer.mjs (no shell, no hand-built SQL). Tolerant — a
// wrangler failure is a warning, never a hard error (the serve path falls back to
// R2). Run by .github/workflows/refresh-economics.yml AFTER a fresh native-snapshot
// refresh. Gated: --write performs the remote PUT; default is dry-run.
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildEconomicsArtifact,
  buildTimestamp,
  loadNativeSnapshot,
  loadSubnets,
  repoRoot,
  stableStringify,
} from "./lib.mjs";
import { CONTRACT_VERSION } from "../src/contracts.mjs";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");

const subnets = await loadSubnets();
const native = await loadNativeSnapshot();
const economicsByNetuid = new Map();
for (const subnet of native.subnets || []) {
  if (subnet.economics) economicsByNetuid.set(subnet.netuid, subnet.economics);
}

const economics = buildEconomicsArtifact({
  subnets,
  economicsByNetuid,
  generatedAt: buildTimestamp(),
  network: native.network,
  capturedAt: native.captured_at,
});
// Match build-artifacts: economics.json carries the contract stamp, and
// resolveLiveEconomics rejects an off-contract blob (→ R2 fallback).
economics.contract_version = CONTRACT_VERSION;

const summary = {
  with_economics_count: economics.summary?.with_economics_count ?? 0,
  captured_at: economics.captured_at,
  contract_version: economics.contract_version,
};

if (!write) {
  console.log(stableStringify({ mode: "dry-run", ...summary }));
  process.exit(0);
}

// KV 'economics:current' — the live source. Single atomic PUT of the byte-identical
// blob (arg-array, no shell), gated on METAGRAPH_ALLOW_KV_WRITE so a misconfigured
// run can't touch prod KV. Mirrors the kv-publish-pointer.mjs idiom.
let kvStatus = "skipped";
if (process.env.METAGRAPH_ALLOW_KV_WRITE === "1") {
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
      "economics:current",
      JSON.stringify(economics),
      "--namespace-id",
      process.env.METAGRAPH_KV_NAMESPACE_ID,
      "--remote",
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
  kvStatus = result.status === 0 ? "written" : "failed";
  if (result.status !== 0) {
    console.warn(
      `::warning::kv:economics put failed (exit ${result.status}); live economics keeps the last value, serve falls back to R2. ${(result.stderr || "").slice(0, 300)}`,
    );
  }
}

console.log(stableStringify({ mode: "write", kv: kvStatus, ...summary }));

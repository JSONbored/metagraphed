// Live economics writer (#1009 follow-up). Builds the economics blob from the
// current native snapshot + merged overlays — byte-shape-identical to the R2
// economics.json, with the same contract_version stamp — and publishes it to KV
// 'economics:current' (read by resolveLiveEconomics) so /api/v1/economics serves
// fresh data on its own ~3h cadence DECOUPLED from the DATA publish, falling back to the
// committed R2 economics.json when the KV blob is cold/stale/invalid.
//
// KV-only: a single atomic PUT of the JSON blob via the same arg-array wrangler
// idiom as kv-publish-pointer.ts (no shell, no hand-built SQL). Tolerant — a
// wrangler failure is a warning, never a hard error (the serve path falls back to
// R2). Run by the indexer-box data-refresh-economics systemd timer
// (JSONbored/metagraphed-infra, moved off the former GitHub Actions
// refresh-economics.yml 2026-07-15) AFTER a fresh native-snapshot refresh.
// Gated: --write performs the remote PUT; default is dry-run.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  buildEconomicsArtifact,
  buildTimestamp,
  loadNativeSnapshot,
  loadSubnets,
  repoRoot,
  stableStringify,
} from "./lib.ts";
import { loadAlphaPriceHistoryByNetuid } from "./lib/load-alpha-price-history.ts";
import { CONTRACT_VERSION } from "../src/contracts.ts";
import { KV_ECONOMICS_CURRENT } from "../src/kv-keys.ts";
import { shouldPublishEconomics } from "./economics-floor.ts";
import { initSentry, endSessionAndFlush } from "./observability.ts";

type Row = Record<string, unknown>;

initSentry("refresh-economics");

const args = new Set(process.argv.slice(2));
const write = args.has("--write");

const subnets: Row[] = await loadSubnets();
const native: Row = await loadNativeSnapshot();
const economicsByNetuid = new Map<number, Row>();
for (const subnet of (native.subnets as Row[] | undefined) || []) {
  if (subnet.economics) {
    economicsByNetuid.set(subnet.netuid as number, subnet.economics as Row);
  }
}

// #7227: bake alpha_price_change_* from subnet_snapshots when DATABASE_URL is
// present (indexer box). Missing DB → null change fields (schema-stable).
const priceHistoryByNetuid = await loadAlphaPriceHistoryByNetuid();

const economics = buildEconomicsArtifact({
  subnets,
  economicsByNetuid,
  generatedAt: buildTimestamp(),
  network: native.network as string | null,
  capturedAt: native.captured_at as string | null,
  priceHistoryByNetuid,
});
// Match build-artifacts: economics.json carries the contract stamp, and
// resolveLiveEconomics rejects an off-contract blob (→ R2 fallback).
economics.contract_version = CONTRACT_VERSION;

const summary = {
  with_economics_count:
    (economics.summary as Row | undefined)?.with_economics_count ?? 0,
  captured_at: economics.captured_at,
  contract_version: economics.contract_version,
};

if (!write) {
  console.log(stableStringify({ mode: "dry-run", ...summary }));
  await endSessionAndFlush();
  process.exit(0);
}

// Content floor: never overwrite the live tier with an empty / near-empty blob. A
// partial chain-fetch (0 rows, or far below the subnet count) or a missing
// captured_at must not clobber the last good KV value — warn + exit 0 so the serve
// path keeps the last live value (or falls back to R2). Logic lives in the pure
// shouldPublishEconomics helper so its boundaries are unit-tested.
const expectedCount = subnets.length;
const floor = shouldPublishEconomics(summary, expectedCount);
if (!floor.publish) {
  console.warn(
    `::warning::economics blob failed the content floor (${floor.reason}; with_economics_count=${summary.with_economics_count} of ~${expectedCount}, captured_at=${economics.captured_at}); keeping the last live value.`,
  );
  console.log(
    stableStringify({
      mode: "skipped-floor",
      reason: floor.reason,
      ...summary,
    }),
  );
  await endSessionAndFlush();
  process.exit(0);
}

// KV 'economics:current' — the live source. Gated on METAGRAPH_ALLOW_KV_WRITE so a
// misconfigured run can't touch prod KV. The ~100 KB blob is passed via --path (a
// temp file), not argv, to stay clear of the per-arg byte limit. Mirrors the
// kv-publish-pointer.ts idiom.
let kvStatus = "skipped";
if (process.env.METAGRAPH_ALLOW_KV_WRITE === "1") {
  if (!process.env.METAGRAPH_KV_NAMESPACE_ID) {
    console.error(
      "METAGRAPH_KV_NAMESPACE_ID is required when METAGRAPH_ALLOW_KV_WRITE=1",
    );
    process.exit(1);
  }
  const wranglerBin = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler",
  );
  const blobPath = path.join(repoRoot, "dist", "economics-current.json");
  mkdirSync(path.dirname(blobPath), { recursive: true });
  writeFileSync(blobPath, JSON.stringify(economics));
  const result = spawnSync(
    wranglerBin,
    [
      "kv",
      "key",
      "put",
      KV_ECONOMICS_CURRENT,
      "--path",
      blobPath,
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
await endSessionAndFlush();

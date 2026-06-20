// Live economics writer (#1009 follow-up). Builds the economics blob from the
// current native snapshot + merged overlays — byte-shape-identical to the R2
// economics.json, with the same contract_version stamp — and publishes it to the
// live tier so /api/v1/economics serves fresher-than-6h data DECOUPLED from the 6h
// publish: KV 'economics:current' (primary, read by resolveLiveEconomics) + the
// D1 subnet_economics durability mirror. Tolerant: any wrangler failure is a
// warning, never a hard error — the serve path falls back to KV→R2 regardless.
//
// Run by .github/workflows/refresh-economics.yml AFTER a fresh native-snapshot
// refresh. Gated: --write performs the remote writes; default is dry-run.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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

const wranglerBin = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler",
);
function wrangler(argv) {
  return spawnSync(wranglerBin, argv, { encoding: "utf8", stdio: "pipe" });
}
function warn(step, result) {
  console.warn(
    `::warning::${step} failed (exit ${result.status}); live economics keeps the last value. ${(result.stderr || "").slice(0, 300)}`,
  );
}

// (1) KV 'economics:current' — the PRIMARY live source. Single atomic PUT of the
// byte-identical blob, gated on METAGRAPH_ALLOW_KV_WRITE so a misconfigured run
// can't touch prod KV.
let kvStatus = "skipped";
if (process.env.METAGRAPH_ALLOW_KV_WRITE === "1") {
  const result = wrangler([
    "kv",
    "key",
    "put",
    "economics:current",
    JSON.stringify(economics),
    "--namespace-id",
    process.env.METAGRAPH_KV_NAMESPACE_ID,
    "--remote",
  ]);
  kvStatus = result.status === 0 ? "written" : "failed";
  if (result.status !== 0) warn("kv:economics", result);
}

// (2) D1 subnet_economics — best-effort durability mirror (not read on the serve
// path; reserved for durability/observability). One transaction: clear + upsert.
let d1Status = "skipped";
if (process.env.METAGRAPH_ALLOW_D1_WRITE === "1") {
  const sql = buildEconomicsUpsertSql(economics, buildTimestamp());
  const sqlPath = path.join(repoRoot, "dist", "economics-upsert.sql");
  writeFileSync(sqlPath, sql);
  const result = wrangler([
    "d1",
    "execute",
    "metagraphed-health",
    "--remote",
    "--file",
    sqlPath,
  ]);
  d1Status = result.status === 0 ? "written" : "failed";
  if (result.status !== 0) warn("d1:economics", result);
}

console.log(
  stableStringify({ mode: "write", kv: kvStatus, d1: d1Status, ...summary }),
);

// --- SQL generation (escaped, parameter-free since `wrangler d1 execute --file`
// runs raw SQL). Numbers/nulls emitted directly; text single-quote-escaped. ---
function sqlText(value) {
  if (value === null || value === undefined) return "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}
function sqlNum(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : "NULL";
}
function sqlInt(value) {
  return Number.isInteger(value) ? String(value) : "NULL";
}
function sqlBool(value) {
  return value === true ? "1" : value === false ? "0" : "NULL";
}
function buildEconomicsUpsertSql(blob, updatedAtIso) {
  const updatedAt = Date.parse(updatedAtIso) || 0;
  const cols = [
    "netuid",
    "slug",
    "name",
    "max_uids",
    "validator_count",
    "max_validators",
    "miner_count",
    "registration_allowed",
    "registration_cost_tao",
    "alpha_price_tao",
    "emission_share",
    "total_stake_tao",
    "max_stake_tao",
    "tao_in_pool_tao",
    "alpha_in_pool",
    "alpha_out_pool",
    "subnet_volume_tao",
    "owner_hotkey",
    "owner_coldkey",
    "captured_at",
    "contract_version",
    "updated_at",
  ];
  const rows = (blob.subnets || []).map(
    (row) =>
      `(${[
        sqlInt(row.netuid),
        sqlText(row.slug),
        sqlText(row.name),
        sqlInt(row.max_uids),
        sqlInt(row.validator_count),
        sqlInt(row.max_validators),
        sqlInt(row.miner_count),
        sqlBool(row.registration_allowed),
        sqlNum(row.registration_cost_tao),
        sqlNum(row.alpha_price_tao),
        sqlNum(row.emission_share),
        sqlNum(row.total_stake_tao),
        sqlNum(row.max_stake_tao),
        sqlNum(row.tao_in_pool_tao),
        sqlNum(row.alpha_in_pool),
        sqlNum(row.alpha_out_pool),
        sqlNum(row.subnet_volume_tao),
        sqlText(row.owner_hotkey),
        sqlText(row.owner_coldkey),
        sqlText(blob.captured_at),
        sqlText(blob.contract_version),
        sqlNum(updatedAt),
      ].join(",")})`,
  );
  if (rows.length === 0)
    return "BEGIN;\nDELETE FROM subnet_economics;\nCOMMIT;\n";
  return [
    "BEGIN;",
    "DELETE FROM subnet_economics;",
    `INSERT INTO subnet_economics (${cols.join(",")}) VALUES`,
    `${rows.join(",\n")};`,
    "COMMIT;",
    "",
  ].join("\n");
}

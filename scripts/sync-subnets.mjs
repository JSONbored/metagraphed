import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  nativeNameQuality,
  readJson,
  repoRoot,
  stableStringify,
  writeJson,
} from "./lib.mjs";

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const snapshotPath = path.join(repoRoot, "registry/native/finney-subnets.json");

const snapshot = fetchNativeSnapshot();
const existing = await readExistingSnapshot();
const tmcCount = await fetchTaoMarketCapCount();
const diff = diffSnapshots(existing, snapshot);

const summary = {
  mode: dryRun ? "dry-run" : "write",
  network: snapshot.network,
  source: snapshot.source,
  captured_at: snapshot.captured_at,
  native_subnet_count: snapshot.subnets.length,
  tao_market_cap_count: tmcCount,
  added_netuids: diff.added,
  removed_netuids: diff.removed,
  renamed_netuids: diff.renamed,
  identity_warnings: diff.identityWarnings,
  symbol_changed_netuids: diff.symbolChanged,
  block_range: {
    min: Math.min(...snapshot.subnets.map((subnet) => subnet.block)),
    max: Math.max(...snapshot.subnets.map((subnet) => subnet.block)),
  },
};

if (!dryRun) {
  await writeJson(snapshotPath, snapshot);
}

console.log(stableStringify(summary));

function fetchNativeSnapshot() {
  const result = spawnSync(
    "uvx",
    [
      "--from",
      "bittensor==10.4.0",
      "python",
      "scripts/fetch-native-subnets.py",
      "--network",
      "finney",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      [
        "Failed to fetch native Bittensor subnet snapshot.",
        "Install uv or run the Bittensor SDK helper manually.",
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return JSON.parse(result.stdout);
}

async function readExistingSnapshot() {
  try {
    return await readJson(snapshotPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { subnets: [] };
    }
    throw error;
  }
}

async function fetchTaoMarketCapCount() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(
      "https://api.taomarketcap.com/public/v1/subnets/?limit=1",
      {
        headers: {
          accept: "application/json",
          "user-agent": "metagraphed-subnet-sync/0.0",
        },
        signal: controller.signal,
      },
    );
    clearTimeout(timer);
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    return Number.isInteger(body.count) ? body.count : null;
  } catch {
    return null;
  }
}

function diffSnapshots(existing, current) {
  const existingByNetuid = new Map(
    (existing.subnets || []).map((subnet) => [subnet.netuid, subnet]),
  );
  const currentByNetuid = new Map(
    current.subnets.map((subnet) => [subnet.netuid, subnet]),
  );
  const added = [];
  const removed = [];
  const renamed = [];
  const identityWarnings = [];
  const symbolChanged = [];

  for (const netuid of currentByNetuid.keys()) {
    if (!existingByNetuid.has(netuid)) {
      added.push(netuid);
      continue;
    }
    const before = existingByNetuid.get(netuid);
    const after = currentByNetuid.get(netuid);
    const beforeNameQuality = nativeNameQuality(before);
    const afterNameQuality = nativeNameQuality(after);
    if (before.name !== after.name) {
      if (beforeNameQuality === "chain" && afterNameQuality === "chain") {
        renamed.push({ netuid, before: before.name, after: after.name });
      } else {
        identityWarnings.push({
          netuid,
          before: before.name,
          after: after.name,
          before_quality: beforeNameQuality,
          after_quality: afterNameQuality,
          reason:
            afterNameQuality === "chain"
              ? "native-name-recovered"
              : "native-name-placeholder",
        });
      }
    }
    if (before.symbol !== after.symbol) {
      symbolChanged.push({
        netuid,
        before: before.symbol,
        after: after.symbol,
      });
    }
  }

  for (const netuid of existingByNetuid.keys()) {
    if (!currentByNetuid.has(netuid)) {
      removed.push(netuid);
    }
  }

  return { added, removed, renamed, identityWarnings, symbolChanged };
}

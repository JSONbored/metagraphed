import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  nativeNameQuality,
  readJson,
  repoRoot,
  stableStringify,
  writeJson,
} from "./lib.ts";

interface NativeSubnet {
  netuid: number;
  name: string;
  symbol?: string;
  block: number;
  [key: string]: unknown;
}

interface NativeSnapshot {
  network?: string;
  source?: string;
  captured_at?: string;
  subnets: NativeSubnet[];
}

const args = new Set(process.argv.slice(2));
const shouldWrite = args.has("--write");
const dryRun = args.has("--dry-run") || !shouldWrite;
const snapshotPath = path.join(repoRoot, "registry/native/finney-subnets.json");
const testnetSnapshotPath = path.join(
  repoRoot,
  "registry/native/test-subnets.json",
);

// Same SUBTENSOR_RPC_URL convention as the other native chain-fetch scripts
// (ADR 0012): unset -> "finney" (public), set -> route through our own node
// without exposing it. fetchTestnetSnapshot() below is untouched -- it's a
// distinct chain ("test"), not served by our mainnet fullnode.
const snapshot = fetchNativeSnapshot(process.env.SUBTENSOR_RPC_URL || "finney");
const existing = await readExistingSnapshot(snapshotPath);
const tmcCount = await fetchTaoMarketCapCount();
const diff = diffSnapshots(existing, snapshot);

// Testnet is a best-effort SECONDARY registry — a testnet RPC failure must never
// block the critical finney sync. Opt out with METAGRAPH_SKIP_TESTNET_SYNC=1.
const testnetSnapshot = fetchTestnetSnapshot();

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
  testnet: testnetSnapshot
    ? {
        network: testnetSnapshot.network,
        captured_at: testnetSnapshot.captured_at,
        native_subnet_count: testnetSnapshot.subnets.length,
      }
    : { skipped: true },
};

if (!dryRun) {
  await writeJson(snapshotPath, snapshot);
  if (testnetSnapshot) {
    await writeJson(testnetSnapshotPath, testnetSnapshot);
  }
}

console.log(stableStringify(summary));

// Best-effort testnet capture: never throws (a failure is logged + skipped so
// the finney sync still succeeds).
function fetchTestnetSnapshot(): NativeSnapshot | null {
  if (process.env.METAGRAPH_SKIP_TESTNET_SYNC === "1") {
    return null;
  }
  try {
    return fetchNativeSnapshot("test");
  } catch (error) {
    console.warn(
      `::warning::testnet native fetch failed (best-effort; finney sync unaffected): ${(error as Error).message}`,
    );
    return null;
  }
}

// Synchronous backoff between retries (spawnSync is blocking; Atomics.wait gives
// a clean sync sleep without a busy-loop).
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The chain RPC the Bittensor SDK hits is rate-limited and occasionally flaky —
// the failure mode that previously stalled the sync for ~40h and cascaded into a
// blocked publish. Retry with exponential backoff before giving up.
function fetchNativeSnapshot(network = "finney"): NativeSnapshot {
  const maxAttempts = Number(process.env.METAGRAPH_NATIVE_FETCH_ATTEMPTS) || 3;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = spawnSync(
      "uvx",
      [
        "--from",
        "bittensor==10.4.0",
        "python",
        "scripts/fetch-native-subnets.py",
        "--network",
        network,
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 20,
      },
    );

    if (result.status === 0) {
      try {
        return JSON.parse(result.stdout);
      } catch (error) {
        lastError = new Error(
          `Native subnet snapshot was not valid JSON: ${(error as Error).message}`,
        );
      }
    } else {
      const errorMessage = result.error?.message
        ? `spawn error: ${result.error.message}`
        : null;
      const stderr =
        typeof result.stderr === "string" ? result.stderr.trim() : "";
      const stdout =
        typeof result.stdout === "string" ? result.stdout.trim() : "";
      lastError = new Error(
        [
          "Failed to fetch native Bittensor subnet snapshot.",
          "Install uv or run the Bittensor SDK helper manually.",
          errorMessage,
          stderr,
          stdout,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      // A spawn failure (e.g. uvx not installed) is permanent — fail fast instead
      // of burning the backoff. Only a non-zero EXIT (chain RPC rate-limit/flake)
      // is worth retrying.
      if (result.error) {
        throw lastError;
      }
    }

    if (attempt < maxAttempts) {
      const backoffMs = 5000 * 2 ** (attempt - 1); // 5s, 10s, 20s…
      console.warn(
        `::warning::native subnet fetch attempt ${attempt}/${maxAttempts} failed; retrying in ${backoffMs / 1000}s`,
      );
      sleepSync(backoffMs);
    }
  }

  throw lastError;
}

async function readExistingSnapshot(
  snapshotFilePath: string,
): Promise<NativeSnapshot> {
  try {
    return await readJson(snapshotFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { subnets: [] };
    }
    throw error;
  }
}

async function fetchTaoMarketCapCount(): Promise<number | null> {
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
    const body = (await response.json()) as { count?: unknown };
    return Number.isInteger(body.count) ? (body.count as number) : null;
  } catch {
    return null;
  }
}

function diffSnapshots(existing: NativeSnapshot, current: NativeSnapshot) {
  const existingByNetuid = new Map(
    (existing.subnets || []).map((subnet) => [subnet.netuid, subnet]),
  );
  const currentByNetuid = new Map(
    current.subnets.map((subnet) => [subnet.netuid, subnet]),
  );
  const added: number[] = [];
  const removed: number[] = [];
  const renamed: { netuid: number; before: string; after: string }[] = [];
  const identityWarnings: {
    netuid: number;
    before: string;
    after: string;
    before_quality: unknown;
    after_quality: unknown;
    reason: string;
  }[] = [];
  const symbolChanged: {
    netuid: number;
    before: string | undefined;
    after: string | undefined;
  }[] = [];

  for (const netuid of currentByNetuid.keys()) {
    if (!existingByNetuid.has(netuid)) {
      added.push(netuid);
      continue;
    }
    const before = existingByNetuid.get(netuid) as NativeSubnet;
    const after = currentByNetuid.get(netuid) as NativeSubnet;
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

// #8749: capture one block's emission-pipeline state as a committed fixture.
//
//     node scripts/capture-emission-fixture.ts --write
//
// EVERY READ IS PINNED TO ONE BLOCK HASH. theta recomputes when
// block % 360 == 0 and the moving-price EMAs move every block, so a fixture
// assembled from unpinned reads would mix states that never coexisted and the
// harness would chase a reconstruction error that is really a capture bug.
//
// The fixture is what makes tests/emission-pipeline.test.ts deterministic and
// offline. Re-capturing is a deliberate act with a visible diff: if a refresh
// moves the reconstruction error, that is a finding, not noise to be absorbed.

import { promises as fs } from "node:fs";
import path from "node:path";
import { repoRoot } from "./lib.ts";

const RPC_URL =
  process.env.EMISSION_FIXTURE_RPC_URL ??
  "https://entrypoint-finney.opentensor.ai:443";
const RPC_TIMEOUT_MS = 20_000;
const MAX_NETUID = 128;

/** twox128("SubtensorModule"). */
const PALLET = "658faa385070e074c85bf6b568cf0555";

/** twox128(<item>) for the per-netuid Identity-hashed maps. */
const MAPS = {
  moving_price: "1abf1b0f4fd14f7b72ee50f9d91d5915",
  miner_burned: "1eac6222ebba7feba4ca36a94736815e",
  emission_enabled: "c97bb5c5631e5f593b5bd2da84a5fa16",
  first_emission_block: "e4cfee4e36f2419d8863a3fda65c428f",
  subtoken_enabled: "e9348e9224ea06c9c2da12ce69e619c5",
  registration_allowed: "d5fe74da02c7b4bbb340fb368eee3e77",
  tao_in_emission: "dd62ae7237581e8f6a684f1ecae06215",
  excess_tao: "857b0a5b920bc5e41cb0695a4b7d38e7",
} as const;

/** Network-level StorageValues. */
const VALUES = {
  emission_gate_bar: "7c9b0d2964cc73e7519676c3cc4d5df9",
  emission_bar_quantile: "a772007dde2ed63e0f21b5f9d7f16650",
  emission_gate_exponent: "88c70e8dd0cf4af3aeb977ba2eee1df4",
  total_issuance: "57c875e4cff74148e4628f264b974c80",
} as const;

let rpcId = 0;

async function rpc<T>(method: string, params: unknown[]): Promise<T> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: (rpcId += 1), method, params }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`);
  const body = (await response.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result as T;
}

/** netuid as u16 little-endian — Identity hasher, so no hashing. */
function netuidSuffix(netuid: number): string {
  return (
    (netuid % 256).toString(16).padStart(2, "0") +
    Math.floor(netuid / 256)
      .toString(16)
      .padStart(2, "0")
  );
}

async function readMap(
  itemHash: string,
  blockHash: string,
): Promise<Record<number, string | null>> {
  const netuids = Array.from({ length: MAX_NETUID }, (_, i) => i);
  const keys = netuids.map((n) => `0x${PALLET}${itemHash}${netuidSuffix(n)}`);
  const result = await rpc<{ changes: [string, string | null][] }[]>(
    "state_queryStorageAt",
    [keys, blockHash],
  );
  const out: Record<number, string | null> = {};
  for (const [key, value] of result[0]?.changes ?? []) {
    // Recover the netuid from the key's own trailing u16 rather than trusting
    // the response to come back in request order.
    const suffix = key.slice(-4);
    const netuid =
      Number.parseInt(suffix.slice(0, 2), 16) +
      Number.parseInt(suffix.slice(2, 4), 16) * 256;
    if (value !== null) out[netuid] = value;
  }
  return out;
}

async function main(): Promise<void> {
  const header = await rpc<{ number: string }>("chain_getHeader", []);
  const blockNumber = Number.parseInt(header.number, 16);
  const blockHash = await rpc<string>("chain_getBlockHash", [blockNumber]);

  const maps: Record<string, Record<number, string | null>> = {};
  for (const [name, hash] of Object.entries(MAPS)) {
    maps[name] = await readMap(hash, blockHash);
  }
  const values: Record<string, string | null> = {};
  for (const [name, hash] of Object.entries(VALUES)) {
    values[name] = await rpc<string | null>("state_getStorage", [
      `0x${PALLET}${hash}`,
      blockHash,
    ]);
  }

  const fixture = {
    // Raw hex exactly as the node returned it. Decoding belongs to the code
    // under test, not to the capture -- a fixture of pre-decoded numbers would
    // test the reconstruction against this script's decoder rather than
    // against the chain.
    captured_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    network: "finney",
    block_number: blockNumber,
    block_hash: blockHash,
    // The block theta was last recomputed at, so a reader can see how stale
    // the stored bar is without recomputing it.
    last_gate_block: blockNumber - (blockNumber % 360),
    storage_prefix: `0x${PALLET}`,
    item_hashes: { ...MAPS, ...VALUES },
    values,
    maps,
  };

  const out = path.join(repoRoot, "tests/fixtures/emission-pipeline.json");
  if (process.argv.includes("--write")) {
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(
      `Captured block ${blockNumber} (gate block ${fixture.last_gate_block}) -> ${path.relative(repoRoot, out)}`,
    );
  } else {
    console.log(JSON.stringify(fixture, null, 2));
  }
}

await main();

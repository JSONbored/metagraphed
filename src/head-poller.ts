// Chain head poller — the firehose's ingest source after the box (#204).
//
// The retired box-side relay forwarded Postgres NOTIFY payloads produced by
// indexer-rs; with the box gone the DO polls the public archive endpoint
// itself. ONLY the `blocks` lane: extrinsics/chain_events/account_events need
// SCALE decoding against runtime metadata, which is the Containers indexer's
// job (#209) — a Worker faking those lanes from undecoded bytes would serve
// wrong data, and serving a quarter of the stream honestly beats serving four
// lanes wrongly.
//
// Pure functions here; the DO owns storage/broadcast (chain-firehose-hub.ts).
// Every RPC is plain HTTP JSON-RPC against CHAIN_HEAD_RPC_URL — the same
// public endpoint everything else already reads (live-verified for months).

export interface HeadBlock {
  table: "blocks";
  block_number: number;
  block_hash: string;
  parent_hash: string;
  extrinsic_count: number;
  observed_at: number;
}

interface RpcResponse {
  result?: unknown;
  error?: { message?: string };
}

async function rpc(
  url: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch,
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as RpcResponse;
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

export function hexToNumber(hex: unknown): number {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`not a hex quantity: ${String(hex)}`);
  }
  return Number.parseInt(hex, 16);
}

/** The chain's current head number, from one cheap header read. */
export async function fetchHeadNumber(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const header = (await rpc(url, "chain_getHeader", [], fetchImpl)) as {
    number?: unknown;
  };
  return hexToNumber(header?.number);
}

/**
 * One finalized-ish block at an exact height, as a firehose `blocks` payload.
 * Three reads: hash at height, header, body (for the extrinsic count the UI's
 * block rail renders). Scalar fields only, per the ingest validator's rules.
 */
export async function fetchBlockAt(
  url: string,
  number: number,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<HeadBlock> {
  const hash = (await rpc(
    url,
    "chain_getBlockHash",
    [number],
    fetchImpl,
  )) as string;
  if (typeof hash !== "string" || !hash.startsWith("0x")) {
    throw new Error(`no hash at height ${number}`);
  }
  const block = (await rpc(url, "chain_getBlock", [hash], fetchImpl)) as {
    block?: {
      header?: { parentHash?: string };
      extrinsics?: unknown[];
    };
  };
  return {
    table: "blocks",
    block_number: number,
    block_hash: hash,
    parent_hash: String(block?.block?.header?.parentHash ?? ""),
    extrinsic_count: Array.isArray(block?.block?.extrinsics)
      ? block.block.extrinsics.length
      : 0,
    observed_at: now(),
  };
}

/**
 * Which heights to emit this tick. Bounded on purpose: after an outage the
 * poller catches up at most `maxCatchUp` blocks per tick rather than hammering
 * the endpoint with an unbounded burst — deeper history is the backfill's job,
 * not the live poller's. `lastSeen = null` (first ever tick) starts AT the
 * head, not behind it: the poller's contract is "live from now", and the gap
 * behind it belongs to the reconciling backfill.
 */
export function heightsToEmit(
  lastSeen: number | null,
  head: number,
  maxCatchUp = 25,
): number[] {
  if (!Number.isInteger(head) || head < 0) return [];
  if (lastSeen === null || lastSeen >= head) {
    return lastSeen === null ? [head] : [];
  }
  const start = Math.max(lastSeen + 1, head - maxCatchUp + 1);
  const out: number[] = [];
  for (let n = start; n <= head; n += 1) out.push(n);
  return out;
}

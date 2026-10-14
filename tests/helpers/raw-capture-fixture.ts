import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import {
  substrateHeader,
  SUBSTRATE_ZERO_HASH,
} from "../../src/substrate-header.ts";
import { RAW_CAPTURE_GENESIS } from "../../src/raw-capture-provenance.ts";
import type { ChainNetworkId } from "../../src/chain-network.ts";
import { rawCaptureD1 } from "../../src/raw-capture-d1.ts";

export async function nativeRawFixture(
  beforeFinality?: (db: D1Database) => Promise<void>,
  options: {
    persistDirectory?: string;
    beforePublication?: (db: D1Database) => Promise<void>;
  } = {},
) {
  const runtime = new Miniflare({
    modules: true,
    script: "export default {fetch(){return new Response('test')}}",
    compatibilityDate: "2026-06-06",
    d1Databases: ["DB"],
    d1Persist: options.persistDirectory,
  });
  const db = await runtime.getD1Database("DB");
  for (const name of [
    "0001_lane_health.sql",
    "0002_lane_health_current.sql",
    "0003_lane_health_history_indexes.sql",
    "0006_capture_governance.sql",
    "0016_archive_export_revisions.sql",
    "0028_raw_capture_storage.sql",
    "0029_raw_capture_archive.sql",
    "0038_raw_capture_publications.sql",
    "0039_self_stake_snapshot_receipts.sql",
    "0040_raw_capture_finality.sql",
  ]) {
    if (name === "0038_raw_capture_publications.sql")
      await options.beforePublication?.(db);
    if (name === "0040_raw_capture_finality.sql") await beforeFinality?.(db);
    const sql = readFileSync(
      new URL(`../../migrations/d1/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of sql
      .split("-- statement-breakpoint")
      .filter((s) => s.trim()))
      await db.prepare(statement).run();
  }
  return {
    runtime,
    db,
    store: rawCaptureD1(db),
    env: {
      RAW_CAPTURE_STORAGE: "d1",
      RAW_CAPTURE_ENABLED: "true",
      D1_STATE_TABLES: "raw_capture_state,lane_health",
      D1_STATE: db,
    },
  };
}

const seedHash = (value: string) =>
  `0x${createHash("sha256").update(value).digest("hex")}`;
export function syntheticNode(
  options: {
    network?: ChainNetworkId;
    first?: number;
    head?: number;
    seed?: string;
    failAt?: number;
    eventsAt?: number;
    badHeaderAt?: number;
    badParentAt?: number;
    genesis?: string;
    httpOnce?: number;
    shuffle?: boolean;
  } = {},
) {
  const network = options.network ?? "mainnet",
    first = options.first ?? 10,
    head = options.head ?? first + 4,
    seed = options.seed ?? network;
  const headers = new Map<number, Record<string, unknown>>(),
    byHash = new Map<string, number>();
  let previous = seedHash(`synthetic-window-parent:${seed}`);
  for (let height = Math.max(0, first - 1); height <= head; height++) {
    const h = {
      number: `0x${height.toString(16)}`,
      parentHash:
        height === 0
          ? SUBSTRATE_ZERO_HASH
          : options.badParentAt === height
            ? seedHash("disconnected-parent")
            : previous,
      stateRoot: seedHash(`${seed}:state:${height}`),
      extrinsicsRoot: seedHash(`${seed}:extrinsics:${height}`),
      digest: { logs: ["0x0000"] },
    };
    previous = substrateHeader(h).hash;
    headers.set(height, h);
    byHash.set(previous, height);
  }
  const hash = (height: number) =>
    height === 0
      ? (options.genesis ?? RAW_CAPTURE_GENESIS[network])
      : substrateHeader(headers.get(height)).hash;
  const availableHash = (height: number) =>
    height === 0 || headers.has(height) ? hash(height) : null;
  const requests: { method: string; params: unknown[]; request: number }[] = [];
  let request = 0;
  const fetchImpl: typeof fetch = async (_url, init) => {
    request++;
    if (request === 1 && options.httpOnce)
      return new Response(null, { status: options.httpOnce });
    const body = JSON.parse(String(init?.body));
    const calls = Array.isArray(body) ? body : [body];
    const replies = calls.map(
      (call: { id: unknown; method: string; params: unknown[] }) => {
        requests.push({ method: call.method, params: call.params, request });
        let result: unknown;
        if (call.method === "chain_getFinalizedHead") result = hash(head);
        else if (call.method === "chain_getHeader")
          result = headers.get(byHash.get(String(call.params[0]))!);
        else if (call.method === "chain_getBlockHash")
          result = Array.isArray(call.params[0])
            ? call.params[0].map((n) => availableHash(Number(n)))
            : availableHash(Number(call.params[0]));
        else {
          const height = byHash.get(
            String(call.params[call.method === "chain_getBlock" ? 0 : 1]),
          );
          if (options.failAt === height)
            return {
              jsonrpc: "2.0",
              id: call.id,
              error: {
                code: -32000,
                message: `state already discarded at ${height}`,
              },
            };
          if (call.method === "chain_getBlock") {
            const h = headers.get(height!);
            result = {
              block: {
                header:
                  options.badHeaderAt === height
                    ? { ...h, stateRoot: seedHash("tampered-root") }
                    : h,
                extrinsics: ["0x0401"],
              },
            };
          } else if (call.method === "state_getStorage")
            result = options.eventsAt === height ? null : "0x00";
          else
            return {
              jsonrpc: "2.0",
              id: call.id,
              error: { code: -32601, message: "unknown fixture method" },
            };
        }
        return { jsonrpc: "2.0", id: call.id, result: result ?? null };
      },
    );
    return Response.json(
      Array.isArray(body)
        ? options.shuffle
          ? replies.reverse()
          : replies
        : replies[0],
    );
  };
  return { fetchImpl, hash, headers, requests, first, head, network };
}

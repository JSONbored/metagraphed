import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test, vi } from "vitest";
import { ChainFirehoseHub } from "../workers/chain-firehose-hub.ts";
import { handleBlocks } from "../workers/request-handlers/entities.ts";
import { apiEnv } from "../scripts/lib/worker-env.ts";
import { mockEnv, jsonBody } from "./row-type.ts";
import { DEFAULT_BLOCKS_SEAM as SEAM } from "../src/blocks-seam.ts";

// Execute the production reader's SQL, including its ORDER BY and seeks. A
// preordered transport mock cannot expose observation-time ordering regressions.
function binding(sql: DatabaseSync) {
  const prepare = (text: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => prepare(text, next),
    all: async () => ({ success: true, results: sql.prepare(text).all(...values as never[]), meta: {} }),
    run: async () => ({ success: true, results: sql.prepare(text).all(...values as never[]), meta: {} }),
  });
  return { prepare, batch: async (statements: ReturnType<typeof prepare>[]) => Promise.all(statements.map(s => s.all())) } as unknown as Pick<D1Database, "prepare" | "batch">;
}

test("actual block handler keeps live heights first while honest later observations repair old heights", async () => {
  const app = new DatabaseSync(":memory:"), retained = new DatabaseSync(":memory:");
  const originalFetch = globalThis.fetch;
  const start = Date.now(); let clock = start;
  const now = vi.spyOn(Date, "now").mockImplementation(() => ++clock);
  try {
    const migrations = new URL("../migrations/d1/", import.meta.url);
    for (const file of readdirSync(migrations).filter(f => f.endsWith(".sql")).sort()) app.exec(readFileSync(new URL(file, migrations), "utf8"));
    retained.exec(readFileSync(new URL("../migrations/retained-blocks/0001_retained_blocks.sql", import.meta.url), "utf8"));
    retained.prepare("INSERT INTO history_block_sources VALUES(1,'one',0,'{}',4,4,1)").run();
    for (const [ordinal, height] of [SEAM, SEAM-1, SEAM-1, null].entries()) retained.prepare("INSERT INTO history_blocks VALUES(0,1,?,?,?,NULL,NULL,1,1,1,?)").run(ordinal,height,`0xcold${ordinal}`,ordinal === 3 ? null : start-1000);
    retained.prepare("INSERT INTO history_block_state VALUES(0,?,?,?,1,?,4,1,NULL)").run("a".repeat(64),"019fc234-642e-7f82-b656-ddb8529315ab","99",start);
    const env = mockEnv({ D1_STATE: binding(app), D1_STATE_TABLES: "blocks_head,chain_detail_blocks,lane_health", D1_RETAINED_BLOCKS: binding(retained), RETAINED_BLOCKS_NETWORKS: "mainnet", ICEBERG_BLOCKS_MAX: String(SEAM), CHAIN_HEAD_POLL_ENABLED: "true", CHAIN_HEAD_RPC_URL: "https://rpc.example" });
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body)) as {method: string; params: number[]};
      const result = rpc.method === "chain_getHeader" ? {number: `0x${(SEAM+1001).toString(16)}`} : rpc.method === "chain_getBlockHash" ? `0x${rpc.params[0]}` : {block: {header: {parentHash: "0xp"}, extrinsics: ["0x00"]}};
      return Response.json({result});
    }) as typeof fetch;
    const storage = new Map<string, unknown>([["head:last_seen", SEAM+1000],["head:write_next",SEAM+15]]);
    const state = { getWebSockets: () => [], acceptWebSocket: () => {}, waitUntil: (p: Promise<unknown>) => void p.catch(() => {}), storage: {get: async (key: string) => storage.get(key), put: async (key: string,value: unknown) => void storage.set(key,value), getAlarm: async () => null, setAlarm: async () => {}} };
    const hub = new ChainFirehoseHub(state, apiEnv(env));
    const page = async (cursor?: string) => {
      const url = new URL("https://api.example/api/v1/blocks?limit=2");
      if (cursor) url.searchParams.set("cursor",cursor);
      return (await jsonBody(await handleBlocks(new Request(url),env,url))).data;
    };
    await hub.alarm();
    assert.equal(storage.get("head:write_next"),SEAM+39);
    const first = await page();
    assert.deepEqual(first.blocks.map((b: {block_number: number}) => b.block_number),[SEAM+1001,SEAM+38]);
    const observed = app.prepare("SELECT block_number,observed_at FROM blocks_head WHERE block_number IN (?,?) ORDER BY block_number").all(SEAM+15,SEAM+1001);
    assert.ok(Number(observed[0]!.observed_at) > Number(observed[1]!.observed_at),"repair observation remains later than live observation");
    await hub.alarm();
    assert.equal(storage.get("head:write_next"),SEAM+64);
    assert.deepEqual((await page()).blocks.map((b: {block_number: number}) => b.block_number),[SEAM+1001,SEAM+63]);
    // A restart/revisit updates observations for already-written heights; a
    // cursor anchored at 38 must still continue below 38, without duplicates.
    storage.set("head:write_next",SEAM+37);
    await new ChainFirehoseHub(state,apiEnv(env)).alarm();
    const continuation = await page(first.next_cursor);
    assert.deepEqual(continuation.blocks.map((b: {block_number: number}) => b.block_number),[SEAM+37,SEAM+36]);
    const seen: (number|null)[] = []; let cursor: string|undefined;
    for (let count=0;count<40;count++) {
      const next = await page(cursor);
      seen.push(...next.blocks.map((b: {block_number: number|null}) => b.block_number));
      if (!next.next_cursor) break;
      assert.notEqual(next.next_cursor,cursor); cursor=next.next_cursor;
    }
    assert.deepEqual(seen,[SEAM+1001,...Array.from({length:49},(_,i)=>SEAM+63-i),SEAM,SEAM-1,SEAM-1,null]);
  } finally { now.mockRestore();globalThis.fetch=originalFetch;app.close();retained.close(); }
});

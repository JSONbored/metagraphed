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
function binding(sql: DatabaseSync, plans: string[][] = [], selectorRows: number[] = []) {
  const prepare = (text: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => prepare(text, next),
    all: async () => {
      if (text.startsWith("WITH candidates"))
        plans.push(
          sql
            .prepare(`EXPLAIN QUERY PLAN ${text}`)
            .all(...(values as never[]))
            .map((row) => String(row.detail)),
        );
      const results = sql.prepare(text).all(...(values as never[]));
      if (text.startsWith("SELECT COUNT(*) AS matches FROM (SELECT 1")) selectorRows.push(Number(results[0]!.matches));
      return {success:true,results,meta:{}};
    },
    run: async () => ({
      success: true,
      results: sql.prepare(text).all(...(values as never[])),
      meta: {},
    }),
  });
  return {
    prepare,
    batch: async (statements: ReturnType<typeof prepare>[]) =>
      Promise.all(statements.map((s) => s.all())),
  } as unknown as Pick<D1Database, "prepare" | "batch">;
}

test("actual block handler keeps live heights first while honest later observations repair old heights", async () => {
  const app = new DatabaseSync(":memory:"),
    retained = new DatabaseSync(":memory:");
  const originalFetch = globalThis.fetch;
  const start = Date.now();
  let clock = start;
  const now = vi.spyOn(Date, "now").mockImplementation(() => ++clock);
  try {
    const migrations = new URL("../migrations/d1/", import.meta.url);
    for (const file of readdirSync(migrations)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      app.exec(readFileSync(new URL(file, migrations), "utf8"));
    retained.exec(
      readFileSync(
        new URL(
          "../migrations/retained-blocks/0001_retained_blocks.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    retained
      .prepare("INSERT INTO history_block_sources VALUES(1,'one',0,'{}',4,4,1)")
      .run();
    for (const [ordinal, height] of [SEAM, SEAM - 1, SEAM - 1, null].entries())
      retained
        .prepare(
          "INSERT INTO history_blocks VALUES(0,1,?,?,?,NULL,NULL,1,1,1,?)",
        )
        .run(
          ordinal,
          height,
          `0xcold${ordinal}`,
          ordinal === 3 ? null : start - 1000,
        );
    retained
      .prepare("INSERT INTO history_block_state VALUES(0,?,?,?,1,?,4,1,NULL)")
      .run("a".repeat(64), "019fc234-642e-7f82-b656-ddb8529315ab", "99", start);
    const plans: string[][] = [];
    const env = mockEnv({
      D1_STATE: binding(app),
      D1_STATE_TABLES: "blocks_head,chain_detail_blocks,lane_health",
      D1_RETAINED_BLOCKS: binding(retained, plans),
      RETAINED_BLOCKS_NETWORKS: "mainnet",
      ICEBERG_BLOCKS_MAX: String(SEAM),
      CHAIN_HEAD_POLL_ENABLED: "true",
      CHAIN_HEAD_RPC_URL: "https://rpc.example",
    });
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body)) as {
        method: string;
        params: number[];
      };
      const result =
        rpc.method === "chain_getHeader"
          ? { number: `0x${(SEAM + 1001).toString(16)}` }
          : rpc.method === "chain_getBlockHash"
            ? `0x${rpc.params[0]}`
            : {
                block: { header: { parentHash: "0xp" }, extrinsics: ["0x00"] },
              };
      return Response.json({ result });
    }) as typeof fetch;
    const storage = new Map<string, unknown>([
      ["head:last_seen", SEAM + 1000],
      ["head:write_next", SEAM + 15],
    ]);
    const state = {
      getWebSockets: () => [],
      acceptWebSocket: () => {},
      waitUntil: (p: Promise<unknown>) => void p.catch(() => {}),
      storage: {
        get: async (key: string) => storage.get(key),
        put: async (key: string, value: unknown) =>
          void storage.set(key, value),
        getAlarm: async () => null,
        setAlarm: async () => {},
      },
    };
    const hub = new ChainFirehoseHub(state, apiEnv(env));
    const page = async (cursor?: string) => {
      const url = new URL("https://api.example/api/v1/blocks?limit=2");
      if (cursor) url.searchParams.set("cursor", cursor);
      return (await jsonBody(await handleBlocks(new Request(url), env, url)))
        .data;
    };
    await hub.alarm();
    assert.equal(storage.get("head:write_next"), SEAM + 39);
    const first = await page();
    assert.deepEqual(
      first.blocks.map((b: { block_number: number }) => b.block_number),
      [SEAM + 1001, SEAM + 38],
    );
    const oldPage = await page(
      `${Number.MAX_SAFE_INTEGER}.${Number.MAX_SAFE_INTEGER}`,
    );
    assert.deepEqual(
      oldPage.blocks.map((b: { block_number: number }) => b.block_number),
      [SEAM + 38, SEAM + 37],
    );
    assert.match(oldPage.next_cursor, /^\d+\.\d+$/);
    const oldHeightPage = await page(String(SEAM + 38));
    assert.deepEqual(
      oldHeightPage.blocks.map((b: { block_number: number }) => b.block_number),
      [SEAM + 37, SEAM + 36],
    );
    assert.match(oldHeightPage.next_cursor, /^\d+$/);
    const observed = app
      .prepare(
        "SELECT block_number,observed_at FROM blocks_head WHERE block_number IN (?,?) ORDER BY block_number",
      )
      .all(SEAM + 15, SEAM + 1001);
    assert.ok(
      Number(observed[0]!.observed_at) > Number(observed[1]!.observed_at),
      "repair observation remains later than live observation",
    );
    await hub.alarm();
    assert.equal(storage.get("head:write_next"), SEAM + 64);
    assert.deepEqual(
      (await page()).blocks.map(
        (b: { block_number: number }) => b.block_number,
      ),
      [SEAM + 1001, SEAM + 63],
    );
    // A restart/revisit updates observations for already-written heights; a
    // cursor anchored at 38 must still continue below 38, without duplicates.
    storage.set("head:write_next", SEAM + 37);
    await new ChainFirehoseHub(state, apiEnv(env)).alarm();
    const continuation = await page(first.next_cursor);
    assert.deepEqual(
      continuation.blocks.map((b: { block_number: number }) => b.block_number),
      [SEAM + 37, SEAM + 36],
    );
    const seen: (number | null)[] = [];
    let cursor: string | undefined;
    for (let count = 0; count < 40; count++) {
      const next = await page(cursor);
      seen.push(
        ...next.blocks.map(
          (b: { block_number: number | null }) => b.block_number,
        ),
      );
      if (!next.next_cursor) break;
      assert.notEqual(next.next_cursor, cursor);
      cursor = next.next_cursor;
    }
    assert.deepEqual(seen, [
      SEAM + 1001,
      ...Array.from({ length: 49 }, (_, i) => SEAM + 63 - i),
      SEAM,
      SEAM - 1,
      SEAM - 1,
      null,
    ]);
    assert.ok(plans.length > 1);
    for (const plan of plans) {
      assert.ok(
        plan.some((detail) =>
          /history_blocks_height.*block_number[<=>]/.test(detail),
        ),
        plan.join("\n"),
      );
      assert.ok(
        plan.filter((detail) => /USE TEMP B-TREE FOR ORDER BY/.test(detail))
          .length <= 1,
        "only the bounded candidate merge may sort: " + plan.join("\n"),
      );
    }
  } finally {
    now.mockRestore();
    globalThis.fetch = originalFetch;
    app.close();
    retained.close();
  }
});

test("rare old-height count, author and spec filters retain bounded selective plans", async () => {
  const { fetchBlockRowsFromR2Sql } = await import("../src/r2-sql-blocks.ts");
  const sql = new DatabaseSync(":memory:");
  const author = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
  const common = "5HjhkCMa89QJbFULs8WPZBgVg8kMq5qdX1nx7CnQpZgoyKAN";
  const now = Date.now();
  try {
    sql.exec(readFileSync(new URL("../migrations/retained-blocks/0001_retained_blocks.sql", import.meta.url),"utf8"));
    const higher = 50_002;
    sql.prepare("INSERT INTO history_block_sources VALUES(1,'selector',0,'{}',?,?,1)").run(higher+1,higher+1);
    sql.prepare("INSERT INTO history_block_authors VALUES(1,?),(2,?)").run(author,common);
    const insert = sql.prepare("INSERT INTO history_blocks VALUES(0,1,?,?,NULL,NULL,?,?,?,?,?)");
    sql.exec("BEGIN");
    insert.run(0,1,1,99,99,999,now);
    for(let ordinal=1;ordinal<=higher;ordinal++) insert.run(ordinal,100_000+ordinal,2,1,1,1,now+ordinal);
    sql.exec("COMMIT");
    sql.prepare("INSERT INTO history_block_state VALUES(0,?,?,?,1,?,?,1,NULL)").run("b".repeat(64),"019fc234-642e-7f82-b656-ddb8529315ab","100",now,higher+1);
    for(const kind of ["events","extrinsics"]) {
      sql.prepare("INSERT INTO history_block_counts VALUES(0,?,1,?),(0,?,99,1)").run(kind,higher,kind);
    }
    const plans: string[][] = [];
    const selectorRows: number[] = [];
    const env = {D1_RETAINED_BLOCKS:binding(sql,plans,selectorRows),RETAINED_BLOCKS_NETWORKS:"mainnet"};
    for(const [filters,index] of [
      [{minEvents:99},"events"],
      [{minExtrinsics:99},"extrinsics"],
      [{author},"author"],
      [{specVersion:999},"spec"],
      [{author,specVersion:999},"author_spec"],
      [{author,minEvents:99},"events"],
    ] as const) {
      const result = await fetchBlockRowsFromR2Sql(env,{limit:1,offset:0,...filters});
      assert.deepEqual(result!.rows.map(row=>row.block_number),[1]);
      const plan=plans.at(-1)!;
      assert.ok(plan.some(detail => detail.includes(`history_blocks_${index}`)),`${JSON.stringify(filters)} must use bounded ${index} matches below ${higher} unrelated newer rows: ${plan.join("\n")}`);
    }
    const broad=await fetchBlockRowsFromR2Sql(env,{limit:1,offset:0,author:common});
    assert.equal(broad!.rows[0]!.block_number,100_000+higher);
    const missing=await fetchBlockRowsFromR2Sql(env,{limit:1,offset:0,specVersion:123456});
    assert.deepEqual(missing!.rows,[]);
    assert.ok(selectorRows.includes(1));
    assert.ok(selectorRows.includes(50_001),"common selectors stop counting at the bounded-sort threshold plus one");
    assert.ok(selectorRows.includes(0));
    assert.ok(selectorRows.every(rows=>rows<=50_001));
  } finally {sql.close();}
});

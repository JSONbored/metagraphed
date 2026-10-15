import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, beforeEach, test, vi } from "vitest";
import { Miniflare } from "miniflare";
import { handleD1StateExport } from "../src/d1-state-export.ts";
import { D1_EXPORT_TABLES } from "../src/d1-export-tables.ts";
import { nativeProjectionD1 } from "../src/native-projection-d1.ts";
import { loadNativeProjectionManifest } from "../src/native-projection-store.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { handleRequest } from "../workers/api.ts";
import dataWorker from "../workers/data-api.ts";
import { dataApiEnv } from "./helpers/worker-env.ts";
import {
  mcpAccountContext,
  withMcpAccount,
} from "./helpers/mcp-account-fixture.ts";

type BlockFrame = {
  block_number: number;
  block_hash: string;
  parent_hash: string;
  author: null;
  extrinsic_count: number | null;
  event_count: number | null;
  spec_version: number;
  observed_at: string;
};
const corpus = JSON.parse(
  readFileSync(
    new URL("./fixtures/restored-serving-v1.json", import.meta.url),
    "utf8",
  ),
) as {
  now: number;
  identity: { data: { account: string; name: string; additional: string } };
  blocks: Record<"mainnet" | "testnet", BlockFrame[]>;
  first_cursor: string;
  snapshot: string;
};

// Native Miniflare D1 on BOTH sides; no mocked reader/query results. Control
// rows come from this synthetic offline fixture, never a widened public export.
const runtime = new Miniflare({
  modules: true,
  script: "export default {fetch(){return new Response('fixture')}}",
  compatibilityDate: "2026-06-06",
  d1Databases: ["SOURCE", "RESTORED", "SOURCE_BLOCKS", "RESTORED_BLOCKS"],
});
let source: D1Database, restored: D1Database;
let sourceBlocks: D1Database, restoredBlocks: D1Database;
let clock = corpus.now;
const ctx = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;
const tables = Object.keys(D1_EXPORT_TABLES).join(",");
type Cell = { storage: string; value: string | null };
type Snapshot = {
  columns: { name: string }[];
  rows: Cell[][];
  revision: number;
  row_count: number;
  next_cursor: string[] | null;
  projection_sha256: string;
};
const exportEnv = (db: D1Database) => ({
  D1_STATE: db,
  D1_STATE_TABLES: tables,
  D1_EXPORT_REVISIONS: "enabled",
  STATE_EXPORT_SECRET: "fixture",
});
async function exported(db: D1Database, input: Record<string, unknown>) {
  const response = await handleD1StateExport(
    new Request("https://fixture.invalid/export", {
      method: "POST",
      headers: { "x-state-export-token": "fixture" },
      body: JSON.stringify({ ...input, encoding: "lossless-v1" }),
    }),
    exportEnv(db),
  );
  assert.equal(response.status, 200, await response.clone().text());
  return response.json<Snapshot>();
}
async function restoreProjection(table: string) {
  const schema = await exported(source, { table, kind: "schema" });
  const columns = schema.columns.map((c) => c.name);
  const page = await exported(source, {
    table,
    kind: "rows",
    columns,
    revision: schema.revision,
  });
  assert.equal(page.next_cursor, null);
  assert.equal(page.rows.length, schema.row_count);
  const final = await exported(source, { table, kind: "schema" });
  assert.equal(final.revision, schema.revision);
  assert.equal(final.projection_sha256, schema.projection_sha256);
  for (const row of page.rows) {
    const values = row.map((cell) =>
      cell.storage === "integer"
        ? "CAST(? AS INTEGER)"
        : cell.storage === "real"
          ? "CAST(? AS REAL)"
          : "?",
    );
    await restored
      .prepare(
        `INSERT INTO ${table} (${columns.join(",")}) VALUES (${values.join(",")})`,
      )
      .bind(...row.map((cell) => cell.value))
      .run();
  }
  const actual = await exported(restored, { table, kind: "rows", columns });
  assert.deepEqual(actual.rows, page.rows);
}
// Fixed synthetic tables only; not an operational exporter or backup tool.
async function copyControl(from: D1Database, to: D1Database, names: string[]) {
  for (const table of names) {
    const rows = (
      await from
        .prepare(`SELECT * FROM ${table}`)
        .all<Record<string, string | number | null>>()
    ).results;
    for (const row of rows) {
      const columns = Object.keys(row);
      await to
        .prepare(
          `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        )
        .bind(...Object.values(row))
        .run();
    }
  }
}
async function put(db: D1Database, key: string, payload: unknown) {
  await db
    .prepare(
      "INSERT OR REPLACE INTO generated_artifacts(key,payload,updated_at) VALUES(?,?,?)",
    )
    .bind(key, JSON.stringify(payload), new Date(corpus.now).toISOString())
    .run();
}
const serving = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL("./fixtures/native-projections/serving.json.gz", import.meta.url),
    ),
  ).toString(),
) as Record<string, { raw: string }>;
async function seedObject(key: string, raw: Buffer) {
  const compressed = gzipSync(raw);
  const hash = (algorithm: string) =>
    createHash(algorithm).update(raw).digest("hex");
  const descriptor = {
    format: "gzip-json-v1",
    bytes: raw.length,
    compressedBytes: compressed.length,
    parts: Math.ceil(compressed.length / 65536),
    etag: hash("md5"),
    sha256: hash("sha256"),
  };
  for (let i = 0; i < descriptor.parts; i++)
    await put(source, `${key}/chunks/${i}`, {
      data: compressed.subarray(i * 65536, (i + 1) * 65536).toString("base64"),
    });
  await put(source, key, descriptor);
}
function env() {
  return withMcpAccount({
    ...exportEnv(restored),
    NATIVE_PROJECTIONS: "enabled",
    METAGRAPH_VALIDATE_RESPONSES: "true",
    D1_RETAINED_BLOCKS: restoredBlocks,
    RETAINED_BLOCKS_NETWORKS: "mainnet,testnet",
    ICEBERG_BLOCKS_MAX: "11",
    METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "data-api",
    DATA_API: {
      fetch: (request: Request) =>
        dataWorker.fetch(request, dataApiEnv(exportEnv(restored)), ctx),
    },
    METAGRAPH_CONTROL: { get: async () => null },
    METAGRAPH_ARCHIVE: {
      get: async () => {
        throw Error(
          "Restored selected objects must not fall back to a retired owner",
        );
      },
    },
  });
}
const rest = (path: string) =>
  handleRequest(new Request(`https://api.metagraph.sh${path}`), env(), ctx);
async function tool(name: string, args: Record<string, unknown> = {}) {
  const response = await handleRequest(
    new Request("https://api.metagraph.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    env(),
    { ...ctx, ...mcpAccountContext } as ExecutionContext,
  );
  const body = await response.json<{
    result: { structuredContent: Record<string, unknown>; isError: boolean };
  }>();
  assert.ok(body.result, JSON.stringify(body));
  return body.result;
}
function frame(rows: Record<string, unknown>[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.keys(corpus.blocks.mainnet[0]!).map((key) => [key, row[key]]),
    ),
  );
}
beforeAll(async () => {
  [source, restored, sourceBlocks, restoredBlocks] = await Promise.all(
    ["SOURCE", "RESTORED", "SOURCE_BLOCKS", "RESTORED_BLOCKS"].map((name) =>
      runtime.getD1Database(name),
    ),
  );
  const root = new URL("../migrations/d1/", import.meta.url);
  for (const db of [source, restored])
    for (const file of readdirSync(root)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      for (const sql of readFileSync(new URL(file, root), "utf8").split(
        "-- statement-breakpoint",
      ))
        if (sql.trim()) await db.prepare(sql).run();
  for (const db of [sourceBlocks, restoredBlocks])
    for (const sql of readFileSync(
      new URL(
        "../migrations/retained-blocks/0001_retained_blocks.sql",
        import.meta.url,
      ),
      "utf8",
    ).split("-- statement-breakpoint"))
      if (sql.trim()) await db.prepare(sql).run();
  const identity = corpus.identity.data;
  await source
    .prepare(
      "INSERT INTO account_identity(account,name,additional,captured_at) VALUES(?,?,?,?)",
    )
    .bind(identity.account, identity.name, identity.additional, corpus.now)
    .run();
  const lossless = JSON.parse(
    readFileSync(
      new URL("./fixtures/lossless-state-export-v1.json", import.meta.url),
      "utf8",
    ),
  ) as { rows: Cell[][] };
  for (const row of lossless.rows)
    await source
      .prepare(
        "INSERT INTO nominator_positions VALUES(?,?,CAST(? AS INTEGER),CAST(? AS REAL),CAST(? AS INTEGER),?,?)",
      )
      .bind(...row.map((c) => c.value))
      .run();
  await restoreProjection("account_identity");
  await restoreProjection("nominator_positions");
  for (const [network, name] of ["mainnet", "testnet"].entries()) {
    const rows = corpus.blocks[name as "mainnet" | "testnet"];
    await sourceBlocks
      .prepare("INSERT INTO history_block_sources VALUES(?,?,?,?,?,?,?)")
      .bind(
        network + 1,
        `source-${name}`,
        network,
        "{}",
        rows.length,
        rows.length,
        1,
      )
      .run();
    for (const [ordinal, row] of [...rows].reverse().entries())
      await sourceBlocks
        .prepare("INSERT INTO history_blocks VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .bind(
          network,
          network + 1,
          ordinal,
          row.block_number,
          row.block_hash,
          row.parent_hash,
          null,
          row.extrinsic_count,
          row.event_count,
          row.spec_version,
          Date.parse(row.observed_at),
        )
        .run();
    await sourceBlocks
      .prepare("INSERT INTO history_block_state VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(
        network,
        "a".repeat(64),
        "019fc234-642e-7f82-b656-ddb8529315ab",
        corpus.snapshot,
        1,
        corpus.now,
        rows.length,
        1,
        null,
      )
      .run();
    const key = `metagraph/native-projections/v1/${name}/current.json`;
    const manifest = JSON.parse(serving[key]!.raw) as {
      artifacts: { object: { key: string } }[];
    };
    for (const artifact of manifest.artifacts)
      await seedObject(
        artifact.object.key,
        Buffer.from(serving[artifact.object.key]!.raw),
      );
    await put(source, key, manifest);
  }
  await copyControl(sourceBlocks, restoredBlocks, [
    "history_block_sources",
    "history_blocks",
    "history_block_state",
  ]);
  await copyControl(source, restored, ["generated_artifacts"]);
}, 60_000);
beforeEach(() => {
  resetModuleState();
  clock = corpus.now;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
});
afterEach(() => {
  vi.restoreAllMocks();
  resetModuleState();
});
afterAll(() => runtime.dispose());

test("lossless source generations restore exact cells, and REST/MCP serve the restored identity", async () => {
  const response = await rest(
    `/api/v1/accounts/${corpus.identity.data.account}/identity`,
  );
  assert.equal(response.status, 200);
  const body = await response.json<{ data: unknown }>();
  assert.deepEqual(body.data, corpus.identity.data);
  const mcp = await tool("get_account_identity", {
    ss58: corpus.identity.data.account,
  });
  assert.equal(mcp.isError, false);
  assert.deepEqual(mcp.structuredContent, body.data);
  assert.equal(
    await restoredBlocks
      .prepare("SELECT snapshot FROM history_block_state WHERE network=0")
      .first("snapshot"),
    corpus.snapshot,
  );
});

test("restored retained storage preserves tie ordering, keyset pages, nullable counts and network isolation", async () => {
  for (const [network, prefix] of [
    ["mainnet", ""],
    ["testnet", "/testnet"],
  ] as const) {
    const response = await rest(`/api/v1${prefix}/blocks?limit=2`);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json<{
      data: { blocks: Record<string, unknown>[]; next_cursor: string | null };
    }>();
    assert.deepEqual(
      frame(body.data.blocks),
      corpus.blocks[network].slice(0, 2),
    );
    if (network === "mainnet") {
      assert.equal(body.data.next_cursor, corpus.first_cursor);
      const next = await rest(
        `/api/v1/blocks?limit=2&cursor=${body.data.next_cursor}`,
      );
      const page = await next.json<{
        data: { blocks: Record<string, unknown>[] };
      }>();
      assert.deepEqual(frame(page.data.blocks), corpus.blocks.mainnet.slice(2));
      const mcp = await tool("list_blocks", { limit: 2 });
      assert.equal(mcp.isError, false);
      assert.deepEqual(
        frame(mcp.structuredContent.blocks as Record<string, unknown>[]),
        frame(body.data.blocks),
      );
      const tail = await tool("list_blocks", {
        limit: 2,
        cursor: body.data.next_cursor,
      });
      assert.deepEqual(
        frame(tail.structuredContent.blocks as Record<string, unknown>[]),
        frame(page.data.blocks),
      );
    }
  }
});

test("verified empty stays successful; a restored receipt census mismatch fails REST/MCP and can recover after reset", async () => {
  const empty = await rest("/api/v1/blocks?block_start=999&limit=2");
  assert.equal(empty.status, 200);
  assert.equal(empty.headers.get("x-metagraph-degraded"), null);
  assert.deepEqual(
    (await empty.json<{ data: { blocks: unknown[] } }>()).data.blocks,
    [],
  );
  const mcpEmpty = await tool("list_blocks", { block_start: 999, limit: 2 });
  assert.equal(mcpEmpty.isError, false);
  assert.deepEqual(mcpEmpty.structuredContent.blocks, []);
  await restoredBlocks
    .prepare("UPDATE history_block_state SET source_rows=999 WHERE network=0")
    .run();
  try {
    resetModuleState();
    assert.equal((await rest("/api/v1/blocks?limit=2")).status, 503);
    assert.equal((await tool("list_blocks", { limit: 2 })).isError, true);
    assert.equal((await rest("/api/v1/testnet/blocks?limit=2")).status, 200);
  } finally {
    await restoredBlocks
      .prepare("UPDATE history_block_state SET source_rows=3 WHERE network=0")
      .run();
    resetModuleState();
  }
  assert.equal((await rest("/api/v1/blocks?limit=2")).status, 200);
});

test("restored native object corruption refuses a measured zero and repaired bytes recover on both protocols", async () => {
  const manifest = await loadNativeProjectionManifest(env(), "mainnet");
  assert.ok(manifest);
  const selected = manifest.artifacts.find((a) =>
    a.artifactKey.endsWith("/blocks-summary.json"),
  )!;
  const expected = JSON.parse(serving[selected.object.key]!.raw).summary;
  const first = await rest("/api/v1/blocks/summary");
  assert.deepEqual((await first.json<{ data: unknown }>()).data, expected);
  assert.deepEqual(
    (await tool("get_blocks_summary")).structuredContent,
    expected,
  );
  const original = await restored
    .prepare("SELECT payload FROM generated_artifacts WHERE key=?")
    .bind(`${selected.object.key}/chunks/0`)
    .first<string>("payload");
  await put(restored, `${selected.object.key}/chunks/0`, { data: "eA==" });
  try {
    // Previously verified immutable bytes may live for the documented 30s.
    // Expire that real cache, rather than bypassing it with a module reset.
    const cached = (await (await nativeProjectionD1(restored).get(
      selected.object.key,
    ))!.json()) as { summary: unknown };
    assert.deepEqual(cached.summary, expected);
    clock += 30_001;
    await assert.rejects(nativeProjectionD1(restored).get(selected.object.key));
    const response = await rest("/api/v1/blocks/summary");
    assert.equal(
      response.headers.get("x-metagraph-degraded"),
      "tier_unavailable",
    );
    const mcp = await tool("get_blocks_summary");
    assert.deepEqual(mcp.structuredContent.degraded, {
      reason: "tier_unavailable",
    });
    const other = await rest("/api/v1/testnet/blocks/summary");
    assert.equal(other.headers.get("x-metagraph-degraded"), null);
  } finally {
    await restored
      .prepare("UPDATE generated_artifacts SET payload=? WHERE key=?")
      .bind(original!, `${selected.object.key}/chunks/0`)
      .run();
  }
  const recovered = await rest("/api/v1/blocks/summary");
  assert.equal(recovered.headers.get("x-metagraph-degraded"), null);
  assert.deepEqual((await recovered.json<{ data: unknown }>()).data, expected);
  assert.deepEqual(
    (await tool("get_blocks_summary")).structuredContent,
    expected,
  );
});

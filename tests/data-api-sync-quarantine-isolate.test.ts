// Exercise the real queue export in workerd with isolated KV. This proves the
// compiled handler's custody/ack contract, not production KV consistency.
import { build } from "esbuild";
import { Miniflare, Response as MiniflareResponse } from "miniflare";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, expect, test } from "vitest";
import { repoRoot } from "../scripts/lib.ts";
import { SYNC_QUARANTINE_PREFIX } from "../src/sync-dead-letter-store.ts";

let outdir: string;
let runtime: Miniflare;
const outbound: string[] = [];
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  outdir = await mkdtemp(path.join(tmpdir(), "data-api-quarantine-isolate-"));
  await build({
    absWorkingDir: repoRoot,
    entryPoints: ["workers/data-api.ts"],
    outdir,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    conditions: ["workerd", "worker", "browser"],
    loader: { ".wasm": "copy" },
    external: ["cloudflare:*"],
    // Match buildApiWorker: CommonJS dependencies must import workerd's
    // native Node builtins rather than leaving an ESM-incompatible require.
    plugins: [
      {
        name: "native-node-requires",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            if (!isBuiltin(args.path)) return;
            if (args.kind === "require-call") {
              return {
                path: args.path.replace(/^node:/, ""),
                namespace: "native-node-require",
              };
            }
            return {
              path: args.path.startsWith("node:")
                ? args.path
                : `node:${args.path}`,
              external: true,
            };
          });
          builder.onLoad(
            { filter: /.*/, namespace: "native-node-require" },
            (args) => ({
              contents: `import native from 'node:${args.path}'; module.exports = native;`,
              loader: "js",
            }),
          );
        },
      },
    ],
    define: {
      "process.env.NODE_ENV": '"production"',
      "global.process.env.NODE_ENV": '"production"',
      "globalThis.process.env.NODE_ENV": '"production"',
    },
  });
  const names = (await readdir(outdir, { recursive: true }))
    .filter((name) => name.endsWith(".js") || name.endsWith(".wasm"))
    .sort((a, b) =>
      a === "data-api.js" ? -1 : b === "data-api.js" ? 1 : a.localeCompare(b),
    );
  runtime = new Miniflare({
    modules: names.map((name) => ({
      type: name.endsWith(".wasm") ? "CompiledWasm" : "ESModule",
      path: path.join(outdir, name),
    })),
    modulesRoot: outdir,
    compatibilityDate: "2026-06-06",
    compatibilityFlags: ["nodejs_compat"],
    host: "127.0.0.1",
    port: 0,
    cf: false,
    kvNamespaces: ["METAGRAPH_CONTROL"],
    outboundService(request) {
      outbound.push(request.url);
      return new MiniflareResponse(null, { status: 502 });
    },
  });
}, 60_000);

afterAll(async () => {
  await runtime?.dispose();
  if (outdir) await rm(outdir, { recursive: true, force: true });
});

test("the isolated Data API queue preserves JSON and binary custody with explicit acknowledgments", async () => {
  const queue = "sync-batches-dlq";
  const timestamp = new Date(1_780_000_000_123);
  const json = {
    lane: "hotkey-alpha",
    captured_at: 1_780_000_000_000,
    key_complete: true,
    rows: [],
  };
  const compressed = Uint8Array.from(gzipSync(JSON.stringify(json)));
  const messages = [
    { id: "quarantine-json-ci", body: json, timestamp, attempts: 7 },
    {
      id: "quarantine-bytes-ci",
      body: compressed.buffer,
      timestamp,
      attempts: 7,
    },
  ];
  const target = await runtime.getWorker();
  const result = await target.queue(queue, messages);
  expect(result).toMatchObject({
    outcome: "ok",
    ackAll: false,
    retryBatch: { retry: false },
    retryMessages: [],
  });
  expect(result.explicitAcks).toEqual(messages.map(({ id }) => id));

  const kv = await runtime.getKVNamespace("METAGRAPH_CONTROL");
  const listed = await kv.list({ prefix: SYNC_QUARANTINE_PREFIX });
  expect(listed.list_complete).toBe(true);
  const records = await Promise.all(
    listed.keys.map(async ({ name }) => {
      const text = await kv.get(name);
      expect(text).not.toBeNull();
      const value = JSON.parse(text!);
      const digest = sha256(text!);
      expect(name).toBe(
        value.kind === "observation"
          ? SYNC_QUARANTINE_PREFIX +
              value.custody_sha256 +
              ":" +
              String(value.attempts).padStart(16, "0") +
              ":" +
              digest
          : SYNC_QUARANTINE_PREFIX + digest,
      );
      return { sha256: digest, value };
    }),
  );
  const custody = records.filter(({ value }) => value.kind === "custody");
  const observations = records.filter(
    ({ value }) => value.kind === "observation",
  );
  expect(custody).toHaveLength(2);
  expect(observations).toHaveLength(2);
  expect(records).toHaveLength(4);
  for (const message of messages) {
    const record = custody.find(({ value }) => value.message_id === message.id);
    expect(record).toBeDefined();
    const expected =
      message.id === "quarantine-json-ci"
        ? Buffer.from(JSON.stringify(json))
        : Buffer.from(compressed);
    expect(record!.value).toEqual({
      version: 2,
      kind: "custody",
      queue,
      message_id: message.id,
      published_at: timestamp.getTime(),
      representation: message.id === "quarantine-json-ci" ? "json" : "bytes",
      body_bytes: expected.length,
      body_sha256: sha256(expected),
      payload: expected.toString("base64"),
    });
    expect(observations.map(({ value }) => value)).toContainEqual({
      version: 2,
      kind: "observation",
      custody_sha256: record!.sha256,
      attempts: 7,
    });
  }
  expect(outbound).toEqual([]);
});

test("a native per-message retry preserves its valid suffix and later attempts reuse custody", async () => {
  const queue = "sync-batches-dlq";
  const kv = await runtime.getKVNamespace("METAGRAPH_CONTROL");
  const before = await kv.list({ prefix: SYNC_QUARANTINE_PREFIX });
  expect(before.list_complete).toBe(true);
  const previous = new Set(before.keys.map(({ name }) => name));
  const timestamp = new Date(1_780_000_000_456);
  const invalid = {
    id: "quarantine-oversize-ci",
    body: new ArrayBuffer(128 * 1024 + 1),
    timestamp,
    attempts: 7,
  };
  const valid = {
    id: "quarantine-suffix-ci",
    body: { lane: "native-isolate-suffix", label: "valid-after-oversize" },
    timestamp,
    attempts: 7,
  };
  const target = await runtime.getWorker();
  const result = await target.queue(queue, [invalid, valid]);
  expect(result).toMatchObject({
    outcome: "ok",
    ackAll: false,
    retryBatch: { retry: false },
    explicitAcks: [valid.id],
  });
  // The pinned native API names the retried message in msgId. Its optional
  // delay is left to the queue default; this test does not alter retry timing.
  expect(result.retryMessages).toEqual([
    expect.objectContaining({ msgId: invalid.id }),
  ]);

  const listed = await kv.list({ prefix: SYNC_QUARANTINE_PREFIX });
  expect(listed.list_complete).toBe(true);
  const added = listed.keys.filter(({ name }) => !previous.has(name));
  expect(added).toHaveLength(2);
  const records = await Promise.all(
    added.map(async ({ name }) => {
      const text = await kv.get(name);
      expect(text).not.toBeNull();
      return { name, text: text!, value: JSON.parse(text!) };
    }),
  );
  const expected = Buffer.from(JSON.stringify(valid.body));
  const custody = records.find(({ value }) => value.kind === "custody");
  const observation = records.find(({ value }) => value.kind === "observation");
  expect(custody).toBeDefined();
  expect(observation).toBeDefined();
  expect(custody!.value).toEqual({
    version: 2,
    kind: "custody",
    queue,
    message_id: valid.id,
    published_at: timestamp.getTime(),
    representation: "json",
    body_bytes: expected.length,
    body_sha256: sha256(expected),
    payload: expected.toString("base64"),
  });
  const custodySha256 = sha256(custody!.text);
  expect(custody!.name).toBe(SYNC_QUARANTINE_PREFIX + custodySha256);
  expect(observation!.value).toEqual({
    version: 2,
    kind: "observation",
    custody_sha256: custodySha256,
    attempts: 7,
  });
  expect(observation!.name).toBe(
    SYNC_QUARANTINE_PREFIX +
      custodySha256 +
      ":0000000000000007:" +
      sha256(observation!.text),
  );
  expect(records.some(({ value }) => value.message_id === invalid.id)).toBe(
    false,
  );

  // This checks visible-record reuse in the native runtime. Delayed or stale
  // production KV visibility remains a separate qualification.
  const redelivery = await target.queue(queue, [{ ...valid, attempts: 8 }]);
  expect(redelivery).toEqual({
    outcome: "ok",
    ackAll: false,
    retryBatch: { retry: false },
    explicitAcks: [valid.id],
    retryMessages: [],
  });
  const after = await kv.list({ prefix: SYNC_QUARANTINE_PREFIX });
  expect(after.list_complete).toBe(true);
  expect(after.keys.map(({ name }) => name).sort()).toEqual(
    listed.keys.map(({ name }) => name).sort(),
  );
  for (const record of records) {
    expect(await kv.get(record.name)).toBe(record.text);
  }
  expect(outbound).toEqual([]);
});

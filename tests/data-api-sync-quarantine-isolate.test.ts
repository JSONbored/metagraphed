// Register the exact raw Data API deployment bundle emitted by Wrangler in
// workerd. No forwarding entry, export filtering or second bundler is used.
// Bindings remain isolated; this does not qualify production KV consistency.
import { Miniflare, Response as MiniflareResponse } from "miniflare";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, expect, test } from "vitest";
import { repoRoot, stripJsonComments } from "../scripts/lib.ts";
import { SYNC_QUARANTINE_PREFIX } from "../src/sync-dead-letter-store.ts";

let outdir: string;
let runtime: Miniflare;
let deploymentProof: {
  main_module: string;
  config_sha256: string;
  source_sha256: string;
  compatibility_date: string;
  compatibility_flags: string[];
  modules: { name: string; bytes: number; sha256: string }[];
};
const outbound: string[] = [];
const execFile = promisify(execFileCallback);
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  outdir = await mkdtemp(path.join(tmpdir(), "data-api-quarantine-isolate-"));
  const configText = await readFile(
    path.join(repoRoot, "wrangler.data.jsonc"),
    "utf8",
  );
  const config = JSON.parse(stripJsonComments(configText));
  expect(config.main).toBe("workers/data-api.ts");
  const modulesRoot = path.join(outdir, "modules");
  const outfile = path.join(outdir, "upload.multipart");
  const envFile = path.join(outdir, "empty.env");
  await writeFile(envFile, "");
  // Wrangler's legacy home directory takes precedence over XDG_CONFIG_HOME.
  // Refuse it by metadata only; never inspect an existing auth/config file.
  expect(existsSync(path.join(homedir(), ".wrangler"))).toBe(false);
  // Reproduce the deployment script's build-only phase with the installed
  // pinned CLI. A clean env excludes account credentials and telemetry;
  // production NODE_ENV avoids Vitest changing Wrangler's bundle defines.
  const childEnv: Record<string, string | undefined> = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CI: "true",
    NODE_ENV: "production",
    XDG_CONFIG_HOME: path.join(outdir, "config"),
    XDG_CACHE_HOME: path.join(outdir, "cache"),
    CLOUDFLARE_AUTH_USE_KEYRING: "false",
    WRANGLER_SEND_METRICS: "false",
  };
  try {
    await execFile(
      process.execPath,
      [
        path.join(repoRoot, "node_modules/wrangler/bin/wrangler.js"),
        "deploy",
        "--config",
        "wrangler.data.jsonc",
        "--dry-run",
        "--outdir",
        modulesRoot,
        "--outfile",
        outfile,
        "--upload-source-maps",
        "--env-file",
        envFile,
      ],
      {
        cwd: repoRoot,
        // Generated Worker types add required application fields to ProcessEnv;
        // those bindings do not belong in this isolated host CLI environment.
        env: childEnv as NodeJS.ProcessEnv,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
    );
  } catch {
    // execFile's rejection carries the entire captured binding dump. Keep
    // failure diagnostics bounded and exclude its stdout/stderr and cause.
    throw new Error("Data API deployment dry run failed");
  }
  // Wrangler's --outfile is the exact upload multipart body. Its metadata
  // selects the entry by form-part name; do not guess from filenames or
  // replay its production binding metadata into the isolated runtime.
  const upload = await readFile(outfile);
  const boundaryEnd = upload.indexOf("\r\n");
  expect(boundaryEnd).toBeGreaterThan(2);
  expect(boundaryEnd).toBeLessThan(200);
  const firstLine = upload.subarray(0, boundaryEnd).toString();
  expect(firstLine).toMatch(/^--[-A-Za-z0-9]+$/);
  const form = await new Response(new Uint8Array(upload).buffer, {
    headers: {
      "Content-Type": `multipart/form-data; boundary=${firstLine.slice(2)}`,
    },
  }).formData();
  const metadataText = form.get("metadata");
  if (typeof metadataText !== "string") throw new Error("missing metadata");
  const metadata = JSON.parse(metadataText);
  expect(metadata.main_module).toBe("data-api.js");
  expect(metadata.compatibility_date).toBe(config.compatibility_date);
  expect(metadata.compatibility_flags).toEqual(config.compatibility_flags);
  const moduleTypes = {
    "application/javascript+module": "ESModule",
    "application/javascript": "CommonJS",
    "application/wasm": "CompiledWasm",
    "application/octet-stream": "Data",
    "text/plain": "Text",
  } as const;
  const modules = [];
  const proof = [];
  const names = new Set<string>();
  for (const [name, value] of form) {
    if (name === "metadata") continue;
    if (typeof value === "string") throw new Error("unexpected upload field");
    if (value.type === "application/source-map") continue;
    if (!Object.hasOwn(moduleTypes, value.type)) {
      throw new Error("unsupported deployment module");
    }
    expect(names.has(name)).toBe(false);
    names.add(name);
    const modulePath = path.resolve(modulesRoot, name);
    expect(modulePath.startsWith(`${modulesRoot}${path.sep}`)).toBe(true);
    const bytes = await readFile(modulePath);
    expect(new Uint8Array(await value.arrayBuffer())).toEqual(
      new Uint8Array(bytes),
    );
    modules.push({
      type: moduleTypes[value.type as keyof typeof moduleTypes],
      path: modulePath,
    });
    proof.push({ name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  expect(names.has(metadata.main_module)).toBe(true);
  modules.sort((a, b) =>
    path.relative(modulesRoot, a.path) === metadata.main_module
      ? -1
      : path.relative(modulesRoot, b.path) === metadata.main_module
        ? 1
        : a.path.localeCompare(b.path),
  );
  deploymentProof = {
    main_module: metadata.main_module,
    config_sha256: sha256(configText),
    source_sha256: sha256(await readFile(path.join(repoRoot, config.main))),
    compatibility_date: metadata.compatibility_date,
    compatibility_flags: metadata.compatibility_flags,
    modules: proof.sort((a, b) => a.name.localeCompare(b.name)),
  };
  runtime = new Miniflare({
    modules,
    modulesRoot,
    compatibilityDate: metadata.compatibility_date,
    compatibilityFlags: metadata.compatibility_flags,
    host: "127.0.0.1",
    port: 0,
    cf: false,
    bindings: { CHAIN_DETAIL_SYNC_SECRET: "native-chain-detail-fixture" },
    kvNamespaces: ["METAGRAPH_CONTROL"],
    outboundService(request) {
      outbound.push(request.url);
      return new MiniflareResponse(null, { status: 502 });
    },
  });
  await runtime.ready;
}, 90_000);

afterAll(async () => {
  await runtime?.dispose();
  if (outdir) await rm(outdir, { recursive: true, force: true });
});

test("the raw Wrangler Data API deployment graph registers without an entrypoint wrapper", async () => {
  expect(deploymentProof.main_module).toBe("data-api.js");
  expect(deploymentProof.modules.length).toBeGreaterThan(0);
  expect(outbound).toEqual([]);
  console.info("data-api-deployment-graph", JSON.stringify(deploymentProof));
});

test("native HTTP admission preserves decoded UTF-8 rather than raw wire size", async () => {
  const encoder = new TextEncoder();
  const limit = 16_000_000;
  const block = {
    block_number: 1,
    block_hash: `0x${"ab".repeat(32)}`,
    spec_version: 479,
    observed_at: 1_780_000_000_000,
    extrinsics: [],
    chain_events: [],
    account_events: [],
  };
  const json = JSON.stringify({ blocks: [block] });
  const headers = {
    "x-chain-detail-sync-token": "native-chain-detail-fixture",
  };
  const bom = encoder.encode(`\ufeff${json.padEnd(limit, " ")}`);
  expect(bom.byteLength).toBe(limit + 3);
  const accepted = await runtime.dispatchFetch(
    "https://example.test/api/v1/internal/chain-detail-sync",
    { method: "POST", headers, body: bom },
  );
  // A valid admitted body reaches the existing store-availability decision.
  // No production store is bound and no write is attempted in this fixture.
  expect(accepted.status).toBe(503);
  expect(await accepted.json()).toEqual({
    error: "no store bound for this route",
  });

  const prefix = encoder.encode(`${json.slice(0, -1)},"padding":"`);
  const suffix = encoder.encode('"}');
  for (const extra of [0, 1]) {
    const fill = limit - prefix.byteLength - suffix.byteLength - 3 + extra;
    const bytes = new Uint8Array(
      prefix.byteLength + 1 + fill + suffix.byteLength,
    );
    bytes.set(prefix);
    bytes[prefix.byteLength] = 0xff;
    bytes.fill(120, prefix.byteLength + 1, prefix.byteLength + 1 + fill);
    bytes.set(suffix, bytes.length - suffix.byteLength);
    expect(bytes.byteLength).toBe(limit - 2 + extra);
    const result = await runtime.dispatchFetch(
      "https://example.test/api/v1/internal/chain-detail-sync",
      { method: "POST", headers, body: bytes },
    );
    expect(result.status).toBe(extra === 0 ? 503 : 413);
  }
  expect(outbound).toEqual([]);
}, 60_000);

test("native Fetch keeps the same BOM admission decisions as the deployed bundle", async () => {
  const oracle = new Miniflare({
    modules: true,
    script: 'export default {async fetch(request) {return Response.json({text:await request.text()});}}',
    compatibilityDate: deploymentProof.compatibility_date,
    compatibilityFlags: deploymentProof.compatibility_flags,
    host: "127.0.0.1",
    port: 0,
    cf: false,
    outboundService(request) {
      outbound.push(request.url);
      return new MiniflareResponse(null, { status: 502 });
    },
  });
  const json = JSON.stringify({ blocks: [{
    block_number: 1, block_hash: `0x${"ab".repeat(32)}`, spec_version: 479,
    observed_at: 1_780_000_000_000, extrinsics: [], chain_events: [], account_events: [],
  }] });
  try {
    for (let count = 0; count <= 4; count += 1) {
      const wire = new TextEncoder().encode("\ufeff".repeat(count) + json);
      const control = await oracle.dispatchFetch("https://oracle.test", { method: "POST", body: wire });
      const native = await control.json() as { text: string };
      expect(native.text).toBe("\ufeff".repeat(Math.max(0, count - 1)) + json);
      const response = await runtime.dispatchFetch("https://example.test/api/v1/internal/chain-detail-sync", {
        method: "POST", headers: { "x-chain-detail-sync-token": "native-chain-detail-fixture" }, body: wire,
      });
      expect(response.status).toBe(count <= 1 ? 503 : 400);
    }
  } finally {
    await oracle.dispose();
  }
  expect(outbound).toEqual([]);
}, 60_000);

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

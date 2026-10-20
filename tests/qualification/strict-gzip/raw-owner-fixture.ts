import {
  optionalPgBuildAssociation,
  ownerBuildInputIdentity,
  boundedBuildFile,
} from "./owner-build-evidence.ts";
import { assertOwnerExternalImport } from "./owner-resource-policy.ts";
// Synthetic inputs and host-side verification for the unwrapped API owner.
// Nothing here runs captureTick, changes production source, or forwards D1.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import type { Metafile } from "esbuild";
import { withinOwnerDeadline } from "./owner-deadline.ts";

type RawCleanupStep =
  "barrier" | "completion" | "observer" | "runtime" | "files";
/** Always attempt later cleanup steps, even after a rejection or deadline.
 * A timed-out promise is still pending; this does not assert cancellation. */
export async function cleanupRawOwner(
  actions: Partial<Record<RawCleanupStep, () => unknown | Promise<unknown>>>,
  milliseconds = 10_000,
): Promise<RawCleanupStep[]> {
  const failures: RawCleanupStep[] = [];
  for (const step of [
    "barrier",
    "completion",
    "observer",
    "runtime",
    "files",
  ] as const) {
    const action = actions[step];
    if (!action) continue;
    try {
      await withinOwnerDeadline(Promise.resolve().then(action), milliseconds);
    } catch {
      failures.push(step);
    }
  }
  return failures;
}

export const RAW_OWNER_NAME = "qualification-raw-owner";
export const RAW_SOURCE_BASE = "6b8422966b1411dff6d7c486f4e9a549acecc761";
export const RAW_SCENARIO = "paired-scheduled-25" as const;
export const RAW_NETWORKS = ["mainnet", "testnet"] as const;
export type RawNetwork = (typeof RAW_NETWORKS)[number];
export const RAW_RECORDS_PER_LANE = 25;
export const RAW_RPC_URLS = {
  mainnet: "https://mainnet.raw-owner.fixture.invalid/rpc",
  testnet: "https://testnet.raw-owner.fixture.invalid/rpc",
} as const;
export const RAW_SOURCE_BLOBS = {
  "package-lock.json": "5b0282bb9e45bab1fd38e28725d7f87ea6bb6ad8",
  "scripts/build-api-worker.ts": "48face14c44fae096bb9be84034716ae7084479b",
  "workers/api.entry.ts": "5cd1f4e15dd23a5c2beca221af5c9f202245898a",
  "workers/api.ts": "b4a70ae5bc6394e1884b4aaec6981308807cf401",
  "workers/config.ts": "4203bab6282d3ef395d07c70e9a4a2f2197cc628",
  "src/raw-capture-sync.ts": "2b7919e346e991d130ec91d3c1c76f3fae8f26c5",
  "src/raw-chain-capture.ts": "ba70a0a49d560f013b5468cf022038f00dd58948",
  "src/raw-capture-d1.ts": "a2117ac28687f6e83b1c0c9f63d3c7996702cde1",
  "src/raw-capture-floors.ts": "66b6f8fabf6a0831871a3fa14dc2064c7af44eb7",
  "src/raw-capture-endpoints.ts": "6c2b0cb09f645f85b8d2ef97f7c8c41c4eaf941d",
  "src/chain-rpc.ts": "7e05bff8c13e5fe79156a38db65ef609e72185da",
  "src/capture-state-neon-write.ts": "168700487545de798ae14f97eb2a02118033fdba",
  "src/d1-store.ts": "2c85f2c1fff28284ed2541e5f3a46b72c62bf45f",
  "src/twox-storage-key.ts": "757c769d939ad5c730a08654cd5a3c19c28fd9be",
  "wrangler.jsonc": "6624787c6bb26130e7a6d1d18e685e0b0f1d8ccf",
  "migrations/d1/0027_generated_artifacts.sql":
    "0b289cfef1052888ba015d984d56499095107c30",
  "migrations/d1/0028_raw_capture_storage.sql":
    "6b6c4a686fb815b2ecde99a27badde2eb55bfdd8",
  "migrations/d1/0029_raw_capture_archive.sql":
    "5dd815605f9583db485c3bad100360ff0561f8a5",
  "db/d1-schema.sql": "9fae63987175af74fedea5184e2b927006629d01",
} as const;
const SCHEMAS = [
  "migrations/d1/0027_generated_artifacts.sql",
  "migrations/d1/0028_raw_capture_storage.sql",
  "migrations/d1/0029_raw_capture_archive.sql",
] as const;
const OWNER_INPUTS = [
  "workers/api.entry.ts",
  "workers/api.ts",
  "src/raw-capture-sync.ts",
  "src/raw-chain-capture.ts",
  "src/raw-capture-d1.ts",
] as const;
const DO_EXPORTS = [
  "AlerterHub",
  "ChainFirehoseHub",
  "McpSessionHub",
  "NeonWriteBufferHub",
  "SubnetStatusHub",
  "default",
];
export const rawDigest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export async function verifyRawSources(root: string) {
  const sources = [];
  for (const [name, gitBlob] of Object.entries(RAW_SOURCE_BLOBS)) {
    const bytes = await readFile(path.join(root, name));
    assert.equal(
      createHash("sha1")
        .update(`blob ${bytes.byteLength}\0`)
        .update(bytes)
        .digest("hex"),
      gitBlob,
      `Unreviewed raw owner source: ${name}`,
    );
    sources.push({ name, gitBlob, sha256: rawDigest(bytes) });
  }
  return sources;
}

/** Call the source-owned builder without overriding a single build option. */
export async function buildRawOwner(root: string, output: string) {
  assert.equal(process.env.METAGRAPH_REPO_ROOT, undefined);
  const sources = await verifyRawSources(root);
  const { buildApiWorker } = (await import(
    pathToFileURL(path.join(root, "scripts/build-api-worker.ts")).href
  )) as {
    buildApiWorker(
      outdir: string,
    ): Promise<{ errors: unknown[]; metafile?: Metafile }>;
  };
  const esbuild = await import("esbuild");
  let result: Awaited<ReturnType<typeof buildApiWorker>>;
  try {
    result = await buildApiWorker(output);
  } finally {
    // Close the reviewed service before the test worker exits, so its launch
    // guard can observe termination rather than inheriting an unexplained child.
    await esbuild.stop();
  }
  assert.deepEqual(result.errors, []);
  assert.ok(result.metafile);
  const meta = result.metafile;
  const outputRoot = await realpath(output);
  const files: string[] = [];
  async function walk(directory: string, depth = 0): Promise<void> {
    assert.ok(depth <= 8);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.ok((await realpath(file)).startsWith(`${outputRoot}${path.sep}`));
      if (entry.isDirectory()) await walk(file, depth + 1);
      else {
        assert.ok(entry.isFile(), "No output symlinks or special files");
        files.push(file);
      }
      assert.ok(files.length <= 1024);
    }
  }
  await walk(outputRoot);
  files.sort();
  const outputs = new Map(
    Object.entries(meta.outputs).map(([name, value]) => [
      path.resolve(root, name),
      value,
    ]),
  );
  assert.deepEqual([...outputs.keys()].sort(), files);
  const modules: { type: "ESModule" | "CompiledWasm"; path: string }[] = [];
  const sourceMaps: { name: string; bytes: Uint8Array }[] = [];
  const records = [];
  let totalBytes = 0;
  for (const file of files) {
    const bytes = await readFile(file);
    totalBytes += bytes.length;
    assert.ok(bytes.length <= 128 * 1024 ** 2 && totalBytes <= 256 * 1024 ** 2);
    assert.equal(outputs.get(file)!.bytes, bytes.length);
    const extension = path.extname(file);
    assert.ok([".js", ".wasm", ".map"].includes(extension));
    const type = extension === ".js" ? "ESModule" : "CompiledWasm";
    if (extension !== ".map") modules.push({ type, path: file });
    else sourceMaps.push({ name: path.relative(outputRoot, file), bytes });
    if (extension === ".wasm")
      assert.deepEqual(
        [...bytes.subarray(0, 8)],
        [0, 97, 115, 109, 1, 0, 0, 0],
      );
    records.push({
      name: path.relative(outputRoot, file),
      type: extension === ".map" ? "SourceMap" : type,
      bytes: bytes.length,
      sha256: rawDigest(bytes),
    });
  }
  const optionalPg = optionalPgBuildAssociation(
    root,
    outputRoot,
    meta,
    Object.keys(meta.outputs)
      .filter((key) => key.endsWith(".js"))
      .map((key) => ({
        metafilePath: key,
        bytes: boundedBuildFile(path.resolve(root, key), 32 * 1024 * 1024),
        sourceMap: {
          metafilePath: key + ".map",
          bytes: boundedBuildFile(
            path.resolve(root, key + ".map"),
            64 * 1024 * 1024,
          ),
        },
      })),
    modules.map((module) => path.relative(outputRoot, module.path)),
  );
  const entry = path.join(outputRoot, "api.entry.js");
  assert.ok(outputs.has(entry));
  assert.deepEqual([...outputs.get(entry)!.exports].sort(), DO_EXPORTS);
  const edges: { from: number; to: number; dynamic: boolean }[] = [];
  for (const [metafilePath, value] of Object.entries(meta.outputs)) {
    const file = path.resolve(root, metafilePath);
    for (const [importIndex, dependency] of value.imports.entries()) {
      if (dependency.external) {
        if (
          optionalPg &&
          optionalPg.admitted.output === metafilePath &&
          optionalPg.admitted.importIndex === importIndex
        )
          continue;
        assertOwnerExternalImport(dependency.path);
        continue;
      }
      const candidates = [
        ...new Set([
          path.resolve(root, dependency.path),
          path.resolve(path.dirname(file), dependency.path),
        ]),
      ].filter((candidate) => outputs.has(candidate));
      assert.equal(candidates.length, 1);
      edges.push({
        from: files.indexOf(file),
        to: files.indexOf(candidates[0]!),
        dynamic: dependency.kind === "dynamic-import",
      });
    }
  }
  const entryIndex = files.indexOf(entry);
  const closure = (dynamic: boolean) => {
    const seen = new Set([entryIndex]);
    for (let previous = -1; previous !== seen.size;) {
      previous = seen.size;
      for (const edge of edges)
        if (seen.has(edge.from) && (dynamic || !edge.dynamic))
          seen.add(edge.to);
    }
    return [...seen].sort((a, b) => a - b);
  };
  const executable = records.flatMap((record, index) =>
    record.type === "SourceMap" ? [] : [index],
  );
  assert.deepEqual(closure(true), executable);
  const eager = closure(false);
  const contributions = OWNER_INPUTS.map((source) => {
    const inputs = Object.keys(meta.inputs).filter(
      (name) => path.resolve(root, name) === path.join(root, source),
    );
    assert.equal(inputs.length, 1, `Missing raw owner contribution: ${source}`);
    const matching = [...outputs].flatMap(([file, value]) =>
      Object.entries(value.inputs).flatMap(([name, input]) =>
        inputs.includes(name) && input.bytesInOutput > 0
          ? [{ outputIndex: files.indexOf(file), bytes: input.bytesInOutput }]
          : [],
      ),
    );
    assert.ok(matching.length > 0);
    if (source === "workers/api.ts")
      assert.ok(matching.every((item) => !eager.includes(item.outputIndex)));
    return { source, outputs: matching };
  });
  modules.sort((a, b) =>
    a.path === entry ? -1 : b.path === entry ? 1 : a.path.localeCompare(b.path),
  );
  // Read-only identity verification again catches an intervening source change.
  assert.deepEqual(await verifyRawSources(root), sources);
  const canonicalRoot = await realpath(root);
  const dependencyRoot = await realpath(path.join(root, "node_modules"));
  const sourcePaths: string[] = [];
  for (const name of Object.keys(meta.inputs)) {
    // The production builder alone generates these native-builtin adapters.
    if (name.startsWith("native-node-require:")) continue;
    const relative = ownerBuildInputIdentity(
      canonicalRoot,
      dependencyRoot,
      name,
    );
    assert.ok(!sourcePaths.includes(relative), "Duplicate raw input identity");
    sourcePaths.push(relative);
  }
  const associations = await Promise.all(
    Object.keys(meta.outputs).map(async (metafilePath) => {
      const file = path.resolve(root, metafilePath);
      const name = path.relative(outputRoot, file);
      const type = file.endsWith(".js")
        ? ("ESModule" as const)
        : file.endsWith(".wasm")
          ? ("CompiledWasm" as const)
          : ("SourceMap" as const);
      const sourceMapName = type === "ESModule" ? `${name}.map` : null;
      if (sourceMapName)
        assert.ok(
          sourceMaps.some((sourceMap) => sourceMap.name === sourceMapName),
        );
      return {
        metafilePath,
        name,
        type,
        sourceMapName,
        sha256: rawDigest(await readFile(file)),
      };
    }),
  );
  const association = Buffer.from(
    JSON.stringify({
      kind: "esbuild-api",
      metafile: meta,
      sourceRoot: canonicalRoot,
      dependencyRoot,
      outputRoot,
      sourceMaps: sourceMaps.map(({ name, bytes }) => ({
        name,
        base64: Buffer.from(bytes).toString("base64"),
      })),
      outputs: associations,
    }),
  );
  assert.ok(association.byteLength <= 64 * 1024 ** 2);
  return {
    modules,
    sourcePaths: [
      ...new Set([
        ...sourcePaths,
        ...Object.keys(RAW_SOURCE_BLOBS),
        "scripts/lib.ts",
      ]),
    ],
    association,
    proof: {
      sourceBase: RAW_SOURCE_BASE,
      sources,
      identityKind: "actual-buildApiWorker-output",
      exactWranglerUpload: false,
      entryUnmodified: true,
      instrumentation: "none",
      entryIndex,
      modules: records,
      edges,
      contributions,
      eagerModuleIndexes: eager,
      reachableModuleIndexes: closure(true),
      totalBytes,
      metafileSha256: rawDigest(JSON.stringify(meta)),
    },
  };
}

export interface RawLane {
  network: RawNetwork;
  first: number;
  last: number;
  key: string;
}
export function rawLane(network: RawNetwork, first: number): RawLane {
  assert.ok(Number.isSafeInteger(first) && first > 0);
  const last = first + RAW_RECORDS_PER_LANE - 1;
  const scope = network === "mainnet" ? "" : "testnet/";
  return {
    network,
    first,
    last,
    key: `chain/raw/${scope}blocks/${String(first).padStart(12, "0")}-${String(last).padStart(12, "0")}.ndjson`,
  };
}
function hashAt(network: RawNetwork, height: number) {
  return `0x${rawDigest(`raw-owner:${network}:${height}`)}`;
}
export function rawRecord(lane: RawLane, height: number, capturedAt: number) {
  return {
    block_number: height,
    block_hash: hashAt(lane.network, height),
    parent_hash: hashAt(lane.network, height - 1),
    header: {
      parentHash: hashAt(lane.network, height - 1),
      number: `0x${height.toString(16)}`,
    },
    extrinsics: [
      `0x${Buffer.from(`${lane.network}:${height}`).toString("hex")}`,
    ],
    events: `0x${Buffer.from(`events:${lane.network}:${height}`).toString("hex")}`,
    captured_at: capturedAt,
  };
}

/** Only two distinct live batch operations can open this single-use gate. */
export function rawPairBarrier(
  onOverlap: () => Promise<void> = async () => {},
  timeoutMs = 5000,
) {
  assert.ok(timeoutMs > 0 && timeoutMs <= 5000);
  const arrived = new Map<
    RawNetwork,
    {
      network: RawNetwork;
      requestSha256: string;
      responseSha256: string;
      atMs: number;
    }
  >();
  let openedAtMs: number | null = null;
  let failed = false;
  let released = false;
  let pending = 0;
  let settled = 0;
  let maximumPending = 0;
  let pendingAtRelease: number | null = null;
  let settledBeforeRelease: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveGate!: () => void;
  let rejectGate!: (error: Error) => void;
  const gate = new Promise<void>((resolve, reject) => {
    resolveGate = resolve;
    rejectGate = reject;
  });
  // A fixture failure may precede its first await; it must not become unhandled.
  void gate.catch(() => undefined);
  const fail = () => {
    failed = true;
    clearTimeout(timer);
    rejectGate(new Error("raw_owner_overlap_refused"));
  };
  return {
    async arrive(
      network: RawNetwork,
      requestSha256: string,
      responseSha256: string,
    ) {
      if (
        released ||
        failed ||
        !RAW_NETWORKS.includes(network) ||
        arrived.has(network) ||
        !/^[a-f0-9]{64}$/.test(requestSha256) ||
        !/^[a-f0-9]{64}$/.test(responseSha256) ||
        [...arrived.values()].some(
          (item) =>
            item.requestSha256 === requestSha256 ||
            item.responseSha256 === responseSha256,
        )
      ) {
        fail();
        throw new Error("raw_owner_overlap_identity");
      }
      if (arrived.size === 0) timer = setTimeout(fail, timeoutMs);
      arrived.set(network, {
        network,
        requestSha256,
        responseSha256,
        atMs: performance.now(),
      });
      pending++;
      maximumPending = Math.max(maximumPending, pending);
      try {
        if (arrived.size === 2) {
          // Keep both response operations pending while the host observer samples.
          void onOverlap().then(() => {
            if (failed) return;
            assert.equal(pending, 2);
            openedAtMs = performance.now();
            pendingAtRelease = pending;
            settledBeforeRelease = settled;
            released = true;
            clearTimeout(timer);
            resolveGate();
          }, fail);
        }
        await gate;
      } finally {
        pending--;
        settled++;
      }
    },
    close() {
      if (!released) fail();
      clearTimeout(timer);
    },
    receipt() {
      return {
        kind: "host-rpc-batch-response" as const,
        arrivals: [...arrived.values()].sort((a, b) =>
          a.network.localeCompare(b.network),
        ),
        openedAtMs,
        maximumPending,
        pendingAtRelease,
        settledBeforeRelease,
        pending,
        failed,
        released,
        writerOverlapEstablished: false,
      };
    },
  };
}

type RpcCall = {
  jsonrpc: string;
  id: number;
  method: string;
  params: unknown[];
};
export function rawRpcPayload(
  lane: RawLane,
  input: unknown,
  eventsKey: string,
) {
  const calls = Array.isArray(input) ? input : [input];
  assert.ok(calls.length === 1 || calls.length === 50);
  const heights = Array.from({ length: 25 }, (_, i) => lane.first + i);
  const ids = new Set<number>();
  const methods: string[] = [];
  const answer = (unknownCall: unknown) => {
    assert.ok(unknownCall && typeof unknownCall === "object");
    const call = unknownCall as RpcCall;
    assert.deepEqual(Object.keys(call).sort(), [
      "id",
      "jsonrpc",
      "method",
      "params",
    ]);
    assert.equal(call.jsonrpc, "2.0");
    assert.ok(Number.isSafeInteger(call.id) && call.id >= 0);
    assert.ok(!ids.has(call.id));
    ids.add(call.id);
    methods.push(call.method);
    let result: unknown;
    if (call.method === "chain_getHeader") {
      assert.equal(calls.length, 1);
      assert.deepEqual(call.params, []);
      result = { number: `0x${lane.last.toString(16)}` };
    } else if (call.method === "chain_getBlockHash") {
      assert.equal(calls.length, 1);
      assert.deepEqual(call.params, [heights]);
      result = heights.map((height) => hashAt(lane.network, height));
    } else {
      assert.equal(calls.length, 50);
      const blockHash =
        call.method === "chain_getBlock" ? call.params?.[0] : call.params?.[1];
      const height = heights.find(
        (height) => hashAt(lane.network, height) === blockHash,
      );
      assert.ok(height !== undefined);
      const row = rawRecord(lane, height, 1);
      if (call.method === "chain_getBlock") {
        assert.deepEqual(call.params, [row.block_hash]);
        result = { block: { header: row.header, extrinsics: row.extrinsics } };
      } else {
        assert.equal(call.method, "state_getStorage");
        assert.deepEqual(call.params, [eventsKey, row.block_hash]);
        result = row.events;
      }
    }
    return { jsonrpc: "2.0", id: call.id, result };
  };
  const answers = calls.map(answer);
  if (calls.length === 50)
    assert.deepEqual(methods, [
      ...Array<string>(25).fill("chain_getBlock"),
      ...Array<string>(25).fill("state_getStorage"),
    ]);
  const bytes = Buffer.from(
    JSON.stringify(Array.isArray(input) ? answers : answers[0]),
  );
  assert.ok(bytes.length <= 64 * 1024);
  return {
    bytes,
    calls: calls.length,
    method: calls.length === 50 ? "batch" : methods[0]!,
  };
}

export async function boundedRawRequest(
  body: ReadableStream<Uint8Array> | null,
) {
  assert.ok(body);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let finished = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        finished = true;
        break;
      }
      length += next.value.byteLength;
      assert.ok(length <= 16 * 1024, "Raw RPC request exceeded fixture bound");
      chunks.push(next.value);
    }
    return Buffer.concat(chunks, length);
  } finally {
    if (!finished) await reader.cancel();
    reader.releaseLock();
  }
}

/** Reconstruct the native schema from exact migration inputs, including triggers. */
export async function seedRawDatabase(
  root: string,
  db: D1Database,
  lanes: RawLane[],
) {
  const reference = new DatabaseSync(":memory:");
  try {
    for (const name of SCHEMAS)
      reference.exec(await readFile(path.join(root, name), "utf8"));
    const schema = await readFile(path.join(root, "db/d1-schema.sql"), "utf8");
    const state = /CREATE TABLE raw_capture_state \([\s\S]*?\n\);/.exec(schema);
    assert.ok(state);
    reference.exec(state[0]);
    const ddl = reference
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
      )
      .all() as { type: string; name: string; sql: string }[];
    for (const object of ddl) await db.prepare(object.sql).run();
    await db.prepare("INSERT INTO raw_capture_budget(id) VALUES(1)").run();
    const sort = (rows: typeof ddl) =>
      rows
        .map(({ type, name, sql }) => ({ type, name, sql }))
        .sort((a, b) => (a.type + a.name).localeCompare(b.type + b.name));
    const native = await db
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
      )
      .all<(typeof ddl)[number]>();
    assert.deepEqual(sort(native.results), sort(ddl));
    assert.equal(
      await db.prepare("PRAGMA foreign_keys").first("foreign_keys"),
      1,
    );
    for (const lane of lanes)
      await db
        .prepare(
          "INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at) VALUES(?,?,?)",
        )
        .bind(lane.network, lane.first - 1, 1)
        .run();
    return {
      canonicalSchemaSha256: rawDigest(JSON.stringify(sort(ddl))),
      nativeSchemaEquality: true,
      nativeForeignKeys: true,
      stateDdlSha256: rawDigest(state[0]),
    };
  } finally {
    reference.close();
  }
}

export async function verifyRawDatabase(
  db: D1Database,
  lanes: RawLane[],
  startedAt: number,
  endedAt: number,
) {
  const batches = (
    await db
      .prepare("SELECT * FROM raw_capture_batches ORDER BY network")
      .all<Record<string, string | number>>()
  ).results;
  assert.equal(batches.length, 2, "Both raw lanes must commit independently");
  const selected = (
    await db
      .prepare(
        "SELECT key,sha256,network,last_block,captured_at FROM raw_capture_selected ORDER BY network",
      )
      .all()
  ).results;
  const outcomes = [];
  for (const lane of lanes) {
    const batch = batches.find((row) => row.network === lane.network);
    assert.ok(batch);
    assert.equal(batch.key, lane.key);
    assert.equal(batch.first_block, lane.first);
    assert.equal(batch.last_block, lane.last);
    assert.equal(batch.complete, 1);
    assert.ok(
      typeof batch.parts === "number" && batch.parts >= 1 && batch.parts <= 2,
    );
    const parts = (
      await db
        .prepare(
          "SELECT part,hex(data) AS data FROM raw_capture_chunks WHERE key=? AND sha256=? ORDER BY part",
        )
        .bind(lane.key, batch.sha256)
        .all<{ part: number; data: string }>()
    ).results;
    assert.equal(parts.length, batch.parts);
    const compressed = Buffer.concat(
      parts.map((part, index) => {
        assert.equal(part.part, index);
        assert.match(part.data, /^[A-F0-9]+$/);
        assert.ok(part.data.length <= 2 * 65536);
        return Buffer.from(part.data, "hex");
      }),
    );
    assert.equal(compressed.length, batch.compressed_bytes);
    assert.equal(rawDigest(compressed), batch.compressed_sha256);
    // Reconstruction is outside the owner and after the measured event drain.
    const raw = gunzipSync(compressed, { maxOutputLength: 64 * 1024 });
    assert.equal(raw.length, batch.raw_bytes);
    assert.equal(rawDigest(raw), batch.sha256);
    assert.equal(raw.at(-1), 10);
    const rows = raw
      .toString("utf8")
      .slice(0, -1)
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, RAW_RECORDS_PER_LANE);
    for (const [index, row] of rows.entries()) {
      assert.ok(Number.isSafeInteger(row.captured_at));
      assert.ok(row.captured_at >= startedAt && row.captured_at <= endedAt);
      assert.deepEqual(
        row,
        rawRecord(lane, lane.first + index, row.captured_at),
      );
    }
    assert.equal(
      batch.captured_at,
      Math.max(...rows.map((row) => row.captured_at)),
    );
    const expected =
      rows
        .map((row, index) =>
          JSON.stringify(rawRecord(lane, lane.first + index, row.captured_at)),
        )
        .join("\n") + "\n";
    assert.equal(raw.toString("utf8"), expected);
    assert.equal(rawDigest(expected), batch.sha256);
    const watermark = await db
      .prepare(
        "SELECT last_contiguous_block FROM raw_capture_state WHERE network=?",
      )
      .bind(lane.network)
      .first<number>("last_contiguous_block");
    assert.equal(watermark, lane.last);
    outcomes.push({
      network: lane.network,
      first: lane.first,
      last: lane.last,
      records: rows.length,
      watermark,
      rawBytes: raw.length,
      rawSha256: rawDigest(raw),
      compressedBytes: compressed.length,
      compressedSha256: rawDigest(compressed),
      parts: parts.length,
      keySha256: rawDigest(lane.key),
      contentVerified: true,
    });
  }
  assert.deepEqual(
    selected,
    batches.map((batch) => ({
      key: batch.key,
      sha256: batch.sha256,
      network: batch.network,
      last_block: batch.last_block,
      captured_at: batch.captured_at,
    })),
  );
  assert.deepEqual(
    await db
      .prepare("SELECT bytes,objects FROM raw_capture_budget WHERE id=1")
      .first(),
    {
      bytes: outcomes.reduce((sum, lane) => sum + lane.compressedBytes, 0),
      objects: 2,
    },
  );
  assert.equal(
    await db.prepare("SELECT count(*) n FROM raw_capture_archives").first("n"),
    0,
  );
  assert.equal(
    await db.prepare("SELECT count(*) n FROM generated_artifacts").first("n"),
    0,
  );
  assert.equal(
    await db.prepare("SELECT count(*) n FROM raw_capture_state").first("n"),
    2,
  );
  return outcomes;
}

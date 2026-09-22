import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { test, vi } from "vitest";
import {
  restoreChainDetailPayloads,
  storeChainDetailPayloads,
} from "../src/chain-detail-payloads.ts";

const prefix = "\0metagraphed:r2:";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const objects = new Map<
    string,
    { bytes: Uint8Array; customMetadata?: Record<string, string> }
  >();
  let reads = 0;
  const describe = (key: string) => {
    const object = objects.get(key);
    return object
      ? { size: object.bytes.length, customMetadata: object.customMetadata }
      : null;
  };
  const archive = {
    async put(
      key: string,
      bytes: Uint8Array,
      opts: { customMetadata: Record<string, string> },
    ) {
      if (objects.has(key)) return null;
      objects.set(key, { bytes, customMetadata: opts.customMetadata });
      return describe(key);
    },
    async head(key: string) {
      return describe(key);
    },
    async get(key: string) {
      reads++;
      const object = objects.get(key);
      return object
        ? { ...describe(key), body: new Blob([object.bytes]).stream() }
        : null;
    },
  };
  function seed(
    bytes: Uint8Array,
    opts: {
      rawBytes?: number;
      storedBytes?: number;
      digest?: string;
      gzip?: boolean;
      version?: 1 | 2;
    } = {},
  ) {
    const digest = opts.digest ?? hash(bytes);
    const body = opts.gzip ? gzipSync(bytes) : bytes;
    const key = `metagraph/d1-chain-payloads/v1/${digest}.json${opts.gzip ? ".gz" : ""}`;
    objects.set(key, { bytes: body });
    const reference =
      opts.version === 1
        ? `${prefix}v1:${digest}:${opts.rawBytes ?? bytes.length}`
        : `${prefix}v2:${digest}:${opts.rawBytes ?? bytes.length}:${opts.storedBytes ?? body.length}:${opts.gzip ? "gzip" : "raw"}`;
    return reference;
  }
  return {
    env: { METAGRAPH_ARCHIVE: archive },
    archive,
    objects,
    seed,
    reads: () => reads,
  };
}

test("inline values pass unchanged; large UTF-8 payloads compress, deduplicate, and replay", async () => {
  const f = fixture();
  const value = "\uFEFF" + JSON.stringify({ text: "界".repeat(60_000) });
  const rows = [
    { call_args: value, args: null },
    { args: value },
    { call_args: "[]", other: 3 },
  ];
  const stored = await storeChainDetailPayloads(f.env, rows);
  assert.match(String(stored[0].call_args), /:gzip$/);
  assert.equal(f.objects.size, 1);
  assert.ok([...f.objects.values()][0].bytes.length < 1000);
  assert.deepEqual(await restoreChainDetailPayloads(f.env, stored), rows);
  assert.equal(f.reads(), 1);
  assert.deepEqual(await storeChainDetailPayloads(f.env, rows), stored);
  assert.deepEqual(
    await restoreChainDetailPayloads(undefined, [
      { call_args: 1 },
      { call_args: "[]" },
    ]),
    [{ call_args: 1 }, { call_args: "[]" }],
  );
});

test("a codec with no size benefit keeps raw bytes, and legacy raw references stay readable", async () => {
  const f = fixture();
  const value = "a".repeat(140_000);
  vi.stubGlobal(
    "CompressionStream",
    class extends TransformStream {
      constructor() {
        super({
          transform(chunk, controller) {
            controller.enqueue(chunk);
          },
        });
      }
    },
  );
  try {
    const stored = await storeChainDetailPayloads(f.env, [
      { call_args: value },
    ]);
    assert.match(String(stored[0].call_args), /:raw$/);
    assert.deepEqual(await restoreChainDetailPayloads(f.env, stored), [
      { call_args: value },
    ]);
  } finally {
    vi.unstubAllGlobals();
  }
  const reference = f.seed(new TextEncoder().encode("legacy"), { version: 1 });
  assert.deepEqual(
    await restoreChainDetailPayloads(f.env, [{ args: reference }]),
    [{ args: "legacy" }],
  );
});

test("missing archives, reserved references, and conflicting immutable objects reject writes", async () => {
  const value = "a".repeat(140_000);
  await assert.rejects(
    storeChainDetailPayloads(null, [{ args: value }]),
    /unbound/,
  );
  await assert.rejects(
    storeChainDetailPayloads({}, [{ args: prefix + "v1:bad" }]),
    /Reserved/,
  );
  for (const mode of ["missing", "size", "metadata", "digest"]) {
    const f = fixture();
    await storeChainDetailPayloads(f.env, [{ args: value }]);
    const object = [...f.objects.values()][0];
    if (mode === "missing") {
      f.archive.put = async () => null;
      f.archive.head = async () => null;
    } else if (mode === "size") object.bytes = new Uint8Array(1);
    else if (mode === "metadata") object.customMetadata = undefined;
    else object.customMetadata!.sha256 = "wrong";
    await assert.rejects(
      storeChainDetailPayloads(f.env, [{ args: value }]),
      /object conflict/,
    );
  }
});

test("malformed references, unsafe sizes, and byte budgets fail before unbounded reads", async () => {
  const f = fixture();
  const digest = "a".repeat(64);
  for (const suffix of ["bad", `v1:${digest}:0`, `v2:${digest}:1:1:zip`])
    await assert.rejects(
      restoreChainDetailPayloads(f.env, [{ args: prefix + suffix }]),
      /Invalid/,
    );
  for (const suffix of [
    `v1:${digest}:9007199254740992`,
    `v2:${digest}:1:9007199254740992:raw`,
    `v1:${digest}:16777217`,
    `v2:${digest}:1:16777217:raw`,
  ])
    await assert.rejects(
      restoreChainDetailPayloads(f.env, [{ args: prefix + suffix }]),
      /byte budget/,
    );
  assert.equal(f.reads(), 0);
  await assert.rejects(
    storeChainDetailPayloads(f.env, [{ args: "x".repeat(16777217) }]),
    /byte budget/,
  );
  const value = "x".repeat(9 * 1024 * 1024);
  await assert.rejects(
    storeChainDetailPayloads(
      f.env,
      Array.from({ length: 4 }, () => ({ args: value })),
    ),
    /byte budget/,
  );
  const stored = await storeChainDetailPayloads(f.env, [{ args: value }]);
  await assert.rejects(
    restoreChainDetailPayloads(
      f.env,
      Array.from({ length: 4 }, () => stored[0]),
    ),
    /byte budget/,
  );
});

test("hydration refuses absent, truncated, corrupt, non-UTF-8, and over-expanding payloads", async () => {
  const f = fixture();
  const bytes = new TextEncoder().encode("content");
  let reference = f.seed(bytes);
  await assert.rejects(
    restoreChainDetailPayloads(null, [{ args: reference }]),
    /unbound/,
  );
  f.objects.clear();
  await assert.rejects(
    restoreChainDetailPayloads(f.env, [{ args: reference }]),
    /Missing/,
  );
  reference = f.seed(bytes, { storedBytes: 1 });
  await assert.rejects(
    restoreChainDetailPayloads(f.env, [{ args: reference }]),
    /truncated/,
  );
  reference = f.seed(bytes, { digest: "0".repeat(64) });
  await assert.rejects(
    restoreChainDetailPayloads(f.env, [{ args: reference }]),
    /Corrupt/,
  );
  reference = f.seed(bytes, { rawBytes: bytes.length + 1 });
  await assert.rejects(
    restoreChainDetailPayloads(f.env, [{ args: reference }]),
    /Corrupt/,
  );
  reference = f.seed(bytes, { gzip: true, rawBytes: 1 });
  await assert.rejects(
    restoreChainDetailPayloads(f.env, [{ args: reference }]),
    /expands/,
  );
  reference = f.seed(new Uint8Array([255]));
  await assert.rejects(
    restoreChainDetailPayloads(f.env, [{ args: reference }]),
    /encoded data/,
  );
});

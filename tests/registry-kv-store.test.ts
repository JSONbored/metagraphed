import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import { afterEach, test, vi } from "vitest";
import { type RegistryArtifact } from "../schemas-src/registry-kv.ts";
import {
  registryManifestKey,
  registryObjectKey,
  REGISTRY_KV_PREFIX,
} from "../src/registry-kv.ts";
import {
  publishRegistryKv,
  collectRegistryKv,
  readRegistryManifest,
  registryDigest,
  cloudflareRegistryKvStore,
} from "../scripts/registry-kv-store.ts";

type RegistryKvStore = Parameters<typeof publishRegistryKv>[0];
type RegistryKvObject = Parameters<RegistryKvStore["write"]>[0][number];
type RegistryKvListing = Awaited<ReturnType<RegistryKvStore["list"]>>[number];

const NOW = Date.parse("2026-09-28T08:00:00Z");
const OLD = new Date(NOW - 3 * 86400_000).toISOString();
afterEach(() => vi.unstubAllGlobals());
const bytes = (value: unknown): Uint8Array =>
  Buffer.from(JSON.stringify(value));
function artifact(path: string, value: Uint8Array): RegistryArtifact {
  return { path, sha256: registryDigest(value), size_bytes: value.byteLength };
}
function fixture() {
  const values = new Map<string, Uint8Array>([
    ["metagraph:latest", bytes({ published_at: "before" })],
  ]);
  const metadata = new Map<string, RegistryKvListing["metadata"]>();
  function put(key: string, data: Uint8Array) {
    values.set(key, data);
    metadata.set(key, {
      size_bytes: data.byteLength,
      uploaded_at: OLD,
      utf8: isUtf8(data),
    });
  }
  const store: RegistryKvStore = {
    read: vi.fn(async (key: string) => values.get(key) ?? null),
    readText: vi.fn(async (keys: string[]) =>
      Object.fromEntries(
        keys.map((key) => [
          key,
          values.has(key)
            ? Buffer.from(values.get(key)!).toString("utf8")
            : null,
        ]),
      ),
    ),
    write: vi.fn(async (objects: RegistryKvObject[]) => {
      for (const item of objects) put(item.key, item.bytes);
    }),
    list: vi.fn(async () =>
      [...metadata]
        .filter(([name]) => name.startsWith(REGISTRY_KV_PREFIX))
        .map(([name, metadata]) => ({ name, metadata })),
    ),
    remove: vi.fn(async (keys: string[]) => {
      for (const key of keys) {
        values.delete(key);
        metadata.delete(key);
      }
    }),
  };
  const pointer = () =>
    JSON.parse(Buffer.from(values.get("metagraph:latest")!).toString("utf8"));
  return { store, values, metadata, put, pointer };
}
const hot = artifact(
  "/metagraph/surfaces/106.json",
  bytes({ surfaces: ["a", "enriched"] }),
);
const hotBytes = bytes({ surfaces: ["a", "enriched"] });
const input = () => ({
  artifacts: [hot],
  load: vi.fn(async () => hotBytes),
  pointer: { published_at: "after" },
  bootstrapStable: [],
});

test("publication verifies content and manifest before the pointer selects exact data", async () => {
  const { store, values, pointer } = fixture();
  const result = await publishRegistryKv(store, input());
  assert.equal(result.artifacts, 1);
  assert.equal(result.uploaded, 1);
  const selected = pointer();
  assert.equal(selected.published_at, "after");
  assert.deepEqual(
    (await readRegistryManifest(store, selected.registry_manifest_sha256))
      .artifacts,
    [hot],
  );
  assert.deepEqual(values.get(registryObjectKey(hot.sha256)), hotBytes);
  assert.equal(
    vi.mocked(store.write).mock.calls.at(-1)?.[0][0]?.key,
    "metagraph:latest",
  );
});

test("preserves binary bytes and verifies them through the binary reader", async () => {
  const { store } = fixture();
  const raw = new Uint8Array([137, 80, 78, 71, 0, 255]);
  const png = artifact("/metagraph/og-image.png", raw);
  await publishRegistryKv(store, {
    ...input(),
    artifacts: [png],
    load: async () => raw,
  });
  assert.ok(
    vi
      .mocked(store.read)
      .mock.calls.some(([key]) => key === registryObjectKey(png.sha256)),
  );
  assert.ok(
    !vi
      .mocked(store.readText)
      .mock.calls.some(([keys]) =>
        keys.includes(registryObjectKey(png.sha256)),
      ),
  );
});

test("carries dated health and previous successful captures forward while removing obsolete ordinary files", async () => {
  const { store, pointer } = fixture();
  const paths = [
    "/metagraph/health/history/2026-07-01.json",
    "/metagraph/schemas/old-surface.json",
    "/metagraph/fixtures/old-surface.json",
  ];
  const raw = bytes({ captured: true });
  const stable = paths.map((path) => artifact(path, raw));
  await publishRegistryKv(store, {
    ...input(),
    bootstrapStable: stable,
    load: async (entry) => (entry.sha256 === hot.sha256 ? hotBytes : raw),
  });
  const originalDigest = pointer().registry_manifest_sha256;
  const replacement = artifact(
    "/metagraph/subnets.json",
    bytes({ replacement: true }),
  );
  await publishRegistryKv(store, {
    artifacts: [replacement],
    load: async () => bytes({ replacement: true }),
    pointer: { published_at: "next" },
  });
  const next = pointer();
  assert.equal(next.registry_previous_manifest_sha256, originalDigest);
  assert.deepEqual(
    (await readRegistryManifest(store, next.registry_manifest_sha256)).artifacts
      .map(({ path }) => path)
      .sort(),
    [...paths, replacement.path].sort(),
  );
  assert.equal(
    (await readRegistryManifest(store, originalDigest)).artifacts.length,
    4,
  );
});

test("reused objects are verified in bulk without duplicate uploads or source reads", async () => {
  const { store } = fixture();
  const data = input();
  await publishRegistryKv(store, data);
  vi.mocked(store.write).mockClear();
  vi.mocked(store.read).mockClear();
  data.load.mockClear();
  const result = await publishRegistryKv(store, data);
  assert.equal(result.uploaded, 0);
  assert.equal(data.load.mock.calls.length, 0);
  assert.equal(vi.mocked(store.write).mock.calls.length, 2);
  assert.ok(
    !vi
      .mocked(store.read)
      .mock.calls.some(([key]) => key === registryObjectKey(hot.sha256)),
  );
});

test("initial migration requires an explicit stable-history inventory", async () => {
  const { store } = fixture();
  const { artifacts, load, pointer } = input();
  const data = { artifacts, load, pointer };
  await assert.rejects(
    publishRegistryKv(store, data),
    /stable-history inventory/,
  );
  assert.equal(vi.mocked(store.write).mock.calls.length, 0);
});

test("invalid source bytes and failed readbacks cannot change the live pointer", async () => {
  const first = fixture();
  await assert.rejects(
    publishRegistryKv(first.store, {
      ...input(),
      load: async () => bytes({ corrupted: true }),
    }),
    /integrity/,
  );
  assert.equal(first.pointer().published_at, "before");
  const second = fixture();
  vi.mocked(second.store.readText).mockResolvedValueOnce({});
  await assert.rejects(
    publishRegistryKv(second.store, input()),
    /readback failed/,
  );
  assert.equal(second.pointer().published_at, "before");
});

test("a corrupt reused object prevents a new publication", async () => {
  const { store, put, pointer } = fixture();
  await publishRegistryKv(store, input());
  const before = pointer();
  put(registryObjectKey(hot.sha256), new Uint8Array(hot.size_bytes));
  await assert.rejects(publishRegistryKv(store, input()), /integrity/);
  assert.deepEqual(pointer(), before);
});

test("a concurrent pointer change aborts before selecting the prepared publication", async () => {
  const { store, put, pointer } = fixture();
  const original = store.read;
  let reads = 0;
  store.read = async (key) => {
    if (key === "metagraph:latest" && ++reads === 2)
      put(key, bytes({ published_at: "other publisher" }));
    return original(key);
  };
  await assert.rejects(
    publishRegistryKv(store, input()),
    /changed during publication/,
  );
  assert.equal(pointer().published_at, "other publisher");
});

test("storage accounting refuses growth beyond the existing budget", async () => {
  const { store } = fixture();
  vi.mocked(store.list).mockResolvedValue([
    {
      name: registryObjectKey("e".repeat(64)),
      metadata: { size_bytes: 700 * 1024 * 1024, uploaded_at: OLD, utf8: true },
    },
  ]);
  await assert.rejects(publishRegistryKv(store, input()), /storage budget/);
  assert.equal(vi.mocked(store.write).mock.calls.length, 0);
});

test("bulk publications bound each upload to 100 values", async () => {
  const { store } = fixture();
  const payloads = new Map<string, Uint8Array>();
  const entries = Array.from({ length: 105 }, (_, i) => {
    const raw = bytes({ i });
    const entry = artifact(`/metagraph/subnets/${i}.json`, raw);
    payloads.set(entry.sha256, raw);
    return entry;
  });
  await publishRegistryKv(store, {
    ...input(),
    artifacts: entries,
    load: async (entry) => payloads.get(entry.sha256)!,
  });
  assert.deepEqual(
    vi.mocked(store.write).mock.calls.map(([items]) => items.length),
    [100, 5, 1, 1],
  );
});

test("collection retains selected/previous generations and young or unrelated keys", async () => {
  const { store, put, values, metadata } = fixture();
  await publishRegistryKv(store, input());
  const otherBytes = bytes({ next: true });
  const next = artifact(hot.path, otherBytes);
  await publishRegistryKv(store, {
    ...input(),
    artifacts: [next],
    load: async () => otherBytes,
  });
  const garbage = registryObjectKey("1".repeat(64));
  const young = registryObjectKey("2".repeat(64));
  put(garbage, bytes({ garbage: true }));
  put(young, bytes({ young: true }));
  metadata.get(young)!.uploaded_at = new Date(NOW).toISOString();
  put("registry:v1:unrecognized", bytes({ preserve: true }));
  assert.equal(await collectRegistryKv(store, NOW), 1);
  assert.equal(values.has(garbage), false);
  assert.equal(values.has(young), true);
  assert.equal(values.has(registryObjectKey(hot.sha256)), true);
  assert.equal(values.has(registryObjectKey(next.sha256)), true);
  assert.equal(values.has("registry:v1:unrecognized"), true);
});

test("collection fails closed if retained data is missing or deletes do not take effect", async () => {
  const first = fixture();
  await publishRegistryKv(first.store, input());
  first.values.delete(registryObjectKey(hot.sha256));
  await assert.rejects(collectRegistryKv(first.store, NOW), /integrity/);
  assert.equal(vi.mocked(first.store.remove).mock.calls.length, 0);
  const second = fixture();
  await publishRegistryKv(second.store, input());
  second.put(registryObjectKey("3".repeat(64)), bytes({ obsolete: true }));
  second.store.remove = async () => {};
  await assert.rejects(
    collectRegistryKv(second.store, NOW),
    /absence verification/,
  );
});

test("manifest reads check the content digest, not only valid JSON", async () => {
  const { store, put } = fixture();
  const wrong = "9".repeat(64);
  put(registryManifestKey(wrong), bytes({ version: 1, artifacts: [hot] }));
  await assert.rejects(readRegistryManifest(store, wrong), /integrity/);
  await assert.rejects(readRegistryManifest(store, "bad"), /digest/);
});

test("collection retains a recently retired generation beyond the previous slot", async () => {
  const { store, metadata, pointer, values } = fixture();
  await publishRegistryKv(store, input());
  const oldest = pointer().registry_manifest_sha256;
  for (const n of [2, 3]) {
    const raw = bytes({ generation: n });
    await publishRegistryKv(store, {
      ...input(),
      artifacts: [artifact(hot.path, raw)],
      load: async () => raw,
    });
  }
  metadata.get(registryManifestKey(oldest))!.uploaded_at = new Date(
    NOW,
  ).toISOString();
  assert.notEqual(pointer().registry_previous_manifest_sha256, oldest);
  assert.equal(await collectRegistryKv(store, NOW), 0);
  assert.equal(values.has(registryObjectKey(hot.sha256)), true);
});

test("provider adapter uses native bulk APIs and checks partial-write failures", async () => {
  const key = registryObjectKey(hot.sha256);
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/bulk/get"))
      return Response.json({
        success: true,
        result: { values: { [key]: "value" } },
      });
    if (url.includes("/keys?"))
      return Response.json({
        success: true,
        result: [
          {
            name: key,
            metadata: {
              size_bytes: hot.size_bytes,
              uploaded_at: OLD,
              utf8: true,
            },
          },
        ],
        result_info: { cursor: "" },
      });
    if (url.includes("/values/"))
      return new Response(new Uint8Array(hotBytes).buffer);
    return Response.json({
      success: true,
      result: { successful_key_count: 1, unsuccessful_keys: [] },
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const store = cloudflareRegistryKvStore(
    "account",
    "test-token",
    "namespace",
    "https://registry.invalid",
  );
  await store.write([{ key, bytes: hotBytes }]);
  const payload = JSON.parse(String(calls[0]!.init.body));
  assert.equal(payload[0].base64, true);
  assert.deepEqual(Buffer.from(payload[0].value, "base64"), hotBytes);
  assert.equal(payload[0].metadata.utf8, true);
  assert.deepEqual(await store.readText([key]), { [key]: "value" });
  assert.deepEqual(await store.read(key), hotBytes);
  assert.equal((await store.list())[0]?.name, key);
  await store.remove([key]);
  assert.equal(calls.at(-1)?.url.endsWith("/bulk/delete"), true);
  assert.equal(calls.at(-1)?.init.method, "POST");
  fetcher.mockResolvedValueOnce(
    Response.json({
      success: true,
      result: { successful_key_count: 0, unsuccessful_keys: [key] },
    }),
  );
  await assert.rejects(store.write([{ key, bytes: hotBytes }]), /Incomplete/);
  await assert.rejects(
    store.remove(["metagraph:latest"]),
    /Invalid registry collection keys/,
  );
});

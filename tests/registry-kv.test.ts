import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { RegistryManifestSchema } from "../schemas-src/registry-kv.ts";
import {
  readRegistryKv,
  registryManifestKey,
  registryObjectKey,
} from "../src/registry-kv.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { readArtifact, readR2Object } from "../workers/storage.ts";

const CURRENT = "a".repeat(64);
const PREVIOUS = "b".repeat(64);
const OBJECT = "c".repeat(64);
const PATH = "/metagraph/surfaces/106.json";
const bytes = new TextEncoder().encode(
  '{"surfaces":["retained enrichment"]}',
).buffer;
const entry = { path: PATH, sha256: OBJECT, size_bytes: bytes.byteLength };
const manifest = { version: 1, artifacts: [entry] };
const pointer = { registry_manifest_sha256: CURRENT };

function binding(
  values = new Map<string, unknown>([
    [registryManifestKey(CURRENT), manifest],
    [registryObjectKey(OBJECT), bytes],
  ]),
) {
  const get = vi.fn(async (key: string) => values.get(key) ?? null);
  return { kv: { get } as unknown as KVNamespace, get, values };
}

afterEach(() => {
  resetModuleState();
  vi.useRealTimers();
});

test("selected registry serves exact JSON and reports KV without consulting R2", async () => {
  const { kv, values, get } = binding();
  values.set("metagraph:latest", pointer);
  const r2Get = vi.fn(() => {
    throw new Error("R2 must be retired");
  });
  const env = {
    METAGRAPH_CONTROL: kv,
    METAGRAPH_ARCHIVE: { get: r2Get },
  } as unknown as Env;
  const result = await readArtifact(env, PATH);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.message);
  assert.equal(result.source, "kv");
  assert.equal(result.storage_tier, "kv");
  assert.equal(result.resolution, "manifest");
  assert.deepEqual(result.data, { surfaces: ["retained enrichment"] });
  assert.equal(r2Get.mock.calls.length, 0);
  assert.deepEqual(
    get.mock.calls.map(([key]) => key),
    [
      "metagraph:latest",
      registryManifestKey(CURRENT),
      registryObjectKey(OBJECT),
    ],
  );
});

test("binary artifacts preserve every byte and need no archive binding", async () => {
  const raw = new Uint8Array([137, 80, 78, 71, 0, 255]).buffer;
  const { kv } = binding(
    new Map<string, unknown>([
      ["metagraph:latest", pointer],
      [
        registryManifestKey(CURRENT),
        {
          version: 1,
          artifacts: [
            {
              ...entry,
              path: "/metagraph/og-image.png",
              size_bytes: raw.byteLength,
            },
          ],
        },
      ],
      [registryObjectKey(OBJECT), raw],
    ]),
  );
  const result = await readR2Object(
    { METAGRAPH_CONTROL: kv },
    "/metagraph/og-image.png",
    "r2",
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.message);
  assert.deepEqual(await new Response(result.object.body).arrayBuffer(), raw);
});

test("a readable current manifest does not resurrect removed paths", async () => {
  const { kv, values, get } = binding();
  values.set(registryManifestKey(PREVIOUS), {
    version: 1,
    artifacts: [{ ...entry, path: "/metagraph/removed.json" }],
  });
  const result = await readRegistryKv(
    kv,
    { ...pointer, registry_previous_manifest_sha256: PREVIOUS },
    "/metagraph/removed.json",
  );
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unexpected hit");
  assert.equal(result.status, 404);
  assert.equal(result.code, "artifact_not_found");
  assert.equal(get.mock.calls.length, 1);
});

test.each([null, {}, { version: 2, artifacts: [entry] }])(
  "a missing or invalid manifest uses the previous complete publication: %j",
  async (bad) => {
    const { kv, values } = binding();
    values.set(registryManifestKey(CURRENT), bad);
    values.set(registryManifestKey(PREVIOUS), manifest);
    const result = await readRegistryKv(
      kv,
      { ...pointer, registry_previous_manifest_sha256: PREVIOUS },
      PATH,
    );
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error(result.message);
    assert.equal(result.resolution, "fallback");
    assert.deepEqual(await result.object.json(), {
      surfaces: ["retained enrichment"],
    });
  },
);

test.each([null, new ArrayBuffer(1)])(
  "a missing or truncated object falls back without an R2 read: %j",
  async (bad) => {
    const { kv, values } = binding();
    const oldObject = "d".repeat(64);
    values.set(registryObjectKey(OBJECT), bad);
    values.set(registryManifestKey(PREVIOUS), {
      version: 1,
      artifacts: [{ ...entry, sha256: oldObject }],
    });
    values.set(registryObjectKey(oldObject), bytes);
    const result = await readRegistryKv(
      kv,
      { ...pointer, registry_previous_manifest_sha256: PREVIOUS },
      PATH,
    );
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error(result.message);
    assert.equal(result.resolution, "fallback");
  },
);

test("transient errors are retried; successful immutable indexes are coalesced and reused", async () => {
  const { kv, get } = binding();
  get.mockRejectedValueOnce(new Error("temporary"));
  const failed = await readRegistryKv(kv, pointer, PATH);
  assert.equal(failed.ok, false);
  if (failed.ok) throw new Error("unexpected hit");
  assert.equal(failed.code, "registry_unavailable");
  assert.equal(failed.status, 503);
  const results = await Promise.all([
    readRegistryKv(kv, pointer, PATH),
    readRegistryKv(kv, pointer, PATH),
  ]);
  assert.ok(results.every((result) => result.ok));
  await readRegistryKv(kv, pointer, PATH);
  assert.equal(
    get.mock.calls.filter(([key]) => key === registryManifestKey(CURRENT))
      .length,
    2,
  );
});

test("an immutable index is isolated by binding and evicted after four generations", async () => {
  const first = binding();
  const second = binding();
  await readRegistryKv(first.kv, pointer, PATH);
  await readRegistryKv(second.kv, pointer, PATH);
  assert.equal(second.get.mock.calls[0]?.[0], registryManifestKey(CURRENT));
  for (const digit of ["1", "2", "3", "4"]) {
    const digest = digit.repeat(64);
    first.values.set(registryManifestKey(digest), manifest);
    assert.equal(
      (
        await readRegistryKv(
          first.kv,
          { registry_manifest_sha256: digest },
          PATH,
        )
      ).ok,
      true,
    );
  }
  await readRegistryKv(first.kv, pointer, PATH);
  assert.equal(
    first.get.mock.calls.filter(([key]) => key === registryManifestKey(CURRENT))
      .length,
    2,
  );
});

test("module reset releases cached indexes", async () => {
  const { kv, get } = binding();
  await readRegistryKv(kv, pointer, PATH);
  resetModuleState();
  await readRegistryKv(kv, pointer, PATH);
  assert.equal(
    get.mock.calls.filter(([key]) => key === registryManifestKey(CURRENT))
      .length,
    2,
  );
});

test("invalid digest and absent generations cannot become arbitrary KV key reads", async () => {
  const { kv, get } = binding();
  assert.equal((await readRegistryKv(kv, {}, PATH)).ok, false);
  assert.equal(
    (
      await readRegistryKv(
        kv,
        { registry_manifest_sha256: "metagraph:latest" },
        PATH,
      )
    ).ok,
    false,
  );
  assert.equal(get.mock.calls.length, 0);
});

test("a hung KV object read is bounded and never reverts to R2", async () => {
  const { kv, get, values } = binding();
  values.set("metagraph:latest", pointer);
  get.mockImplementation(async (key) =>
    key === registryObjectKey(OBJECT) ? new Promise(() => {}) : values.get(key),
  );
  const r2Get = vi.fn();
  vi.useFakeTimers();
  const pending = readR2Object(
    {
      METAGRAPH_CONTROL: kv,
      METAGRAPH_R2_TIMEOUT_MS: "5",
      METAGRAPH_ARCHIVE: { get: r2Get } as unknown as R2Bucket,
    },
    PATH,
    "r2",
  );
  await vi.advanceTimersByTimeAsync(6);
  const result = await pending;
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unexpected hit");
  assert.equal(result.code, "registry_timeout");
  assert.equal(result.status, 504);
  assert.equal(r2Get.mock.calls.length, 0);
});

test("manifest contract rejects ambiguous paths, excess values and malformed entries", () => {
  for (const bad of [
    { version: 1, artifacts: [] },
    { version: 1, artifacts: [entry, entry] },
    { version: 1, artifacts: [{ ...entry, path: "/metagraph/../other" }] },
    { version: 1, artifacts: [{ ...entry, path: "outside" }] },
    { version: 1, artifacts: [{ ...entry, sha256: "invalid" }] },
    { version: 1, artifacts: [{ ...entry, size_bytes: 25 * 1024 * 1024 + 1 }] },
  ])
    assert.equal(RegistryManifestSchema.safeParse(bad).success, false);
});

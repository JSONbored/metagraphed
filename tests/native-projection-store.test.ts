import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { beforeEach, afterEach, test, vi } from "vitest";
import { z } from "zod";
import {
  loadNativeProjectionManifest,
  validateNativeProjectionManifest,
  readNativeProjectionObject,
  nativeProjectionsEnabled,
  isNativeProjectionKey,
  NATIVE_PROJECTION_FILES,
  NATIVE_PROJECTION_STALE_MS,
} from "../src/native-projection-store.ts";
import { readArtifactObject } from "../src/projection-store.ts";
import {
  PROJECTION_LANES,
  runProjectionLanes,
  projectionKey,
} from "../src/projection-lanes.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import type { ChainNetworkId } from "../src/chain-network.ts";

type ObjectFixture = { raw: string; etag: string; size: number };
const objects: Record<string, ObjectFixture> = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL("./fixtures/native-projections/serving.json.gz", import.meta.url),
    ),
  ).toString(),
);
const currentKey = (network: ChainNetworkId) =>
  `metagraph/native-projections/v1/${network}/current.json`;
const proof = (network: ChainNetworkId = "mainnet") =>
  JSON.parse(objects[currentKey(network)].raw);
const now = proof().generatedAt as number;
function fixture() {
  const records = structuredClone(objects);
  const gets: string[] = [];
  const bucket = {
    async get(key: string) {
      gets.push(key);
      const value = records[key];
      return value
        ? {
            ...value,
            async json() {
              return JSON.parse(value.raw);
            },
          }
        : null;
    },
  };
  return {
    records,
    gets,
    bucket,
    env: { NATIVE_PROJECTIONS: "enabled", METAGRAPH_ARCHIVE: bucket },
  };
}
beforeEach(() => {
  resetModuleState();
  vi.spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => vi.restoreAllMocks());

test("native producer manifests cover every canonical artifact and preserve its bytes", async () => {
  const { env, gets } = fixture();
  for (const network of ["mainnet", "testnet"] as const) {
    const manifest = await loadNativeProjectionManifest(env, network);
    assert.deepEqual(manifest, proof(network));
    assert.equal(manifest!.artifacts.length, NATIVE_PROJECTION_FILES.length);
    for (const lane of PROJECTION_LANES)
      assert.ok(
        manifest!.artifacts.some(
          (item) =>
            item.artifactKey === projectionKey(lane.artifactKey, network),
        ),
      );
    for (const item of manifest!.artifacts) {
      const base = `metagraph/projections/${item.artifactKey.split("/").at(-1)}`;
      assert.ok(isNativeProjectionKey(base));
      const body = await readArtifactObject(
        env,
        base,
        network,
        z.record(z.string(), z.unknown()),
      );
      assert.deepEqual(body, JSON.parse(objects[item.object.key].raw));
    }
    assert.equal(gets.filter((key) => key === currentKey(network)).length, 1);
  }
  assert.ok(
    gets.every((key) => key.startsWith("metagraph/native-projections/")),
  );
  assert.ok(nativeProjectionsEnabled(env));
  assert.equal(nativeProjectionsEnabled(null), false);
  assert.equal(
    isNativeProjectionKey("metagraph/projections/another.json"),
    false,
  );
});

test("manifest identity and complete census reject cross-network, foreign and partial generations", () => {
  assert.equal(validateNativeProjectionManifest({}, "mainnet"), null);
  const mutate = [
    (p: ReturnType<typeof proof>) => {
      p.network = "testnet";
    },
    (p: ReturnType<typeof proof>) => {
      p.sources[1] = p.sources[0];
    },
    (p: ReturnType<typeof proof>) => {
      p.sources[0].network = "testnet";
    },
    (p: ReturnType<typeof proof>) => {
      p.sources[0].cutoff++;
    },
    (p: ReturnType<typeof proof>) => {
      p.artifacts[1] = p.artifacts[0];
    },
    (p: ReturnType<typeof proof>) => {
      p.artifacts[0].object.key += "bad";
    },
    (p: ReturnType<typeof proof>) => {
      p.artifacts[0].artifactKey = "foreign.json";
    },
    (p: ReturnType<typeof proof>) => {
      p.artifacts.pop();
    },
  ];
  for (const change of mutate) {
    const value = proof();
    change(value);
    assert.equal(validateNativeProjectionManifest(value, "mainnet"), null);
  }
});

test("selection cache is bounded and a fresh ownership check bypasses it", async () => {
  const { env, records, gets } = fixture();
  assert.ok(await loadNativeProjectionManifest(env, "mainnet"));
  records[currentKey("mainnet")].raw = "{}";
  assert.ok(await loadNativeProjectionManifest(env, "mainnet"));
  assert.equal(gets.length, 1);
  vi.mocked(Date.now).mockReturnValue(now + 30_001);
  assert.equal(await loadNativeProjectionManifest(env, "mainnet"), null);
  records[currentKey("mainnet")].raw = objects[currentKey("mainnet")].raw;
  assert.ok(await loadNativeProjectionManifest(env, "mainnet", true));
  assert.equal(gets.length, 3);
  resetModuleState();
  assert.ok(await loadNativeProjectionManifest(env, "mainnet"));
  assert.equal(gets.length, 4);
});

test("missing, oversized and unreadable native proofs decline without a legacy read", async () => {
  assert.equal(await loadNativeProjectionManifest(undefined, "mainnet"), null);
  assert.equal(
    await loadNativeProjectionManifest({ METAGRAPH_ARCHIVE: {} }, "mainnet"),
    null,
  );
  for (const size of [undefined, 0, 65537]) {
    const { env, records } = fixture();
    records[currentKey("mainnet")].size = size as number;
    assert.equal(await loadNativeProjectionManifest(env, "mainnet"), null);
  }
  const { env, records, gets } = fixture();
  delete records[currentKey("mainnet")];
  assert.equal(
    await readArtifactObject(
      env,
      "metagraph/projections/chain-fees.json",
      "mainnet",
      z.object({ windows: z.unknown() }),
    ),
    null,
  );
  assert.deepEqual(gets, [currentKey("mainnet")]);
  env.METAGRAPH_ARCHIVE.get = async () => {
    throw new Error("unavailable");
  };
  assert.equal(await loadNativeProjectionManifest(env, "mainnet", true), null);
});

test("immutable descriptors and capture timestamps fence every selected body", async () => {
  for (const kind of [
    "missing",
    "etag",
    "size",
    "timestamp",
    "null",
    "json",
    "schema",
  ]) {
    const { env, records } = fixture();
    const selected = proof().artifacts[0];
    if (kind === "missing") delete records[selected.object.key];
    else if (kind === "etag") records[selected.object.key].etag = "changed";
    else if (kind === "size") records[selected.object.key].size++;
    else if (kind === "timestamp") records[selected.object.key].raw = "{}";
    else if (kind === "null") records[selected.object.key].raw = "null";
    else if (kind === "json") records[selected.object.key].raw = "{";
    assert.equal(
      await readArtifactObject<unknown>(
        env,
        selected.artifactKey,
        "mainnet",
        kind === "schema" ? z.string() : z.object({ summary: z.unknown() }),
      ),
      null,
    );
  }
  const { env } = fixture();
  assert.equal(
    await readNativeProjectionObject(
      env,
      "metagraph/projections/unknown.json",
      "mainnet",
    ),
    null,
  );
});

test("native ownership leaves unrelated projections on their existing reader", async () => {
  const { env, records, gets } = fixture();
  const key = "metagraph/projections/unrelated.json";
  records[key] = { raw: '{"value":17}', etag: "e", size: 12 };
  assert.deepEqual(
    await readArtifactObject(
      env,
      key,
      "mainnet",
      z.object({ value: z.number() }),
    ),
    { value: 17 },
  );
  assert.deepEqual(gets, [key]);
});

test("scheduled native ownership never issues SQL, writes artifacts, or hides a stale producer", async () => {
  const { env, records } = fixture();
  const request = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("SQL forbidden");
  });
  const errors: unknown[] = [];
  const recordException = async (_env: unknown, item: unknown) => {
    errors.push(item);
    return true;
  };
  let result = await runProjectionLanes(env as unknown as Env, {
    recordException,
  });
  assert.equal(result.ok, true);
  assert.equal(Object.keys(result.lanes).length, PROJECTION_LANES.length * 2);
  assert.equal(errors.length, 0);
  records[currentKey("testnet")].raw = "{}";
  result = await runProjectionLanes(env as unknown as Env, { recordException });
  assert.equal(result.ok, true);
  assert.equal(result.lanes["chain-fees:testnet"], null);
  assert.equal(errors.length, 1);
  vi.mocked(Date.now).mockReturnValue(now + NATIVE_PROJECTION_STALE_MS + 1);
  result = await runProjectionLanes(env as unknown as Env, { recordException });
  assert.equal(result.ok, false);
  assert.ok(Object.values(result.lanes).every((value) => value === null));
  vi.mocked(Date.now).mockReturnValue(now - 1);
  assert.equal(
    (await runProjectionLanes(env as unknown as Env, { recordException })).ok,
    false,
  );
  // Exercise the production recorder too; with no telemetry binding it must remain quiet.
  assert.equal((await runProjectionLanes(env as unknown as Env)).ok, false);
  assert.equal(request.mock.calls.length, 0);
});

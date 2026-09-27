import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, test } from "vitest";
import { nativeProjectionD1 } from "../src/native-projection-d1.ts";
import {
  loadNativeProjectionManifest,
  readNativeProjectionObject,
} from "../src/native-projection-store.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { readArtifactObject } from "../src/projection-store.ts";
import { z } from "zod";
import { runProjectionStalenessWatchdog } from "../src/projection-staleness-watchdog.ts";

const databases: DatabaseSync[] = [];
beforeEach(() => resetModuleState());
afterEach(() => databases.splice(0).forEach((db) => db.close()));
const hash = (raw: Buffer, algorithm = "sha256") =>
  createHash(algorithm).update(raw).digest("hex");
function fixture() {
  const sql = new DatabaseSync(":memory:");
  databases.push(sql);
  sql.exec(
    readFileSync(
      new URL("../migrations/d1/0027_generated_artifacts.sql", import.meta.url),
      "utf8",
    ),
  );
  const reads: string[] = [];
  const db = {
    prepare(text: string) {
      return {
        bind(key: string) {
          return {
            async first() {
              reads.push(key);
              return sql.prepare(text).get(key) ?? null;
            },
          };
        },
      };
    },
  } as unknown as Pick<D1Database, "prepare">;
  function put(key: string, value: unknown) {
    sql
      .prepare("INSERT OR REPLACE INTO generated_artifacts VALUES(?,?,?)")
      .run(key, JSON.stringify(value), "2026-09-27T00:00:00Z");
  }
  function seed(key: string, raw: Buffer) {
    const compressed = gzipSync(raw);
    const descriptor = {
      format: "gzip-json-v1",
      bytes: raw.length,
      compressedBytes: compressed.length,
      parts: Math.ceil(compressed.length / 65_536),
      etag: hash(raw, "md5"),
      sha256: hash(raw),
    };
    for (let index = 0; index < descriptor.parts; index++)
      put(`${key}/chunks/${index}`, {
        data: compressed
          .subarray(index * 65_536, (index + 1) * 65_536)
          .toString("base64"),
      });
    put(key, descriptor);
    return descriptor;
  }
  return { sql, db, reads, put, seed, store: nativeProjectionD1(db) };
}

const objects: Record<string, { raw: string; etag: string; size: number }> =
  JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(
          "./fixtures/native-projections/serving.json.gz",
          import.meta.url,
        ),
      ),
    ).toString(),
  );
const currentKey = (network: string) =>
  `metagraph/native-projections/v1/${network}/current.json`;

test("both networks retain every native projection through the real D1 schema, without R2 reads", async () => {
  const { db, put, seed } = fixture();
  const env = { D1_STATE: db, NATIVE_PROJECTIONS: "enabled" };
  for (const network of ["mainnet", "testnet"] as const) {
    const expected = JSON.parse(objects[currentKey(network)].raw);
    put(currentKey(network), expected);
    for (const item of expected.artifacts)
      seed(item.object.key, Buffer.from(objects[item.object.key].raw));
    assert.deepEqual(
      await loadNativeProjectionManifest(env, network),
      expected,
    );
    for (const item of expected.artifacts) {
      const key = `metagraph/projections/${item.artifactKey.split("/").at(-1)}`;
      assert.deepEqual(
        await readNativeProjectionObject(env, key, network),
        JSON.parse(objects[item.object.key].raw),
      );
      assert.deepEqual(
        await readArtifactObject(
          env,
          key,
          network,
          z.record(z.string(), z.unknown()),
        ),
        JSON.parse(objects[item.object.key].raw),
      );
    }
  }
});

test("compressed chunks restore exact multibyte JSON and large integer strings", async () => {
  const { seed, store } = fixture();
  const expected = {
    name: "界🌍",
    amount: "18446744073709551615",
    noise: randomBytes(100_000).toString("base64"),
  };
  const raw = Buffer.from(JSON.stringify(expected));
  const descriptor = seed("projection", raw);
  assert.ok(descriptor.parts > 1);
  const object = await store.get("projection");
  assert.equal(object!.size, raw.length);
  assert.equal(object!.etag, hash(raw, "md5"));
  assert.deepEqual(await object!.json(), expected);
  assert.equal(await store.get("missing"), null);
});

test("corrupt, missing and oversized chunks fail without acknowledging a restored object", async () => {
  const mutations: Array<
    (
      f: ReturnType<typeof fixture>,
      d: ReturnType<ReturnType<typeof fixture>["seed"]>,
    ) => void
  > = [
    (f) => f.put("projection", { format: "unsupported" }),
    (f, d) => f.put("projection", { ...d, parts: 2 }),
    (f) => {
      f.sql
        .prepare("DELETE FROM generated_artifacts WHERE key=?")
        .run("projection/chunks/0");
    },
    (f) => f.put("projection/chunks/0", { data: null }),
    (f) => f.put("projection/chunks/0", { data: "a".repeat(87_385) }),
    (f) => f.put("projection/chunks/0", { data: "*" }),
    (f) => f.put("projection/chunks/0", { data: "" }),
    (f, d) =>
      f.put("projection/chunks/0", {
        data: Buffer.alloc(d.compressedBytes).toString("base64"),
      }),
    (f, d) => f.put("projection", { ...d, bytes: d.bytes - 1 }),
    (f, d) => f.put("projection", { ...d, bytes: d.bytes + 1 }),
    (f, d) => f.put("projection", { ...d, sha256: "0".repeat(64) }),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    const descriptor = f.seed("projection", Buffer.from('{"retained":"界"}'));
    mutate(f, descriptor);
    await assert.rejects(f.store.get("projection"));
  }
  for (const raw of [Buffer.from("invalid json"), Buffer.from([0xff])]) {
    const f = fixture();
    f.seed("projection", raw);
    const object = await f.store.get("projection");
    await assert.rejects(object!.json());
  }
});

test("a D1-selected manifest never falls back after missing data or a database error", async () => {
  const { db, put, sql } = fixture();
  const expected = JSON.parse(objects[currentKey("mainnet")].raw);
  const r2Reads: string[] = [];
  const bucket = {
    async get(key: string) {
      r2Reads.push(key);
      const value = objects[key];
      return { ...value, json: async () => JSON.parse(value.raw) };
    },
  };
  const env = { D1_STATE: db, METAGRAPH_ARCHIVE: bucket };
  for (const unusable of [undefined, null, false, {}, { prepare: false }]) {
    resetModuleState();
    assert.deepEqual(
      await loadNativeProjectionManifest(
        { ...env, D1_STATE: unusable },
        "mainnet",
      ),
      expected,
    );
  }
  r2Reads.length = 0;
  resetModuleState();
  // Before this network is published, preserve the existing R2 owner.
  assert.deepEqual(
    await loadNativeProjectionManifest(env, "mainnet"),
    expected,
  );
  assert.equal(r2Reads.length, 1);
  put(currentKey("mainnet"), expected);
  assert.deepEqual(
    await loadNativeProjectionManifest(env, "mainnet", true),
    expected,
  );
  const key = `metagraph/projections/${expected.artifacts[0].artifactKey.split("/").at(-1)}`;
  assert.equal(await readNativeProjectionObject(env, key, "mainnet"), null);
  put(currentKey("mainnet"), { invalid: true });
  assert.equal(await loadNativeProjectionManifest(env, "mainnet", true), null);
  sql.exec("DROP TABLE generated_artifacts");
  assert.equal(await loadNativeProjectionManifest(env, "mainnet", true), null);
  assert.equal(r2Reads.length, 1);
});

for (const failure of [
  "none",
  "absent",
  "corrupt",
  "empty",
  "stale",
] as const) {
  test(`projection watchdog follows D1 ownership and preserves ${failure} verdict`, async () => {
    const { db, put, seed, reads } = fixture();
    const now = Math.max(
      ...["mainnet", "testnet"].map(
        (network) =>
          JSON.parse(objects[currentKey(network)].raw).generatedAt as number,
      ),
    );
    let legacyReads = 0;
    const env = {
      D1_STATE: db,
      NATIVE_PROJECTIONS: "enabled",
      METAGRAPH_ARCHIVE: {
        async get() {
          legacyReads++;
          throw new Error("Retired R2 projections must not be consulted");
        },
      },
    };
    for (const network of ["mainnet", "testnet"] as const) {
      const manifest = JSON.parse(objects[currentKey(network)].raw);
      if (failure === "stale" && network === "mainnet") {
        manifest.generatedAt = now - 5 * 3_600_000;
        for (const source of manifest.sources)
          source.cutoff = manifest.generatedAt - 90 * 86_400_000;
      }
      for (const item of manifest.artifacts) {
        const body = JSON.parse(objects[item.object.key].raw);
        body.generated_at = new Date(manifest.generatedAt).toISOString();
        const target =
          network === "mainnet" &&
          item.artifactKey.endsWith("/blocks-summary.json");
        if (target && failure === "empty") body.row_count = 0;
        if (target && failure === "absent") continue;
        const descriptor = seed(
          item.object.key,
          Buffer.from(JSON.stringify(body)),
        );
        item.object.etag = descriptor.etag;
        item.object.bytes = descriptor.bytes;
        if (target && failure === "corrupt")
          put(`${item.object.key}/chunks/0`, { data: "eA==" });
      }
      put(currentKey(network), manifest);
    }
    const messages: string[] = [];
    const result = await runProjectionStalenessWatchdog(env, {
      now: () => now,
      laneHealthDb: null,
      recordException: async (_env, event) => {
        messages.push(String(event.error));
        return true;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.stale, failure !== "none");
    assert.equal(messages.length, failure === "none" ? 0 : 1);
    if (failure !== "none") assert.match(messages[0]!, /blocks-summary/);
    if (failure === "empty") assert.match(messages[0]!, /fresh, 0 rows/);
    if (failure === "stale") assert.match(messages[0]!, /5.0 h old/);
    assert.equal(legacyReads, 0);
    for (const network of ["mainnet", "testnet"])
      assert.equal(
        reads.filter((key) => key === currentKey(network)).length,
        1,
      );
  });
}

test("native projection watchdog reports absent generations without requiring an R2 binding", async () => {
  const { db } = fixture();
  const result = await runProjectionStalenessWatchdog(
    { D1_STATE: db, NATIVE_PROJECTIONS: "enabled" },
    {
      laneHealthDb: null,
      recordException: async () => true,
    },
  );
  assert.equal(result.ok, true);
  assert.equal(result.stale, true);
});

import assert from "node:assert/strict";
import { test, vi } from "vitest";
import {
  readArtifact,
  readAsset,
  readR2,
  readR2Object,
  latestR2Key,
} from "../workers/storage.ts";
import type { Row } from "./row-type.ts";

// A git/dual-tier artifact (not in any R2-only pattern) serves ASSETS-first,
// then falls back to R2. These tests drive that fallback chain and the
// no-binding guards in readAsset/readR2 directly.

const r2Object = (data: unknown) => ({
  async json() {
    return data;
  },
});

function assetsMiss() {
  return {
    async fetch() {
      return new Response("not found", { status: 404 });
    },
  };
}

function assetsHit(data: unknown) {
  return {
    async fetch() {
      return Response.json(data);
    },
  };
}

test("readArtifact falls back to R2 when the static asset misses (git tier line 97)", async () => {
  const env = {
    ASSETS: assetsMiss(),
    METAGRAPH_ARCHIVE: {
      async get() {
        return r2Object({ from: "r2" });
      },
    },
    // No control binding → latestR2Key uses the default prefix.
  } as unknown as Env;
  const result = await readArtifact(env, "/metagraph/unknown-file.json");
  assert.equal(result.ok, true);
  assert.equal(result.source, "r2");
  assert.deepEqual(result.data, { from: "r2" });
});

test("readArtifact prefers the static asset for a git/dual tier when it hits", async () => {
  const env = {
    ASSETS: assetsHit({ from: "assets" }),
    METAGRAPH_ARCHIVE: {
      async get() {
        return r2Object({ from: "r2" });
      },
    },
  } as unknown as Env;
  const result = await readArtifact(env, "/metagraph/unknown-file.json");
  assert.equal(result.ok, true);
  assert.equal(result.source, "static-assets");
  assert.deepEqual(result.data, { from: "assets" });
});

test("readArtifact surfaces the asset error when both tiers miss and the asset was not a 404", async () => {
  const env = {
    ASSETS: {
      async fetch() {
        return new Response("boom", { status: 500 });
      },
    },
    METAGRAPH_ARCHIVE: {
      async get() {
        return null; // R2 cold → 404
      },
    },
  } as unknown as Env;
  const result = await readArtifact(env, "/metagraph/unknown-file.json");
  assert.equal(result.ok, false);
  // asset.status (500) !== 404, so the non-404 asset result wins.
  assert.equal(result.status, 500);
  assert.equal(result.code, "artifact_not_found");
});

test("readAsset returns asset_binding_missing when no ASSETS binding is configured (line 105)", async () => {
  const result = await readAsset(
    {} as unknown as Env,
    "/metagraph/unknown-file.json",
    "git",
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "asset_binding_missing");
  assert.match(result.message, /No ASSETS binding/);
});

test("readR2 returns r2_binding_missing when no archive binding is configured", async () => {
  const result = await readR2(
    {} as unknown as Env,
    "/metagraph/unknown-file.json",
    "git",
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "r2_binding_missing");
});

// ---- readR2Object: the binary-safe sibling of readR2, used by the og-image
// live route (src/og-image.ts) so a PNG body never gets run through .json().

test("readR2Object returns r2_binding_missing when no archive binding is configured", async () => {
  const result = await readR2Object(
    {} as unknown as Env,
    "/metagraph/og-image.png",
    "r2",
  );
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "r2_binding_missing");
});

test("readR2Object returns artifact_not_found when the R2 object is cold", async () => {
  const env = {
    METAGRAPH_ARCHIVE: {
      async get() {
        return null;
      },
    },
  } as unknown as Env;
  const result = await readR2Object(env, "/metagraph/og-image.png", "r2");
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "artifact_not_found");
});

test("readR2Object returns r2_timeout when the R2 read hangs", async () => {
  const env = {
    METAGRAPH_R2_TIMEOUT_MS: "5",
    METAGRAPH_ARCHIVE: {
      async get() {
        return new Promise(() => {});
      },
    },
  } as unknown as Env;
  const result = await readR2Object(env, "/metagraph/og-image.png", "r2");
  assert.equal(result.ok, false);
  assert.equal(result.status, 504);
  assert.equal(result.code, "r2_timeout");
});

test("readR2Object returns the raw R2Object unparsed on a hit", async () => {
  const rawObject = { body: "BINARY-PNG-BYTES", httpMetadata: {} };
  const env = {
    METAGRAPH_ARCHIVE: {
      async get() {
        return rawObject;
      },
    },
  } as unknown as Env;
  const result = await readR2Object(env, "/metagraph/og-image.png", "r2");
  assert.equal(result.ok, true);
  assert.equal(result.object, rawObject);
  assert.equal(result.source, "r2");
  assert.equal(result.storage_tier, "r2");
});

test("readR2 delegates to readR2Object and JSON-parses its object on a hit", async () => {
  const env = {
    METAGRAPH_ARCHIVE: {
      async get() {
        return r2Object({ parsed: true });
      },
    },
  } as unknown as Env;
  const result = await readR2(env, "/metagraph/unknown-file.json", "git");
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { parsed: true });
  assert.equal(result.source, "r2");
});

// ---- health/history stable-latest key (#6508) ------------------------------
// Every artifact but health/history/{date}.json resolves through the
// versioned run-prefix the KV pointer names (atomic reads across a whole
// publish). health/history is write-once per date, so it bypasses that
// pointer and always reads the literal "latest/" prefix -- the one key
// space r2-upload.ts actually accumulates one file per date into.

test("latestR2Key resolves a health/history date through the literal latest/ prefix, ignoring the run-prefix pointer", async () => {
  const env = {
    METAGRAPH_CONTROL: {
      async get() {
        return { latest_prefix: "runs/2026-07-17T11-21-50-971Z/" };
      },
    },
  } as unknown as Env;
  const key = await latestR2Key(
    "/metagraph/health/history/2026-07-01.json",
    env,
  );
  assert.equal(key, "latest/health/history/2026-07-01.json");
});

test("latestR2Key still resolves an ordinary artifact through the pointer's run prefix", async () => {
  const env = {
    METAGRAPH_CONTROL: {
      async get() {
        return { latest_prefix: "runs/2026-07-17T11-21-50-971Z/" };
      },
    },
  } as unknown as Env;
  const key = await latestR2Key("/metagraph/subnets.json", env);
  assert.equal(key, "runs/2026-07-17T11-21-50-971Z/subnets.json");
});

test("readR2 for a health/history date reads the literal latest/ key even when the pointer names a different run prefix", async () => {
  let requestedKey;
  const env = {
    METAGRAPH_CONTROL: {
      async get() {
        return { latest_prefix: "runs/2026-07-17T11-21-50-971Z/" };
      },
    },
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        requestedKey = key;
        return r2Object({ date: "2026-07-01" });
      },
    },
  } as unknown as Env;
  const result = await readR2(
    env,
    "/metagraph/health/history/2026-07-01.json",
    "r2",
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, { date: "2026-07-01" });
  assert.equal(requestedKey, "latest/health/history/2026-07-01.json");
});

// ---- schemas/fixtures stable-latest key (#6509) ----------------------------
// Same shape as health/history above, different cause: these are mutable,
// best-effort per-item captures. A single transient failure on the most
// recent publish makes that one item vanish from the run-prefix tree
// entirely, while a perfectly good prior capture sits untouched at the
// literal latest/ key.

test("latestR2Key resolves an individual schema document through the literal latest/ prefix", async () => {
  const env = {
    METAGRAPH_CONTROL: {
      async get() {
        return { latest_prefix: "runs/2026-07-17T11-21-50-971Z/" };
      },
    },
  } as unknown as Env;
  const key = await latestR2Key(
    "/metagraph/schemas/sn-6-numinous-openapi-schema.json",
    env,
  );
  assert.equal(key, "latest/schemas/sn-6-numinous-openapi-schema.json");
});

test("latestR2Key still resolves schemas/index.json through the pointer's run prefix, not the stable key", async () => {
  const env = {
    METAGRAPH_CONTROL: {
      async get() {
        return { latest_prefix: "runs/2026-07-17T11-21-50-971Z/" };
      },
    },
  } as unknown as Env;
  const key = await latestR2Key("/metagraph/schemas/index.json", env);
  assert.equal(key, "runs/2026-07-17T11-21-50-971Z/schemas/index.json");
});

test("latestR2Key resolves an individual fixture document through the literal latest/ prefix", async () => {
  const env = {
    METAGRAPH_CONTROL: {
      async get() {
        return { latest_prefix: "runs/2026-07-17T11-21-50-971Z/" };
      },
    },
  } as unknown as Env;
  const key = await latestR2Key(
    "/metagraph/fixtures/sn-1-apex-healthcheck-ready.json",
    env,
  );
  assert.equal(key, "latest/fixtures/sn-1-apex-healthcheck-ready.json");
});

test("latestR2Key still resolves fixtures/_capture-report.json through the pointer's run prefix, not the stable key", async () => {
  const env = {
    METAGRAPH_CONTROL: {
      async get() {
        return { latest_prefix: "runs/2026-07-17T11-21-50-971Z/" };
      },
    },
  } as unknown as Env;
  const key = await latestR2Key(
    "/metagraph/fixtures/_capture-report.json",
    env,
  );
  assert.equal(
    key,
    "runs/2026-07-17T11-21-50-971Z/fixtures/_capture-report.json",
  );
});

test("readR2 for a schema document reads the literal latest/ key even when the pointer names a different run prefix", async () => {
  let requestedKey;
  const env = {
    METAGRAPH_CONTROL: {
      async get() {
        return { latest_prefix: "runs/2026-07-17T11-21-50-971Z/" };
      },
    },
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        requestedKey = key;
        return r2Object({ surface_id: "sn-6-numinous-openapi-schema" });
      },
    },
  } as unknown as Env;
  const result = await readR2(
    env,
    "/metagraph/schemas/sn-6-numinous-openapi-schema.json",
    "r2",
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, {
    surface_id: "sn-6-numinous-openapi-schema",
  });
  assert.equal(
    requestedKey,
    "latest/schemas/sn-6-numinous-openapi-schema.json",
  );
});

// ---- R2-preferred dual artifacts (lines 78-87) -----------------------------
// R2_PREFERRED_DUAL_PATTERNS is currently empty (subnets/coverage moved to plain
// R2-only), so isR2PreferredDualArtifactPath() never matches a real path. The
// R2-first-then-asset fallback logic in readArtifact is still live code and is
// the correct serving path for any future dual artifact that needs fresh
// per-publish fields. Mock the predicate to true (the tier stays a real "dual")
// to drive the three branches: R2 hit, asset fallback, and the
// non-404-wins tiebreak.

test("readArtifact serves R2-first for an R2-preferred dual artifact (R2 hit)", async () => {
  vi.resetModules();
  vi.doMock("../src/artifact-storage.ts", async (importOriginal) => {
    const actual = (await importOriginal()) as Row;
    return { ...actual, isR2PreferredDualArtifactPath: () => true };
  });
  const { readArtifact: read } = await import("../workers/storage.ts");
  const env = {
    ASSETS: assetsHit({ from: "assets" }),
    METAGRAPH_ARCHIVE: {
      async get() {
        return r2Object({ from: "r2-fresh" });
      },
    },
  } as unknown as Env;
  const result = await read(env, "/metagraph/contracts.json");
  assert.equal(result.ok, true);
  assert.equal(result.source, "r2");
  assert.deepEqual(result.data, { from: "r2-fresh" });
  vi.doUnmock("../src/artifact-storage.ts");
  vi.resetModules();
});

test("readArtifact falls back to the committed baseline when R2 is cold for an R2-preferred dual artifact", async () => {
  vi.resetModules();
  vi.doMock("../src/artifact-storage.ts", async (importOriginal) => {
    const actual = (await importOriginal()) as Row;
    return { ...actual, isR2PreferredDualArtifactPath: () => true };
  });
  const { readArtifact: read } = await import("../workers/storage.ts");
  const env = {
    ASSETS: assetsHit({ from: "committed-baseline" }),
    METAGRAPH_ARCHIVE: {
      async get() {
        return null; // R2 cold → 404
      },
    },
  } as unknown as Env;
  const result = await read(env, "/metagraph/contracts.json");
  assert.equal(result.ok, true);
  assert.equal(result.source, "static-assets");
  assert.deepEqual(result.data, { from: "committed-baseline" });
  vi.doUnmock("../src/artifact-storage.ts");
  vi.resetModules();
});

test("readArtifact returns the non-404 R2 error over the asset 404 for an R2-preferred dual artifact", async () => {
  vi.resetModules();
  vi.doMock("../src/artifact-storage.ts", async (importOriginal) => {
    const actual = (await importOriginal()) as Row;
    return { ...actual, isR2PreferredDualArtifactPath: () => true };
  });
  const { readArtifact: read } = await import("../workers/storage.ts");
  const env = {
    METAGRAPH_R2_TIMEOUT_MS: "5",
    ASSETS: assetsMiss(), // asset → 404
    METAGRAPH_ARCHIVE: {
      async get() {
        // never resolves → withTimeout rejects → r2 504
        return new Promise(() => {});
      },
    },
  } as unknown as Env;
  const result = await read(env, "/metagraph/contracts.json");
  assert.equal(result.ok, false);
  // r2Preferred.status (504) !== 404, so the R2 error wins the tiebreak.
  assert.equal(result.status, 504);
  assert.equal(result.code, "r2_timeout");
  vi.doUnmock("../src/artifact-storage.ts");
  vi.resetModules();
});

// ---- #8277: manifest-resolved, content-addressed reads -----------------------
// The pointer names an IMMUTABLE per-run manifest (path -> by-hash key), so a
// publish overwriting the mutable latest/ tree can never be observed mid-run.
// Every case below also asserts the degrade path, because this resolution is
// deliberately best-effort: it must never turn a readable artifact into a 404.

function manifestEnv(
  manifest: unknown,
  pointer: Record<string, unknown>,
  onGet?: (key: string) => void,
) {
  return {
    METAGRAPH_CONTROL: {
      async get() {
        return pointer;
      },
    },
    METAGRAPH_ARCHIVE: {
      async get(key: string) {
        onGet?.(key);
        if (key !== pointer.full_manifest_run_key) return null;
        if (manifest === null) return null;
        return {
          async json() {
            return manifest;
          },
        };
      },
    },
  } as unknown as Env;
}

const RUN_MANIFEST_KEY = "runs/2026-07-26T12-00-00-000Z/r2-manifest.json";
const RUN_MANIFEST = {
  artifacts: [
    { path: "/metagraph/subnets.json", key: "by-hash/aaa111" },
    { path: "/metagraph/coverage.json", key: "by-hash/bbb222" },
  ],
};

test("#8277 latestR2Key resolves through the run manifest to the immutable by-hash key", async () => {
  const { latestR2Key: resolve } = await import("../workers/storage.ts");
  const env = manifestEnv(RUN_MANIFEST, {
    latest_prefix: "latest/",
    full_manifest_run_key: RUN_MANIFEST_KEY,
  });
  assert.equal(await resolve("/metagraph/subnets.json", env), "by-hash/aaa111");
  assert.equal(
    await resolve("/metagraph/coverage.json", env),
    "by-hash/bbb222",
  );
});

test("#8277 the run manifest is fetched once per isolate, not per artifact", async () => {
  vi.resetModules();
  const { latestR2Key: resolve } = await import("../workers/storage.ts");
  const fetched: string[] = [];
  const env = manifestEnv(
    RUN_MANIFEST,
    { latest_prefix: "latest/", full_manifest_run_key: RUN_MANIFEST_KEY },
    (key) => fetched.push(key),
  );
  await resolve("/metagraph/subnets.json", env);
  await resolve("/metagraph/coverage.json", env);
  await resolve("/metagraph/subnets.json", env);
  // Immutable per run, so it is memoized with no TTL -- three resolutions,
  // one ~585 KB read.
  assert.deepEqual(fetched, [RUN_MANIFEST_KEY]);
});

test("#8277 a path the manifest does not name falls back to the prefix", async () => {
  vi.resetModules();
  const { latestR2Key: resolve } = await import("../workers/storage.ts");
  const env = manifestEnv(RUN_MANIFEST, {
    latest_prefix: "latest/",
    full_manifest_run_key: RUN_MANIFEST_KEY,
  });
  assert.equal(
    await resolve("/metagraph/not-in-manifest.json", env),
    "latest/not-in-manifest.json",
  );
});

test("#8277 an unreadable manifest degrades to the prefix instead of 404ing", async () => {
  vi.resetModules();
  const { latestR2Key: resolve } = await import("../workers/storage.ts");
  const env = manifestEnv(null, {
    latest_prefix: "latest/",
    full_manifest_run_key: RUN_MANIFEST_KEY,
  });
  assert.equal(
    await resolve("/metagraph/subnets.json", env),
    "latest/subnets.json",
  );
});

test("#8277 a pointer with no manifest key behaves exactly as before", async () => {
  vi.resetModules();
  const { latestR2Key: resolve } = await import("../workers/storage.ts");
  const env = manifestEnv(RUN_MANIFEST, {
    latest_prefix: "runs/2026-07-17T11-21-50-971Z/",
  });
  assert.equal(
    await resolve("/metagraph/subnets.json", env),
    "runs/2026-07-17T11-21-50-971Z/subnets.json",
  );
});

test("#8277 stable-latest artifacts still bypass the manifest entirely", async () => {
  vi.resetModules();
  const { latestR2Key: resolve } = await import("../workers/storage.ts");
  const env = manifestEnv(
    {
      artifacts: [
        {
          path: "/metagraph/health/history/2026-07-01.json",
          key: "by-hash/ccc333",
        },
      ],
    },
    { latest_prefix: "latest/", full_manifest_run_key: RUN_MANIFEST_KEY },
  );
  // health/history is write-once per date and accumulates only under latest/;
  // routing it through a run manifest would lose every prior date.
  assert.equal(
    await resolve("/metagraph/health/history/2026-07-01.json", env),
    "latest/health/history/2026-07-01.json",
  );
});

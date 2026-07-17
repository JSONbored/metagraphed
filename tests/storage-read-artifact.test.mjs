import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { readArtifact, readAsset, readR2 } from "../workers/storage.mjs";

// A git/dual-tier artifact (not in any R2-only pattern) serves ASSETS-first,
// then falls back to R2. These tests drive that fallback chain and the
// no-binding guards in readAsset/readR2 directly.

const r2Object = (data) => ({
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

function assetsHit(data) {
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
  };
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
  };
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
  };
  const result = await readArtifact(env, "/metagraph/unknown-file.json");
  assert.equal(result.ok, false);
  // asset.status (500) !== 404, so the non-404 asset result wins.
  assert.equal(result.status, 500);
  assert.equal(result.code, "artifact_not_found");
});

test("readAsset returns asset_binding_missing when no ASSETS binding is configured (line 105)", async () => {
  const result = await readAsset({}, "/metagraph/unknown-file.json", "git");
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "asset_binding_missing");
  assert.match(result.message, /No ASSETS binding/);
});

test("readR2 returns r2_binding_missing when no archive binding is configured", async () => {
  const result = await readR2({}, "/metagraph/unknown-file.json", "git");
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.code, "r2_binding_missing");
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
  vi.doMock("../src/artifact-storage.mjs", async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, isR2PreferredDualArtifactPath: () => true };
  });
  const { readArtifact: read } = await import("../workers/storage.mjs");
  const env = {
    ASSETS: assetsHit({ from: "assets" }),
    METAGRAPH_ARCHIVE: {
      async get() {
        return r2Object({ from: "r2-fresh" });
      },
    },
  };
  const result = await read(env, "/metagraph/contracts.json");
  assert.equal(result.ok, true);
  assert.equal(result.source, "r2");
  assert.deepEqual(result.data, { from: "r2-fresh" });
  vi.doUnmock("../src/artifact-storage.mjs");
  vi.resetModules();
});

test("readArtifact falls back to the committed baseline when R2 is cold for an R2-preferred dual artifact", async () => {
  vi.resetModules();
  vi.doMock("../src/artifact-storage.mjs", async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, isR2PreferredDualArtifactPath: () => true };
  });
  const { readArtifact: read } = await import("../workers/storage.mjs");
  const env = {
    ASSETS: assetsHit({ from: "committed-baseline" }),
    METAGRAPH_ARCHIVE: {
      async get() {
        return null; // R2 cold → 404
      },
    },
  };
  const result = await read(env, "/metagraph/contracts.json");
  assert.equal(result.ok, true);
  assert.equal(result.source, "static-assets");
  assert.deepEqual(result.data, { from: "committed-baseline" });
  vi.doUnmock("../src/artifact-storage.mjs");
  vi.resetModules();
});

test("readArtifact returns the non-404 R2 error over the asset 404 for an R2-preferred dual artifact", async () => {
  vi.resetModules();
  vi.doMock("../src/artifact-storage.mjs", async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, isR2PreferredDualArtifactPath: () => true };
  });
  const { readArtifact: read } = await import("../workers/storage.mjs");
  const env = {
    METAGRAPH_R2_TIMEOUT_MS: "5",
    ASSETS: assetsMiss(), // asset → 404
    METAGRAPH_ARCHIVE: {
      async get() {
        // never resolves → withTimeout rejects → r2 504
        return new Promise(() => {});
      },
    },
  };
  const result = await read(env, "/metagraph/contracts.json");
  assert.equal(result.ok, false);
  // r2Preferred.status (504) !== 404, so the R2 error wins the tiebreak.
  assert.equal(result.status, 504);
  assert.equal(result.code, "r2_timeout");
  vi.doUnmock("../src/artifact-storage.mjs");
  vi.resetModules();
});

// ---- Dated-archive artifacts read from a stable key (#6508) ----------------
// health/history/{date}.json is a growing per-day archive, not "current state"
// like most R2-only artifacts — reading it via the rotating runs/{timestamp}/
// pointer only ever resolves whichever run is current right now, so every
// earlier date became permanently unreachable once the pointer advanced past
// the run that wrote it. These drive readR2's stable-key branch directly: the
// R2 mock records the key it was actually queried with, proving a historical
// date resolves via latest/health/history/{date}.json rather than the pointer.

test("readR2 reads a dated health-history artifact from its stable latest/ key, bypassing the run pointer", async () => {
  const requestedKeys = [];
  const env = {
    METAGRAPH_CONTROL: {
      // If readR2 consulted the pointer for this path, it would resolve to
      // today's run prefix — which never contains a historical date's file.
      get: async () => ({ latest_prefix: "runs/2026-07-17T11-21-50-971Z/" }),
    },
    METAGRAPH_ARCHIVE: {
      async get(key) {
        requestedKeys.push(key);
        return key === "latest/health/history/2026-06-01.json"
          ? r2Object({ date: "2026-06-01", surfaces: [] })
          : null;
      },
    },
  };
  const result = await readR2(
    env,
    "/metagraph/health/history/2026-06-01.json",
    "r2",
  );
  assert.equal(result.ok, true);
  assert.deepEqual(requestedKeys, ["latest/health/history/2026-06-01.json"]);
  assert.equal(result.data.date, "2026-06-01");
});

test("readR2 still uses the rotating run-prefix pointer for non-dated-archive R2-only artifacts", async () => {
  const requestedKeys = [];
  const env = {
    METAGRAPH_CONTROL: {
      get: async () => ({ latest_prefix: "runs/2026-07-17T11-21-50-971Z/" }),
    },
    METAGRAPH_ARCHIVE: {
      async get(key) {
        requestedKeys.push(key);
        return r2Object({ from: "run-prefixed" });
      },
    },
  };
  const result = await readR2(env, "/metagraph/subnets.json", "r2");
  assert.equal(result.ok, true);
  assert.deepEqual(requestedKeys, [
    "runs/2026-07-17T11-21-50-971Z/subnets.json",
  ]);
});

test("readArtifact resolves a health-history date other than today via the stable key end-to-end", async () => {
  const env = {
    METAGRAPH_CONTROL: {
      get: async () => ({ latest_prefix: "runs/2026-07-17T11-21-50-971Z/" }),
    },
    METAGRAPH_ARCHIVE: {
      async get(key) {
        // Only the stable key for yesterday's date resolves — the run-prefixed
        // key a naive pointer-based read would ask for never exists for a
        // date other than the run that wrote it.
        return key === "latest/health/history/2026-07-16.json"
          ? r2Object({ date: "2026-07-16", surfaces: [] })
          : null;
      },
    },
  };
  const result = await readArtifact(
    env,
    "/metagraph/health/history/2026-07-16.json",
  );
  assert.equal(result.ok, true);
  assert.equal(result.data.date, "2026-07-16");
});

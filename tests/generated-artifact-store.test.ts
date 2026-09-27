import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test, vi } from "vitest";
import { generatedArtifactStore } from "../src/generated-artifact-store.ts";
import { readGeneratedStoreJson } from "../scripts/r2-rest.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("registry snapshots persist exact JSON through insert, overwrite and reopen", async () => {
  const sql = new DatabaseSync(":memory:");
  try {
    sql.exec(
      readFileSync(
        new URL(
          "../migrations/d1/0027_generated_artifacts.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const db = {
      prepare(text: string) {
        return {
          bind(...values: string[]) {
            return {
              async first() {
                return sql.prepare(text).get(...values) ?? null;
              },
            };
          },
        };
      },
    } as unknown as Pick<D1Database, "prepare">;
    const store = generatedArtifactStore(db)!;
    const key = "generated/github-signals.json",
      first = { signals: [{ name: "界", count: "18446744073709551615" }] };
    assert.equal(await store.get(key), null);
    await store.put(key, JSON.stringify(first));
    assert.deepEqual(await generatedArtifactStore(db)!.get(key), first);
    const next = { ...first, generated_at: "2026-09-27T00:00:00Z" };
    await store.put(key, JSON.stringify(next));
    assert.deepEqual(await store.get(key), next);
    assert.equal(
      sql.prepare("SELECT COUNT(*) AS n FROM generated_artifacts").get()!.n,
      1,
    );
    for (const invalid of ["{", "null", "[]", "1"]) {
      await assert.rejects(store.put(key, invalid));
      assert.deepEqual(await store.get(key), next);
    }
    sql.exec("DROP TABLE generated_artifacts");
    assert.equal(await store.get(key), null);
    await assert.rejects(store.put(key, "{}"));
  } finally {
    sql.close();
  }
});

test("missing bindings and failed acknowledgements never report a durable write", async () => {
  assert.equal(generatedArtifactStore(), undefined);
  assert.equal(generatedArtifactStore({} as D1Database), undefined);
  for (const result of [null, { key: "another-key" }]) {
    const db = {
      prepare: () => ({ bind: () => ({ first: async () => result }) }),
    } as unknown as D1Database;
    await assert.rejects(
      generatedArtifactStore(db)!.put("expected", "{}"),
      /not acknowledged/,
    );
  }
  const broken = {
    prepare: () => ({
      bind: () => ({ first: async () => ({ payload: "{" }) }),
    }),
  } as unknown as D1Database;
  assert.equal(await generatedArtifactStore(broken)!.get("broken"), null);
});

test("build-side snapshot reader uses the same D1 key and preserves optional seed fallback", async () => {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "a".repeat(32));
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "fixture-token");
  vi.stubEnv(
    "CLOUDFLARE_D1_DATABASE_ID",
    "00000000-0000-0000-0000-000000000001",
  );
  const key = "generated/operational-surfaces.json",
    doc = { surfaces: [{ id: "retained" }] };
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    assert.ok(
      url.endsWith("/d1/database/00000000-0000-0000-0000-000000000001/query"),
    );
    assert.deepEqual(JSON.parse(String(init.body)), {
      batch: [
        {
          sql: "SELECT payload FROM generated_artifacts WHERE key=?",
          params: [key],
        },
      ],
    });
    return Response.json({
      success: true,
      result: [{ success: true, results: [{ payload: JSON.stringify(doc) }] }],
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  assert.deepEqual(await readGeneratedStoreJson(key), doc);
  for (const payload of ["null", "[]", "invalid"]) {
    fetchMock.mockImplementationOnce(async () =>
      Response.json({
        success: true,
        result: [{ success: true, results: [{ payload }] }],
      }),
    );
    assert.equal(await readGeneratedStoreJson(key), null);
  }
  fetchMock.mockImplementationOnce(async () => {
    throw new Error("offline");
  });
  assert.equal(await readGeneratedStoreJson(key), null);
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
  const requests = fetchMock.mock.calls.length;
  assert.equal(await readGeneratedStoreJson(key), null);
  assert.equal(fetchMock.mock.calls.length, requests);
});

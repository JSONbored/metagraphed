import assert from "node:assert/strict";
import { test } from "vitest";
import { createPgGeneratedArtifactStore } from "../src/generated-artifact-pg.ts";
import { selectedGeneratedArtifactStore } from "../src/generated-artifact-store.ts";
import type { PgStoreRuntime } from "../src/pg-store-runtime.ts";

test("explicit native artifact selection takes precedence and rejects a broken capability", () => {
  for (const env of [undefined, null, 1, {}, { D1_STATE: {} }]) {
    assert.equal(selectedGeneratedArtifactStore(env), undefined);
  }
  const store = { get: async () => null, put: async () => {} };
  assert.equal(
    selectedGeneratedArtifactStore({
      GENERATED_ARTIFACT_STORE: store,
      D1_STATE: {
        prepare() {
          throw new Error("legacy store selected");
        },
      },
    }),
    store,
  );
  for (const selected of [null, {}, { get() {} }, { put() {} }]) {
    assert.throws(
      () =>
        selectedGeneratedArtifactStore({ GENERATED_ARTIFACT_STORE: selected }),
      /invalid/,
    );
  }
  const db = {
    prepare: () => ({
      bind: () => ({ first: async () => ({ payload: '{"legacy":true}' }) }),
    }),
  };
  return selectedGeneratedArtifactStore({ D1_STATE: db })!
    .get("key")
    .then((value) => {
      assert.deepEqual(value, { legacy: true });
    });
});

test("PostgreSQL artifact reads preserve missing and failed-read behavior", async () => {
  const answers: unknown[] = [
    null,
    { payload: '{"value":"λ"}' },
    { payload: "{" },
    new Error("offline"),
  ];
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  const runtime = {
    producer: {
      async first(text: string, values?: unknown[]) {
        calls.push({ text, values });
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  } as unknown as PgStoreRuntime;
  const store = createPgGeneratedArtifactStore(runtime);
  assert.equal(await store.get("missing"), null);
  assert.deepEqual(await store.get("found"), { value: "λ" });
  assert.equal(await store.get("broken-json"), null);
  assert.equal(await store.get("offline"), null);
  assert.ok(
    calls.every((call) => call.text.includes("app.generated_artifacts")),
  );
  assert.deepEqual(
    calls.map((call) => call.values),
    [["missing"], ["found"], ["broken-json"], ["offline"]],
  );
});

test("PostgreSQL artifact writes require the returned key and propagate failures", async () => {
  const answers: unknown[] = [
    { key: "key" },
    null,
    { key: "other" },
    new Error("offline"),
  ];
  const calls: { text: string; values: unknown[] | undefined }[] = [];
  const runtime = {
    producer: {
      async first(text: string, values?: unknown[]) {
        calls.push({ text, values });
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  } as unknown as PgStoreRuntime;
  const store = createPgGeneratedArtifactStore(runtime);
  await store.put("key", '{ "exact": 1.00 }');
  for (const message of [/not acknowledged/, /not acknowledged/, /offline/]) {
    await assert.rejects(store.put("key", "{}"), message);
  }
  assert.equal(calls[0].values?.[1], '{ "exact": 1.00 }');
  assert.match(String(calls[0].values?.[2]), /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(calls.every((call) => call.text.endsWith("RETURNING key")));
});

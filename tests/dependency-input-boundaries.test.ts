import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { test } from "vitest";

// Resolve from each consumer, so a patched hoisted copy cannot hide an older
// nested dependency. These are the framework readers used by the frontend.
const uiRequire = createRequire(
  new URL("../apps/ui/package.json", import.meta.url),
);

test("hoisted build and documentation peers resolve the UI framework", () => {
  const presetRequire = createRequire(
    uiRequire.resolve("@lovable.dev/vite-tanstack-config"),
  );
  const docsRequire = createRequire(
    uiRequire.resolve("fumadocs-ui/provider/tanstack"),
  );
  // A workspace-local copy is invisible to a hoisted peer consumer. Resolve
  // from the actual preset/provider, rather than checking only the root lock.
  assert.equal(
    presetRequire("@tanstack/react-start/package.json").version,
    uiRequire("@tanstack/react-start/package.json").version,
  );
  assert.equal(
    docsRequire("@tanstack/react-router/package.json").version,
    uiRequire("@tanstack/react-router/package.json").version,
  );
  // The preset dynamically imports an import-only export. Use native ESM
  // conditions from its directory; CommonJS resolve rejects this valid API.
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import { tanstackStart } from "@tanstack/react-start/plugin/vite"; if (typeof tanstackStart !== "function") throw new TypeError("Missing Start Vite plugin factory");',
    ],
    {
      cwd: dirname(uiRequire.resolve("@lovable.dev/vite-tanstack-config")),
      encoding: "utf8",
      timeout: 30_000,
    },
  );
});

interface SerovalReader {
  fromJSON(value: unknown): unknown;
  fromCrossJSON(
    value: unknown,
    options: { refs: Map<number, unknown> },
  ): unknown;
  toJSON(value: unknown): unknown;
  toCrossJSON(value: unknown): unknown;
  SerovalDeserializationError: new (cause: unknown) => Error;
  SerovalMalformedNodeError: new (node: unknown) => Error;
}

for (const consumer of ["start-server-core", "start-client-core"]) {
  const consumerRequire = createRequire(
    uiRequire.resolve(`@tanstack/${consumer}/package.json`),
  );
  const reader = consumerRequire("seroval") as SerovalReader;
  const malformedNode = (error: unknown): boolean =>
    error instanceof reader.SerovalDeserializationError &&
    error.cause instanceof reader.SerovalMalformedNodeError;

  test(`${consumer}: Seroval rejects array-like objects as typed-array buffers`, () => {
    // Frozen Seroval wire shape: a Uint8Array whose backing node is a plain
    // {length: 3} object. Old readers silently used the array-like constructor.
    // Three elements suffice to prove the boundary; no large allocation runs.
    const node = {
      t: 15,
      i: 0,
      c: "Uint8Array",
      f: { t: 10, i: 1, p: { k: ["length"], v: [{ t: 0, s: 3 }] }, o: 0 },
      b: 0,
      l: 3,
    };
    assert.throws(
      () => reader.fromJSON({ t: node, f: 127, m: [] }),
      malformedNode,
    );
    assert.throws(
      () => reader.fromCrossJSON(node, { refs: new Map() }),
      malformedNode,
    );
  });

  test(`${consumer}: Seroval retains ordinary typed-array and object round trips`, () => {
    const bytes = new Uint8Array([1, 2, 3]);
    assert.deepEqual(reader.fromJSON(reader.toJSON(bytes)), bytes);
    const object = { count: 7, label: "TAO" };
    assert.deepEqual(
      reader.fromCrossJSON(reader.toCrossJSON(object), { refs: new Map() }),
      object,
    );
  });
}

interface SourceMapReader {
  SourceMapConsumer: new (map: unknown) => {
    originalPositionFor(position: { line: number; column: number }): unknown;
  };
}

const cssRequire = createRequire(uiRequire.resolve("postcss/package.json"));
const { SourceMapConsumer } = cssRequire("source-map-js") as SourceMapReader;
const flatMap = {
  version: 3,
  sources: ["input.ts"],
  names: [],
  mappings: "AAAA",
};

test("PostCSS's source-map reader rejects amplifying indexed offsets at construction", () => {
  // Only construct consumers. Never flatten/expand these numeric offsets.
  assert.throws(
    () =>
      new SourceMapConsumer({
        version: 3,
        sections: [{ offset: { line: 10_000_001, column: 0 }, map: flatMap }],
      }),
  );
  assert.throws(
    () =>
      new SourceMapConsumer({
        version: 3,
        sections: [
          {
            offset: { line: 6_000_000, column: 0 },
            map: {
              version: 3,
              sections: [
                { offset: { line: 6_000_000, column: 0 }, map: flatMap },
              ],
            },
          },
        ],
      }),
  );
});

test("PostCSS's source-map reader retains ordinary mappings", () => {
  const consumer = new SourceMapConsumer(flatMap);
  assert.deepEqual(consumer.originalPositionFor({ line: 1, column: 0 }), {
    source: "input.ts",
    line: 1,
    column: 0,
    name: null,
  });
});

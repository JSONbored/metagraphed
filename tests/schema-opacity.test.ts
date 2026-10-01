import assert from "node:assert/strict";
import { test } from "vitest";
import { z } from "zod";
import { openSites } from "../scripts/lib/schema-opacity.ts";
import { RootBasketsArtifactSchema } from "../schemas-src/routes/root-baskets.ts";

const typed = {
  type: "object",
  properties: { status: { const: "available" } },
  additionalProperties: false,
};
const record = { type: "object", additionalProperties: { type: "string" } };

test("the fully typed Root basket status union is transparent to the opacity audit", () => {
  assert.deepEqual(
    openSites(z.toJSONSchema(RootBasketsArtifactSchema), "RootBasketsArtifact"),
    [],
  );
});

test("object union alternatives may declare properties or typed record values", () => {
  for (const keyword of ["oneOf", "anyOf"]) {
    assert.deepEqual(
      openSites({ type: "object", [keyword]: [typed, record] }, "Tool"),
      [],
    );
  }
});

test("untyped, absent and non-object alternatives cannot hide an open object", () => {
  for (const keyword of ["oneOf", "anyOf"]) {
    for (const alternatives of [
      [],
      [typed, {}],
      [typed, { type: "object" }],
      [typed, { type: "object", additionalProperties: true }],
      [typed, { type: "null" }],
      [typed, null],
      [typed, []],
    ]) {
      assert.deepEqual(
        openSites({ type: "object", [keyword]: alternatives }, "Tool"),
        ["Tool"],
      );
    }
  }
});

test("typed union parents still audit opaque nested objects, arrays and records", () => {
  const branch = {
    type: "object",
    properties: {
      payload: { type: "object" },
      rows: { type: "array", items: { type: "object" } },
      map: { type: "object", additionalProperties: { type: "object" } },
    },
  };
  assert.deepEqual(
    openSites({ type: "object", oneOf: [typed, branch] }, "Tool"),
    ["Tool.payload", "Tool.rows[]", "Tool.map{}"],
  );
});

test("annotations and repeated alternatives preserve the existing audit paths", () => {
  assert.deepEqual(
    openSites(
      {
        ...typed,
        examples: [{ type: "object" }],
        enum: [{ type: "object" }],
      },
      "Tool",
    ),
    [],
  );
  assert.deepEqual(
    openSites({ anyOf: [{ type: "object" }, { type: "object" }] }, "Tool"),
    ["Tool"],
  );
  assert.deepEqual(openSites({ type: "object", allOf: [typed] }, "Tool"), [
    "Tool",
  ]);
});

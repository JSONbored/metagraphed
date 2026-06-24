import assert from "node:assert/strict";
import { describe, test } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { sampleFromSchema } from "../src/openapi-sample.mjs";

const components = {
  Level: { enum: ["native", "verified"] },
  Inner: {
    type: "object",
    required: ["x"],
    properties: { x: { type: "integer" } },
  },
};
const s = (schema, name) => sampleFromSchema(schema, components, name);

describe("sampleFromSchema", () => {
  test("const + enum (prefers a non-null enum value)", () => {
    assert.equal(s({ const: true }), true);
    assert.equal(s({ const: 1 }), 1);
    assert.equal(s({ enum: ["a", "b"] }), "a");
    assert.equal(s({ enum: [null, "z"] }), "z");
  });

  test("$ref resolves against components", () => {
    assert.equal(s({ $ref: "#/components/schemas/Level" }), "native");
    assert.deepEqual(s({ $ref: "#/components/schemas/Inner" }), { x: 1 });
  });

  test("allOf merges object members (later wins)", () => {
    const out = s({
      allOf: [
        {
          type: "object",
          required: ["a"],
          properties: { a: { type: "string" } },
        },
        {
          type: "object",
          required: ["n"],
          properties: { n: { type: "integer" } },
        },
      ],
    });
    assert.equal(out.a, "example");
    assert.equal(out.n, 1);
  });

  test("oneOf/anyOf pick the first non-null variant", () => {
    assert.equal(
      s({ oneOf: [{ type: "null" }, { type: "string" }] }),
      "example",
    );
    assert.equal(s({ anyOf: [{ type: "null" }, { const: 5 }] }), 5);
    // all-null variants -> falls back to the first variant -> null
    assert.equal(s({ oneOf: [{ type: "null" }, { type: "null" }] }), null);
  });

  test("allOf with only a null member yields an empty object", () => {
    assert.deepEqual(s({ allOf: [{ type: "null" }] }), {});
  });

  test("objects include required + optional scalars at shallow depth", () => {
    const out = s({
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        extra: { type: "boolean" },
      },
    });
    assert.equal(out.id, "example");
    assert.equal("extra" in out, true);
  });

  test("arrays emit a single sampled item", () => {
    assert.deepEqual(s({ type: "array", items: { type: "string" } }), [
      "example",
    ]);
    // array without items -> samples the empty schema (null) as the lone item
    assert.deepEqual(s({ type: "array" }), [null]);
  });

  test("string seeds cover the field-name dictionary", () => {
    const cases = {
      day: "2026-06-01",
      window: "30d",
      slug: "example-subnet",
      provider: "example-provider",
      content_hash: "a3f1".repeat(16),
      health_source: "probe-derived",
      source: "live-cron-prober",
      status: "ok",
      grade: "A",
      method: "GET",
      surface_id: "example",
      unmatched_field: "example",
    };
    for (const [name, expected] of Object.entries(cases)) {
      assert.equal(s({ type: "string" }, name), expected);
    }
  });

  test("string format awareness (uri, date-time)", () => {
    assert.match(s({ type: "string", format: "uri" }), /^https:\/\//);
    assert.equal(
      s({ type: "string", format: "date-time" }),
      "2026-06-01T00:00:00.000Z",
    );
  });

  test("string pattern awareness", () => {
    assert.match(
      s({ type: "string", pattern: "^[a-f0-9]{64}$" }),
      /^[a-f0-9]{64}$/,
    );
    assert.equal(
      s({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
      "2026-06-01",
    );
    assert.match(
      s({ type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" }),
      /^[a-z0-9][a-z0-9-]*$/,
    );
    assert.match(
      s({ type: "string", pattern: "^/metagraph/" }),
      /^\/metagraph\//,
    );
    assert.match(s({ type: "string", pattern: "^/api/v1" }), /^\/api\/v1/);
    assert.match(
      s({ type: "string", pattern: "^#/components/schemas/[A-Za-z0-9]+$" }),
      /^#\/components\/schemas\//,
    );
    assert.equal(s({ type: "string", pattern: "^something-else$" }), "example");
  });

  test("number seeds by field name + clamps to min/max", () => {
    assert.equal(s({ type: "integer" }, "netuid"), 7);
    assert.equal(s({ type: "integer" }, "surface_count"), 1);
    assert.equal(s({ type: "integer" }, "score"), 100);
    assert.equal(s({ type: "integer" }, "latency_ms"), 120);
    assert.equal(
      s({ type: "number", minimum: 0, maximum: 1 }, "uptime_ratio"),
      0.9966,
    );
    // integer type expressed as a nullable union still rounds to an int
    assert.equal(s({ type: ["integer", "null"] }, "samples"), 1);
    // generic number defaults to 0.5; integer defaults to 1; unnamed -> 0.5
    assert.equal(s({ type: "number" }, "whatever"), 0.5);
    assert.equal(s({ type: "integer" }, "whatever"), 1);
    assert.equal(s({ type: "number" }), 0.5);
    // clamp upward to minimum
    assert.equal(s({ type: "integer", minimum: 50 }, "whatever"), 50);
  });

  test("boolean seeds true for affirmative field names, else false", () => {
    assert.equal(s({ type: "boolean" }, "enabled"), true);
    assert.equal(s({ type: "boolean" }, "public_safe"), true);
    assert.equal(s({ type: "boolean" }, "archive_support"), false);
    // unnamed boolean (name defaults to "") -> false
    assert.equal(s({ type: "boolean" }), false);
  });

  test("nullable type arrays pick the non-null type; explicit null -> null", () => {
    assert.equal(typeof s({ type: ["string", "null"] }, "name"), "string");
    assert.equal(s({ type: "null" }), null);
    assert.equal(s(null), null);
    assert.equal(s({}), null);
    // all-null type array + all-null enum exercise the fallback arms
    assert.equal(s({ type: ["null"] }), null);
    assert.equal(s({ enum: [null] }), null);
  });

  test("pure map objects (additionalProperties schema) show one entry", () => {
    const out = s({
      type: "object",
      additionalProperties: { type: "integer" },
    });
    assert.equal(out.example, 1);
  });

  test("covers remaining seed/clamp/allOf-scalar branches", () => {
    // name-based string seeds (no format): url-ish -> https, timestamp -> ISO
    assert.match(s({ type: "string" }, "url"), /^https:\/\//);
    assert.equal(
      s({ type: "string" }, "last_checked"),
      "2026-06-01T00:00:00.000Z",
    );
    // description/summary-style string fields
    assert.equal(s({ type: "string" }, "description"), "Example description.");
    assert.equal(s({ type: "string" }, "summary"), "Example description.");
    assert.equal(s({ type: "string" }, "version"), "2026-06-06.1");
    // clamp DOWN to maximum (block seeds high, capped here)
    assert.equal(s({ type: "integer", maximum: 3 }, "block"), 3);
    // allOf whose only member is a scalar -> returns that scalar
    assert.equal(s({ allOf: [{ const: "x" }] }), "x");
    assert.equal(s({ allOf: [{ type: "string" }] }), "example");
  });

  test("bounds recursion: deep objects drop optionals, deep arrays bottom out", () => {
    // Nest optional objects past OPTIONAL_DEPTH -> deep optionals are dropped.
    let obj = { type: "string" };
    for (let i = 0; i < 6; i += 1) {
      obj = { type: "object", properties: { child: obj } };
    }
    const objOut = sampleFromSchema(obj, {}, "root");
    assert.equal(typeof objOut, "object");
    // child is included while depth < OPTIONAL_DEPTH (3), then dropped.
    assert.equal("child" in objOut.child.child, true);
    assert.deepEqual(objOut.child.child.child, {});

    // Nest arrays past MAX_DEPTH -> inner array bottoms out to [].
    let arr = { type: "string" };
    for (let i = 0; i < 10; i += 1) {
      arr = { type: "array", items: arr };
    }
    assert.equal(Array.isArray(sampleFromSchema(arr, {}, "root")), true);
  });

  test("bounds recursion: self-referential ($ref) schemas don't overflow", () => {
    // A linked-list / tree node whose self-reference is a REQUIRED property:
    // optional-depth dropping can't save us here, so the $ref depth budget must.
    const selfRef = {
      Node: {
        type: "object",
        required: ["value", "next"],
        properties: {
          value: { type: "integer" },
          next: { $ref: "#/components/schemas/Node" },
        },
      },
    };
    let out;
    assert.doesNotThrow(() => {
      out = sampleFromSchema(selfRef.Node, selfRef, "Node");
    });
    // Bottoms out at a finite depth rather than recursing until the stack overflows.
    assert.equal(typeof out, "object");
    assert.equal(out.value, 1);

    // An array-of-self schema is likewise bounded.
    const selfArr = {
      Tree: {
        type: "object",
        required: ["id", "children"],
        properties: {
          id: { type: "integer" },
          children: {
            type: "array",
            items: { $ref: "#/components/schemas/Tree" },
          },
        },
      },
    };
    assert.doesNotThrow(() => sampleFromSchema(selfArr.Tree, selfArr, "Tree"));
  });

  test("bounds recursion: self-refs routed through oneOf/anyOf/allOf don't overflow", () => {
    // A self-reference whose only hop is a composition keyword never grows
    // `depth`, so the MAX_DEPTH budget alone can't break it — the $ref must
    // also detect a non-advancing cycle.
    for (const kw of ["oneOf", "anyOf", "allOf"]) {
      const cyclic = {
        Node: { [kw]: [{ $ref: "#/components/schemas/Node" }] },
      };
      assert.doesNotThrow(
        () => sampleFromSchema(cyclic.Node, cyclic, "Node"),
        `${kw} self-ref should be bounded`,
      );
    }

    // Mutual recursion through composition keywords is likewise bounded.
    const mutual = {
      A: { oneOf: [{ $ref: "#/components/schemas/B" }] },
      B: { oneOf: [{ $ref: "#/components/schemas/A" }] },
    };
    assert.doesNotThrow(() => sampleFromSchema(mutual.A, mutual, "A"));
  });

  test("a sampled instance validates against its own schema (round-trip)", () => {
    const ajv = new Ajv2020({ strict: false, validateFormats: true });
    addFormats(ajv);
    const schema = {
      type: "object",
      required: ["netuid", "status", "uptime_ratio", "observed_at", "tags"],
      additionalProperties: false,
      properties: {
        netuid: { type: "integer", minimum: 0 },
        status: { enum: ["ok", "degraded"] },
        uptime_ratio: { type: "number", minimum: 0, maximum: 1 },
        observed_at: { type: "string", format: "date-time" },
        url: { type: "string", format: "uri" },
        slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*$" },
        tags: { type: "array", items: { type: "string" } },
      },
    };
    const sample = sampleFromSchema(schema, components, "root");
    assert.equal(ajv.validate(schema, sample), true, ajv.errorsText());
  });
});

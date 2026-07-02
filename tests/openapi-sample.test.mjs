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
      ss58: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      from: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
      counterparty: "5GrwvaEF5zXb26Fz9rcQpDWSLRtG5P9exNzGo5zYt7EGiJtQ",
      to: "5GrwvaEF5zXb26Fz9rcQpDWSLRtG5P9exNzGo5zYt7EGiJtQ",
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
    assert.match(s({ type: "string", pattern: "^\\d+\\.\\d+$" }), /^\d+\.\d+$/);
    assert.equal(
      s({ type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{47,48}$" }, "ss58"),
      "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
    );
    assert.equal(
      s(
        { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{47,48}$" },
        "counterparty",
      ),
      "5GrwvaEF5zXb26Fz9rcQpDWSLRtG5P9exNzGo5zYt7EGiJtQ",
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
    assert.equal(s({ type: "string" }, "version"), "2026-06-29.1");
    // clamp DOWN to maximum (block seeds high, capped here)
    assert.equal(s({ type: "integer", maximum: 3 }, "block"), 3);
    // allOf whose only member is a scalar -> returns that scalar
    assert.equal(s({ allOf: [{ const: "x" }] }), "x");
    assert.equal(s({ allOf: [{ type: "string" }] }), "example");
  });

  test("counterparty relationship samples keep totals consistent with evidence", () => {
    const ss58Pattern = "^[1-9A-HJ-NP-Za-km-z]{47,48}$";
    const relationshipSchema = {
      type: "object",
      required: [
        "schema_version",
        "ss58",
        "counterparty",
        "transfer_count",
        "transfers_scanned",
        "scan_capped",
        "total_sent_tao",
        "total_received_tao",
        "net_tao",
        "first_block",
        "last_block",
        "limit",
        "transfers",
      ],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string", pattern: ss58Pattern },
        counterparty: { type: "string", pattern: ss58Pattern },
        transfer_count: { type: "integer" },
        transfers_scanned: { type: "integer" },
        scan_capped: { type: "boolean" },
        total_sent_tao: { type: "number" },
        total_received_tao: { type: "number" },
        net_tao: { type: "number" },
        first_block: { type: ["integer", "null"] },
        last_block: { type: ["integer", "null"] },
        limit: { type: "integer" },
        transfers: {
          type: "array",
          items: {
            type: "object",
            required: ["from", "to", "amount_tao", "direction"],
            properties: {
              from: { type: "string", pattern: ss58Pattern },
              to: { type: "string", pattern: ss58Pattern },
              amount_tao: { type: "number" },
              direction: { enum: ["sent", "received"] },
            },
          },
        },
      },
    };
    const accountCounterpartiesSchema = {
      type: "object",
      required: [
        "schema_version",
        "ss58",
        "counterparty_count",
        "counterparties",
        "transfers_scanned",
        "scan_capped",
        "total_sent_tao",
        "total_received_tao",
        "relationship",
      ],
      properties: {
        schema_version: { type: "integer" },
        ss58: { type: "string", pattern: ss58Pattern },
        counterparty_count: { type: "integer" },
        counterparties: {
          type: "array",
          items: {
            type: "object",
            required: ["address"],
            properties: {
              address: { type: "string", pattern: ss58Pattern },
              sent_tao: { type: "number" },
              received_tao: { type: "number" },
              net_tao: { type: "number" },
              transfer_count: { type: "integer" },
              last_block: { type: ["integer", "null"] },
            },
          },
        },
        transfers_scanned: { type: "integer" },
        scan_capped: { type: "boolean" },
        total_sent_tao: { type: "number" },
        total_received_tao: { type: "number" },
        relationship: relationshipSchema,
      },
    };
    const sample = s(accountCounterpartiesSchema, "data");

    assert.equal(sample.relationship.transfers[0].direction, "sent");
    assert.equal(sample.relationship.total_sent_tao, 0.5);
    assert.equal(sample.relationship.total_received_tao, 0);
    assert.equal(sample.relationship.net_tao, -0.5);
    assert.equal(sample.total_sent_tao, 0.5);
    assert.equal(sample.total_received_tao, 0);
    assert.deepEqual(sample.counterparties, [
      {
        address: "5GrwvaEF5zXb26Fz9rcQpDWSLRtG5P9exNzGo5zYt7EGiJtQ",
        sent_tao: 0.5,
        received_tao: 0,
        net_tao: -0.5,
        transfer_count: 1,
        last_block: 5000000,
      },
    ]);

    const receivedRelationshipSchema = JSON.parse(
      JSON.stringify(relationshipSchema),
    );
    receivedRelationshipSchema.properties.transfers.items.properties.direction.enum =
      ["received", "sent"];
    const receivedSample = s(receivedRelationshipSchema, "relationship");
    assert.equal(receivedSample.transfers[0].direction, "received");
    assert.equal(receivedSample.total_sent_tao, 0);
    assert.equal(receivedSample.total_received_tao, 0.5);
    assert.equal(receivedSample.net_tao, 0.5);

    const badAmountRelationshipSchema = JSON.parse(
      JSON.stringify(relationshipSchema),
    );
    badAmountRelationshipSchema.properties.transfers.items.properties.amount_tao =
      { const: "bad" };
    const badAmountSample = s(badAmountRelationshipSchema, "relationship");
    assert.equal(badAmountSample.total_sent_tao, 0);
    assert.equal(badAmountSample.transfer_count, 1);

    const ignoredDirectionSchema = JSON.parse(
      JSON.stringify(relationshipSchema),
    );
    ignoredDirectionSchema.properties.transfers.items.properties.direction.enum =
      ["ignored"];
    const ignoredSample = s(ignoredDirectionSchema, "relationship");
    assert.equal(ignoredSample.transfer_count, 0);
    assert.equal(ignoredSample.total_sent_tao, 0);
    assert.equal(ignoredSample.total_received_tao, 0);

    const emptyAccountSchema = JSON.parse(
      JSON.stringify(accountCounterpartiesSchema),
    );
    emptyAccountSchema.properties.relationship.properties.transfers.items = {
      type: "null",
    };
    const emptySample = s(emptyAccountSchema, "data");
    assert.equal(emptySample.relationship.transfer_count, 0);
    assert.deepEqual(emptySample.counterparties, []);
  });

  test("chain transfer-volume samples keep the leaderboard consistent with the total", () => {
    const ss58Pattern = "^[1-9A-HJ-NP-Za-km-z]{47,48}$";
    const partySchema = {
      type: "object",
      required: ["address", "volume_tao", "transfer_count"],
      properties: {
        address: { type: "string", pattern: ss58Pattern },
        volume_tao: { type: "number" },
        transfer_count: { type: "integer" },
      },
    };
    const transfersSchema = {
      type: "object",
      required: [
        "schema_version",
        "window",
        "observed_at",
        "total_volume_tao",
        "transfer_count",
        "unique_senders",
        "unique_receivers",
        "top_sender_share",
        "top_senders",
        "top_receivers",
      ],
      properties: {
        schema_version: { type: "integer" },
        window: { type: "string" },
        observed_at: { type: "string", format: "date-time" },
        total_volume_tao: { type: "number" },
        transfer_count: { type: "integer" },
        unique_senders: { type: "integer" },
        unique_receivers: { type: "integer" },
        top_sender_share: { type: ["number", "null"] },
        top_senders: { type: "array", items: partySchema },
        top_receivers: { type: "array", items: partySchema },
      },
    };
    const sample = s(transfersSchema, "data");

    // The worked example is internally consistent: the two top senders' volume
    // sums to exactly the share of the total the endpoint reports.
    assert.equal(sample.total_volume_tao, 100);
    assert.equal(sample.top_sender_share, 0.8);
    assert.equal(sample.transfer_count, 12);
    assert.equal(sample.unique_senders, 5);
    assert.equal(sample.unique_receivers, 7);
    assert.deepEqual(sample.top_senders, [
      {
        address: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        volume_tao: 60,
        transfer_count: 3,
      },
      {
        address: "5GrwvaEF5zXb26Fz9rcQpDWSLRtG5P9exNzGo5zYt7EGiJtQ",
        volume_tao: 20,
        transfer_count: 2,
      },
    ]);
    assert.deepEqual(sample.top_receivers, [
      {
        address: "5GrwvaEF5zXb26Fz9rcQpDWSLRtG5P9exNzGo5zYt7EGiJtQ",
        volume_tao: 55,
        transfer_count: 4,
      },
      {
        address: "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5",
        volume_tao: 30,
        transfer_count: 2,
      },
    ]);
    const topSendersVolume = sample.top_senders.reduce(
      (sum, party) => sum + party.volume_tao,
      0,
    );
    assert.equal(
      topSendersVolume / sample.total_volume_tao,
      sample.top_sender_share,
    );

    // A shape missing one leaderboard array is not a transfers artifact and is
    // left untouched (guard branch).
    const notTransfersSchema = JSON.parse(JSON.stringify(transfersSchema));
    delete notTransfersSchema.properties.top_receivers;
    notTransfersSchema.required = notTransfersSchema.required.filter(
      (key) => key !== "top_receivers",
    );
    const untouched = s(notTransfersSchema, "data");
    assert.notEqual(untouched.total_volume_tao, 100);
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

  test("bounds recursion: composition-only self-referential schemas don't overflow", () => {
    for (const keyword of ["oneOf", "anyOf", "allOf"]) {
      const cyclic = {
        Node: {
          [keyword]: [{ $ref: "#/components/schemas/Node" }],
        },
      };
      assert.doesNotThrow(() => sampleFromSchema(cyclic.Node, cyclic, "Node"));
    }

    const oneOfOut = sampleFromSchema(
      { oneOf: [{ $ref: "#/components/schemas/Node" }] },
      { Node: { oneOf: [{ $ref: "#/components/schemas/Node" }] } },
      "Node",
    );
    assert.equal(oneOfOut, null);

    const mutual = {
      A: { oneOf: [{ $ref: "#/components/schemas/B" }] },
      B: { oneOf: [{ $ref: "#/components/schemas/A" }] },
    };
    let mutualOut;
    assert.doesNotThrow(() => {
      mutualOut = sampleFromSchema(mutual.A, mutual, "A");
    });
    assert.equal(mutualOut, null);
  });

  test("allOf can sample the same $ref twice when members are independent", () => {
    const out = s({
      allOf: [
        { $ref: "#/components/schemas/Inner" },
        { $ref: "#/components/schemas/Inner" },
      ],
    });
    assert.deepEqual(out, { x: 1 });
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

// #9082: the shared `fields=` projection, and the property that keeps the
// neuron routes' allowed set from ever needing maintenance.
//
// The interesting assertions here are the two resolvers DISAGREEING, because
// that disagreement is the whole reason the neuron routes resolve against a
// schema instead of against the rows in hand: a declared-but-conditionally-
// emitted field is projectable on every response, not only on the responses
// that happen to contain it.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  FIELD_NAME_PATTERN,
  parseFieldsParam,
  projectionMeta,
  projectRow,
  projectRows,
  unknownAgainstRows,
  unknownAgainstSchema,
} from "../src/field-projection.ts";
import { NeuronSchema } from "../schemas-src/routes/subnet-metagraph.ts";
import {
  parseNeuronFields,
  projectNeuronPayload,
} from "../src/metagraph-neurons.ts";
import { NEURON_FIELD_NAMES } from "../schemas-src/mcp-tools/shared.ts";

function params(search: string): URLSearchParams {
  return new URL(`https://api.metagraph.sh/x${search}`).searchParams;
}

const schemaResolver = unknownAgainstSchema(NeuronSchema);

describe("field-name pattern", () => {
  test("accepts identifiers and rejects anything path-like", () => {
    for (const ok of ["uid", "stake_tao", "_x", "a1"]) {
      assert.ok(FIELD_NAME_PATTERN.test(ok), ok);
    }
    for (const bad of ["a.b", "a-b", "a[0]", "1a", "a b", ""]) {
      assert.equal(FIELD_NAME_PATTERN.test(bad), false, bad);
    }
  });
});

describe("parseFieldsParam", () => {
  test("no fields param means no projection, not an empty one", () => {
    assert.deepEqual(parseFieldsParam(params(""), schemaResolver, "neurons"), {
      fields: null,
    });
  });

  test("parses, trims, and de-duplicates", () => {
    assert.deepEqual(
      parseFieldsParam(
        params("?fields=uid,%20hotkey%20,uid"),
        schemaResolver,
        "neurons",
      ).fields,
      ["uid", "hotkey"],
    );
  });

  test("an empty or malformed list is a parameter error", () => {
    for (const search of [
      "?fields=",
      "?fields=,,",
      "?fields=a.b",
      "?fields=1x",
    ]) {
      const result = parseFieldsParam(
        params(search),
        schemaResolver,
        "neurons",
      );
      assert.equal(result.error?.parameter, "fields", search);
      assert.match(result.error!.message, /comma-separated list/, search);
    }
  });

  // The message now also carries the VOCABULARY, for the same reason the
  // tool-argument guards do: naming only what the caller cannot have leaves it
  // with nothing to retry against. Two production examples this fixes, both
  // observed on live $mcp_tool_call events:
  //
  //   get_emission_pipeline  fields=...,name   correct refusal (those rows are
  //                                            pure chain state), but `name`
  //                                            lives on get_economics and the
  //                                            caller had no way to learn that
  //   get_economics          total_stake_tao   correct refusal -- the field is
  //                                            `total_stake_alpha`, one suffix
  //                                            away, and unlistable before now
  test("an unsupported field names itself, its collection, and the alternatives", () => {
    const result = parseFieldsParam(
      params("?fields=uid,stake"),
      schemaResolver,
      "neurons",
    );
    assert.match(
      result.error!.message,
      /^fields includes unsupported field for neurons: stake\./,
    );
    // Every field the schema declares, so the caller can correct in one step.
    for (const field of Object.keys(NeuronSchema.shape)) {
      assert.ok(
        result.error!.message.includes(field),
        `should offer \`${field}\`: ${result.error!.message}`,
      );
    }
  });

  test("several unsupported fields pluralize and list every one", () => {
    const result = parseFieldsParam(
      params("?fields=stake,nope"),
      schemaResolver,
      "validators",
    );
    assert.match(
      result.error!.message,
      /^fields includes unsupported fields for validators: stake, nope\./,
    );
    assert.match(result.error!.message, /Valid fields: /);
  });

  // The row-union resolver reaches the same message from a different place,
  // and is the one the emission-pipeline surface uses.
  test("the row-union resolver offers the union, not just the first row", () => {
    const result = parseFieldsParam(
      params("?fields=name"),
      unknownAgainstRows([{ netuid: 64 }, { emission_share: 0.06 }]),
      "emission pipeline subnets",
    );
    assert.match(
      result.error!.message,
      /^fields includes unsupported field for emission pipeline subnets: name\./,
    );
    // `emission_share` appears only on the SECOND row -- a message built from
    // the first row alone would omit it and mislead the retry.
    assert.match(
      result.error!.message,
      /Valid fields: emission_share, netuid\./,
    );
  });

  // The lazy scan is the reason `known` is a separate call. A VALID request
  // must still settle without materialising the union.
  test("a valid request never asks for the vocabulary", () => {
    let knownCalls = 0;
    const resolver = unknownAgainstRows([{ netuid: 64 }, { name: "apex" }]);
    const inner = resolver.known!;
    resolver.known = () => {
      knownCalls += 1;
      return inner();
    };

    const ok = parseFieldsParam(params("?fields=netuid"), resolver, "subnets");
    assert.deepEqual(ok.fields, ["netuid"]);
    assert.equal(knownCalls, 0, "the happy path must not build the union");

    parseFieldsParam(params("?fields=nope"), resolver, "subnets");
    assert.equal(knownCalls, 1, "the error path is where it is paid");
  });

  // The union walk's own non-object guard is covered under "the two resolvers"
  // below ("null, arrays and primitives contribute no field names"), against
  // the resolver directly rather than through this message.

  // A resolver with no `known` (nothing in-tree, but the type allows it)
  // degrades to the old message rather than emitting a dangling label.
  test("a resolver that cannot enumerate omits the list cleanly", () => {
    const bare = ((requested: string[]) =>
      requested.filter((f) => f !== "uid")) as typeof schemaResolver;
    const result = parseFieldsParam(params("?fields=nope"), bare, "things");
    assert.equal(
      result.error?.message,
      "fields includes unsupported field for things: nope.",
    );
  });
});

describe("the two resolvers", () => {
  const rows = [{ uid: 0, hotkey: "a" }, { coldkey: "b" }, null, [1]];

  test("row-union accepts any key present on any row", () => {
    const resolver = unknownAgainstRows(
      rows as Parameters<typeof unknownAgainstRows>[0],
    );
    assert.deepEqual(resolver(["uid", "coldkey"]), []);
    assert.deepEqual(resolver(["uid", "nope"]), ["nope"]);
  });

  test("row-union stops scanning once every field is resolved", () => {
    let touched = 0;
    const counted = new Proxy([{ uid: 0 }, { hotkey: "a" }], {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) touched += 1;
        return Reflect.get(target, prop, receiver);
      },
    });
    assert.deepEqual(
      unknownAgainstRows(counted as unknown as Record<string, unknown>[])([
        "uid",
      ]),
      [],
    );
    assert.equal(touched, 1);
  });

  // THE POINT OF THE SPLIT. immunity_expires_at_block is a declared Neuron
  // field emitted only while a neuron is inside its immunity window, so on a
  // response where nobody is, the row-union resolver calls it unsupported and
  // the schema resolver — correctly — does not.
  test("row-union rejects a declared field absent from these rows; the schema does not", () => {
    const noneInImmunity = [{ uid: 0, hotkey: "a", is_immunity_period: false }];
    assert.deepEqual(
      unknownAgainstRows(noneInImmunity)(["immunity_expires_at_block"]),
      ["immunity_expires_at_block"],
    );
    assert.deepEqual(schemaResolver(["immunity_expires_at_block"]), []);
  });
});

describe("projection", () => {
  test("projects only the fields the row actually has", () => {
    assert.deepEqual(
      projectRow({ uid: 1, hotkey: "a", trust: 2 }, ["uid", "trust"]),
      {
        uid: 1,
        trust: 2,
      },
    );
    // Absent stays absent rather than becoming null: a conditionally-present
    // field is missing for a reason.
    assert.deepEqual(projectRow({ uid: 1 }, ["uid", "trust"]), { uid: 1 });
  });

  test("passes through anything that is not a projectable object", () => {
    assert.equal(projectRow(null, ["uid"]), null);
    assert.deepEqual(projectRow([1, 2], ["uid"]), [1, 2]);
    assert.deepEqual(projectRow({ uid: 1 }, null), { uid: 1 });
    const rows = [{ uid: 1 }];
    assert.equal(projectRows(rows, null), rows);
    assert.deepEqual(projectRows([{ uid: 1, trust: 2 }], ["uid"]), [
      { uid: 1 },
    ]);
  });

  test("meta echoes the projection only when one ran", () => {
    assert.deepEqual(projectionMeta(null), {});
    assert.deepEqual(projectionMeta(["uid"]), {
      projection: { fields: ["uid"] },
    });
  });
});

describe("the neuron payload projector", () => {
  const metagraph = {
    schema_version: 1,
    netuid: 1,
    neuron_count: 2,
    neurons: [
      { uid: 0, hotkey: "a", trust: 0.5 },
      { uid: 1, hotkey: "b", trust: 0.25 },
    ],
  };

  test("narrows neurons and leaves the envelope alone", () => {
    assert.deepEqual(projectNeuronPayload(metagraph, ["uid"]), {
      schema_version: 1,
      netuid: 1,
      neuron_count: 2,
      neurons: [{ uid: 0 }, { uid: 1 }],
    });
  });

  test("narrows validators and a single neuron the same way", () => {
    assert.deepEqual(
      projectNeuronPayload(
        { netuid: 1, validators: [{ uid: 0, hotkey: "a" }] },
        ["hotkey"],
      ),
      { netuid: 1, validators: [{ hotkey: "a" }] },
    );
    assert.deepEqual(
      projectNeuronPayload({ netuid: 1, neuron: { uid: 0, hotkey: "a" } }, [
        "uid",
      ]),
      { netuid: 1, neuron: { uid: 0 } },
    );
  });

  test("a null neuron stays null rather than becoming an empty object", () => {
    // The UID is genuinely absent from the snapshot; {} would claim it exists
    // with no fields.
    assert.deepEqual(
      projectNeuronPayload({ netuid: 1, neuron: null }, ["uid"]),
      {
        netuid: 1,
        neuron: null,
      },
    );
  });

  test("no fields returns the payload untouched, by identity", () => {
    assert.equal(projectNeuronPayload(metagraph, null), metagraph);
    assert.equal(projectNeuronPayload(metagraph, undefined), metagraph);
  });

  test("parseNeuronFields resolves against NeuronSchema", () => {
    assert.deepEqual(
      parseNeuronFields(params("?fields=uid,immunity_expires_at"), "neurons")
        .fields,
      ["uid", "immunity_expires_at"],
    );
    assert.match(
      parseNeuronFields(params("?fields=stake"), "neurons").error!.message,
      /unsupported field for neurons: stake/,
    );
  });
});

describe("the published MCP enum is the schema's own field list (#9082)", () => {
  // Both directions. A name the tools advertise that the routes cannot project
  // would be a promise the API breaks; a projectable field the tools never
  // advertise is one an agent has no way to discover.
  test("advertised == projectable, in both directions", () => {
    assert.deepEqual(
      [...NEURON_FIELD_NAMES].sort(),
      Object.keys(NeuronSchema.shape).sort(),
    );
  });

  test("every advertised name is one the route resolver accepts", () => {
    assert.deepEqual(schemaResolver([...NEURON_FIELD_NAMES]), []);
  });
});

// A row set is not guaranteed to be rows (#10617).
//
// `unknownAgainstRows` is handed whatever a route already has in hand, and the
// error path calls `.known()` over ALL of it to name the valid fields. A JSON
// array whose entries are null, or nested arrays, reaches here unchanged --
// `Object.keys(null)` throws, and `Object.keys([1,2])` would offer "0" and "1"
// as field names. The guard exists for both; this is what proves it.
describe("unknownAgainstRows tolerates a row set that is not objects", () => {
  test("null, arrays and primitives contribute no field names", () => {
    const resolver = unknownAgainstRows([
      null,
      undefined,
      42,
      "a string",
      ["nested", "array"],
      { netuid: 64 },
    ] as never);
    // The one real object still resolves, so the scan is not simply skipped.
    assert.deepEqual(resolver.known!().sort(), ["netuid"]);
  });

  test("a row set with no objects at all yields an empty known set", () => {
    const resolver = unknownAgainstRows([null, [1, 2]] as never);
    assert.deepEqual(resolver.known!(), []);
  });
});

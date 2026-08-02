// #9082: the shared `?fields=` primitive. What matters here is the part that
// differs from what list-query.ts did on its own -- resolution against a
// DECLARED allowed set rather than the keys that happen to be on the rows.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  parseFieldsParam,
  projectRow,
  projectRows,
  resolveFieldProjection,
} from "../src/field-projection.ts";
import { NEURON_FIELD_NAMES } from "../schemas-src/routes/subnet-metagraph.ts";

const allowNeuron = (field: string) => NEURON_FIELD_NAMES.has(field);

describe("parseFieldsParam", () => {
  test("absent yields null (meaning: no projection), not an empty list", () => {
    // The distinction matters: null returns full rows, [] would return {}.
    assert.deepEqual(parseFieldsParam(null), { fields: null });
    assert.deepEqual(parseFieldsParam(undefined), { fields: null });
  });

  test("splits, trims, drops blanks, and de-duplicates", () => {
    assert.deepEqual(parseFieldsParam(" uid , hotkey ,, uid ").fields, [
      "uid",
      "hotkey",
    ]);
  });

  test("a non-identifier is a SYNTAX error, not an unsupported field", () => {
    // "uid;drop" could never be a key of any published row, so it is a
    // malformed request rather than a question about which fields exist.
    for (const raw of ["uid;drop", "1uid", "a-b", "", " , "]) {
      const result = parseFieldsParam(raw);
      assert.equal(
        result.error?.parameter,
        "fields",
        `for ${JSON.stringify(raw)}`,
      );
      assert.match(result.error!.message, /comma-separated list/);
    }
  });
});

describe("resolveFieldProjection", () => {
  test("accepts a SCHEMA-optional field no row happens to carry", () => {
    // The reason this primitive takes an allowed set at all. Row-union
    // resolution rejects immunity_expires_at_block on any subnet where no
    // neuron is currently inside its immunity window -- yet it is a perfectly
    // valid field of the published contract.
    assert.ok(NEURON_FIELD_NAMES.has("immunity_expires_at_block"));
    const resolved = resolveFieldProjection(
      ["uid", "immunity_expires_at_block"],
      allowNeuron,
      "neurons",
    );
    assert.equal(resolved.error, undefined);
    assert.deepEqual(resolved.fields, ["uid", "immunity_expires_at_block"]);
  });

  test("rejects an unknown field, naming it, and pluralises correctly", () => {
    const one = resolveFieldProjection(["uid", "nope"], allowNeuron, "neurons");
    assert.match(one.error!.message, /unsupported field for neurons: nope\./);
    const two = resolveFieldProjection(
      ["nope", "alsonope"],
      allowNeuron,
      "neurons",
    );
    assert.match(
      two.error!.message,
      /unsupported fields for neurons: nope, alsonope\./,
    );
  });

  test("the allowed set is derived from the schema, not hand-listed", () => {
    // Every field the neuron schema publishes is projectable. If someone adds
    // a field to NeuronSchema, it becomes projectable the same day -- there is
    // no second list to update, which is the property under test.
    for (const field of NEURON_FIELD_NAMES) {
      assert.equal(
        resolveFieldProjection([field], allowNeuron, "neurons").error,
        undefined,
        `${field} should be projectable`,
      );
    }
    assert.ok(NEURON_FIELD_NAMES.size >= 17);
  });
});

describe("projectRows / projectRow", () => {
  const rows = [
    { uid: 0, hotkey: "5A", stake_tao: 1, axon: null },
    { uid: 1, hotkey: "5B", stake_tao: 2, immunity_expires_at_block: 99 },
  ];

  test("narrows to the requested fields, preserving order and values", () => {
    assert.deepEqual(projectRows(rows, ["uid", "hotkey"]), [
      { uid: 0, hotkey: "5A" },
      { uid: 1, hotkey: "5B" },
    ]);
  });

  test("a field a row lacks is OMITTED from that row, never null", () => {
    // Matches the absent-not-null convention the row shapes use for optional
    // fields -- emitting null would assert "known to be nothing".
    const [first, second] = projectRows(rows, [
      "uid",
      "immunity_expires_at_block",
    ]) as Record<string, unknown>[];
    assert.deepEqual(first, { uid: 0 });
    assert.equal("immunity_expires_at_block" in first, false);
    assert.deepEqual(second, { uid: 1, immunity_expires_at_block: 99 });
  });

  test("a null field list returns the rows untouched, by identity", () => {
    assert.equal(projectRows(rows, null), rows);
    assert.equal(projectRows(rows, undefined), rows);
  });

  test("a null value is preserved, not dropped as missing", () => {
    // `axon: null` is a real published value; only an ABSENT key is omitted.
    assert.deepEqual(projectRows([rows[0]], ["uid", "axon"]), [
      { uid: 0, axon: null },
    ]);
  });

  test("projectRow keeps a null neuron null rather than making it {}", () => {
    // The cold-store shape for get_neuron / the neuron-detail route.
    assert.equal(projectRow(null, ["uid"]), null);
    assert.deepEqual(projectRow({ uid: 3, hotkey: "5C" }, ["uid"]), { uid: 3 });
  });
});

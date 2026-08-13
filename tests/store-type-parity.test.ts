// The Neon/lakehouse shape rule, tested without either snapshot (#11043).
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { compare } from "../scripts/validate-store-type-parity.ts";

const neon = (table: string, column: string, udt: string) => ({
  table,
  column,
  udt,
});
const lake = (table: string, column: string, type: string) => ({
  table,
  column,
  type,
});

describe("store-type parity", () => {
  test("WIDENING passes -- int4 fits in long, and loses nothing", () => {
    const r = compare([neon("t", "c", "int4")], [lake("t", "c", "long")]);
    assert.deepEqual(r.narrowed, []);
    assert.equal(r.compared, 1);
  });

  test("NARROWING fails -- int8 does not fit in int", () => {
    const r = compare([neon("t", "c", "int8")], [lake("t", "c", "int")]);
    assert.equal(r.narrowed.length, 1);
    assert.match(r.narrowed[0]!.detail, /may not fit/);
  });

  test("float8 -> float fails, float4 -> double passes", () => {
    // The direction is the whole rule, and this pair is why: the same two
    // types, opposite verdicts.
    assert.equal(
      compare([neon("t", "c", "float8")], [lake("t", "c", "float")]).narrowed
        .length,
      1,
    );
    assert.equal(
      compare([neon("t", "c", "float4")], [lake("t", "c", "double")]).narrowed
        .length,
      0,
    );
  });

  test("a column ABSENT from the lakehouse is a lossy archive, not a projection", () => {
    const r = compare(
      [neon("t", "c", "numeric")],
      [lake("t", "other", "double")],
    );
    assert.equal(r.dropped.length, 1);
    assert.match(r.dropped[0]!.detail, /ABSENT/);
  });

  test("a table in only ONE store is not a divergence", () => {
    // Neon carries 64 tables; the lakehouse archives a subset by design.
    const r = compare(
      [neon("neon_only", "c", "int4")],
      [lake("other", "c", "int")],
    );
    assert.deepEqual([...r.narrowed, ...r.dropped], []);
    assert.equal(r.compared, 0);
  });

  test("an UNMAPPED Neon type fails rather than passing quietly", () => {
    // "we have not decided how this is stored" is a different fact from
    // "it fits", and only one of them is safe to pass.
    const r = compare([neon("t", "c", "inet")], [lake("t", "c", "string")]);
    assert.equal(r.narrowed.length, 1);
    assert.match(r.narrowed[0]!.detail, /no declared lakehouse mapping/);
  });

  test("the real snapshots' six divergences are exactly the known classes", () => {
    // Guards the guard: a rule that matched nothing would pass every test
    // above and still be useless against the data it exists for.
    const r = compare(
      [
        neon("neuron_daily", "take", "float8"),
        neon("subnet_hyperparams", "weights_version", "int8"),
        neon("nominator_positions", "shares", "numeric"),
      ],
      [
        lake("neuron_daily", "take", "float"),
        lake("subnet_hyperparams", "weights_version", "int"),
        lake("nominator_positions", "other", "double"),
      ],
    );
    assert.equal(r.narrowed.length, 2);
    assert.equal(r.dropped.length, 1);
  });
});

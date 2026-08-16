// The boundary that makes Pipelines' silent drop unreachable (#10850).
//
// Each case below is one the SPIKE actually measured against a real stream on
// 2026-08-16, where the ingest API answered HTTP 200 `{"success":true,
// "result":{"committed":1}}` and the row never arrived. The assertions are that
// our own boundary refuses what the stream would have accepted-and-discarded.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";

import {
  isSendable,
  streamSchemaFrom,
  validateStreamBatch,
} from "../src/pipeline-stream-contract.ts";

/** The spike's own schema, as a Zod source. */
const SpikeEvent = z
  .object({
    netuid: z.int().min(0),
    observed_at: z.int(),
    note: z.string().optional(),
  })
  .strict();

describe("the stream schema is DERIVED, so it cannot drift from the Zod one", () => {
  test("field names, types and requiredness come from the shape", () => {
    assert.deepEqual(streamSchemaFrom(SpikeEvent), {
      fields: [
        { name: "netuid", type: "int64", required: true },
        { name: "observed_at", type: "int64", required: true },
        { name: "note", type: "string", required: false },
      ],
    });
  });

  test("a bare number is float64, an int is int64, an int32 is int32", () => {
    // The distinction that matters: declaring `z.number()` an integer would
    // truncate every fractional value at the sink, with no error anywhere.
    const s = streamSchemaFrom(
      z.object({ ratio: z.number(), count: z.int(), small: z.int32() }),
    );
    assert.deepEqual(
      s.fields.map((f) => [f.name, f.type]),
      [
        ["ratio", "float64"],
        ["count", "int64"],
        ["small", "int32"],
      ],
    );
  });

  test("nullable is not required, exactly as optional is not", () => {
    // A stream has no null-vs-absent distinction, so a nullable field declared
    // required means every null row is dropped -- silently.
    const s = streamSchemaFrom(
      z.object({ a: z.string().nullable(), b: z.string().optional() }),
    );
    assert.deepEqual(
      s.fields.map((f) => f.required),
      [false, false],
    );
  });

  test("strings and bools map", () => {
    const s = streamSchemaFrom(z.object({ s: z.string(), b: z.boolean() }));
    assert.deepEqual(
      s.fields.map((f) => f.type),
      ["string", "bool"],
    );
  });

  test("a BIGINT refuses, rather than being guessed into int64", () => {
    // Zod cannot express bigint in JSON Schema and emits `{}` for it. An
    // earlier draft of this module mapped it to int64 by hand -- which is a
    // guess, and the guess is unsafe: a bigint outside the int64 range would
    // be truncated at the sink with no error at the caller. Refusing makes the
    // author choose a representation the stream can actually carry.
    assert.throws(
      () => streamSchemaFrom(z.object({ big: z.bigint() })),
      /big has no representable JSON Schema type/,
    );
  });

  test("an anyOf of nothing BUT null has no type to carry, and says so", () => {
    // Reachable, not theoretical: `z.union([z.null(), z.null()])` emits
    // `anyOf: [{type:"null"},{type:"null"}]`. There is no non-null branch to
    // take a type from, so the field falls through to the same refusal as any
    // other unrepresentable type rather than defaulting to one.
    assert.throws(
      () =>
        streamSchemaFrom(z.object({ nothing: z.union([z.null(), z.null()]) })),
      /nothing has no representable JSON Schema type/,
    );
  });

  test("an UNMAPPED type throws rather than guessing", () => {
    // The whole reason this is a throw. A default would pick a Pipelines type
    // nobody chose, and the cost of choosing wrong is a row dropped at the
    // sink with a 200 at the caller.
    assert.throws(
      () => streamSchemaFrom(z.object({ when: z.date() })),
      /when has no representable JSON Schema type/,
    );
  });
});

describe("the cases the real stream accepted and then discarded", () => {
  test("a MISSING required field is refused here", () => {
    const batch = validateStreamBatch(SpikeEvent, [
      { observed_at: 1786882803000, note: "missing-required-netuid" },
    ]);
    assert.deepEqual(batch.accepted, []);
    assert.equal(batch.rejected.length, 1);
    assert.equal(batch.rejected[0]!.index, 0);
    assert.equal(batch.rejected[0]!.field, "netuid");
    assert.equal(isSendable(batch), false);
  });

  test("a TYPE MISMATCH is refused here", () => {
    const batch = validateStreamBatch(SpikeEvent, [
      { netuid: "not-an-int", observed_at: 1786882804000 },
    ]);
    assert.deepEqual(batch.accepted, []);
    assert.equal(batch.rejected[0]!.field, "netuid");
  });

  test("an UNKNOWN extra field is refused, because the sink STRIPS it", () => {
    // The nastiest of the three: the stream took this row, wrote it, and
    // dropped `surprise` with no error in any channel. The row looks fine
    // afterwards, so nothing downstream can notice. `.strict()` is what makes
    // that a caller-side error instead.
    const batch = validateStreamBatch(SpikeEvent, [
      { netuid: 4, observed_at: 1786882805000, surprise: "hello" },
    ]);
    assert.deepEqual(batch.accepted, []);
    assert.match(batch.rejected[0]!.message, /unrecognized|unknown/i);
  });

  test("valid rows pass through unchanged, so this is not just refusing everything", () => {
    // Non-vacuity. A boundary that rejected every batch would satisfy every
    // assertion above and be useless.
    const rows = [
      { netuid: 1, observed_at: 1786882800000, note: "seq-1" },
      { netuid: 2, observed_at: 1786882801000, note: "seq-2" },
    ];
    const batch = validateStreamBatch(SpikeEvent, rows);
    assert.deepEqual(batch.accepted, rows);
    assert.deepEqual(batch.rejected, []);
    assert.equal(isSendable(batch), true);
  });
});

describe("a bad row costs its own row and no others", () => {
  test("the good rows survive and the bad one is named by INDEX", () => {
    // Same reasoning as the staleness heartbeat isolating each lane: one
    // malformed row in a 30,000-row pass must not cost the other 29,999. But
    // it is reported, not swallowed -- which is the entire difference from
    // what the stream does.
    const batch = validateStreamBatch(SpikeEvent, [
      { netuid: 1, observed_at: 1 },
      { netuid: "bad", observed_at: 2 },
      { netuid: 3, observed_at: 3 },
    ]);
    assert.deepEqual(
      batch.accepted.map((r) => r.netuid),
      [1, 3],
    );
    assert.equal(batch.rejected.length, 1);
    assert.equal(batch.rejected[0]!.index, 1);
    assert.equal(isSendable(batch), false);
  });

  test("an empty batch is sendable and accepts nothing", () => {
    const batch = validateStreamBatch(SpikeEvent, []);
    assert.deepEqual(batch, { accepted: [], rejected: [] });
    assert.equal(isSendable(batch), true);
  });

  test("a whole-object failure still reports a row", () => {
    // `null` fails the object itself rather than a field, so `issue.path` is
    // empty. It must still produce a rejection with a usable index, or a batch
    // of nulls would read as "nothing to send".
    const batch = validateStreamBatch(SpikeEvent, [null]);
    assert.equal(batch.rejected.length, 1);
    assert.equal(batch.rejected[0]!.index, 0);
    assert.equal(batch.rejected[0]!.field, "");
  });
});

// The walk that made the `.passthrough()` flip safe (#10790).
//
// `report-undeclared-fields.ts` compares every built artifact against the
// component it is served under and reports what the payload carries that the
// schema does not. It is the measurement the migration rested on -- 2,363
// artifacts, 174,050 objects -- so it has to be shown finding a field, not just
// reporting zero.
//
// It also has to be shown telling the two KINDS apart, because they need
// opposite responses:
//
//   a violation  a `.strict()` schema whose payload carries an extra key. That
//                artifact fails its own contract and would be rejected at the
//                response tripwire. Empty is the only acceptable count.
//   a finding    a silent schema (bare object, or the `.passthrough()` this
//                issue removed) doing the same. Served, undescribed, and
//                nothing says so -- the `SubnetUptime.observed_at` class.
//
// The first cut of this report skipped `.strict()` keys as unreachable. That
// was true before the flip and dangerously false after it, which is why the
// two are counted separately now and why both are asserted here.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";
import {
  findUndeclared,
  type UndeclaredField,
} from "../scripts/report-undeclared-fields.ts";

function walk(schema: z.ZodType, value: unknown) {
  const found = new Map<string, UndeclaredField>();
  const violations = new Map<string, UndeclaredField>();
  const counters = { objects: 0, declaredOpen: 0 };
  findUndeclared(schema, value, "Artifact", "artifact.json", found, violations, counters);
  return {
    findings: [...found.values()],
    violations: [...violations.values()],
    ...counters,
  };
}

describe("findUndeclared", () => {
  test("a silent schema serving an undeclared key is a FINDING", () => {
    const schema = z.object({ declared: z.string() });
    const out = walk(schema, { declared: "a", observed_at: "2026-08-11" });
    assert.deepEqual(
      out.findings.map((f) => f.path),
      ["Artifact.observed_at"],
    );
    assert.deepEqual(out.violations, []);
    assert.equal(out.findings[0]!.sample, "2026-08-11");
  });

  test("a `.strict()` schema serving one is a VIOLATION, not a finding", () => {
    // Different pile, different response: this payload fails its own contract.
    const schema = z.object({ declared: z.string() }).strict();
    const out = walk(schema, { declared: "a", leaked: 1 });
    assert.deepEqual(
      out.violations.map((f) => f.path),
      ["Artifact.leaked"],
    );
    assert.deepEqual(out.findings, []);
  });

  test("a `.catchall()` schema serving one is NEITHER -- it said so", () => {
    const schema = z.object({ declared: z.string() }).catchall(z.unknown());
    const out = walk(schema, { declared: "a", whatever: 1 });
    assert.deepEqual(out.findings, []);
    assert.deepEqual(out.violations, []);
    assert.equal(out.declaredOpen, 1, "counted as a declared-open key");
  });

  test("a payload that matches its schema reports nothing", () => {
    // The negative case. Without it every assertion above would still pass
    // against a walk that reported every key it saw.
    const schema = z.object({ declared: z.string() }).strict();
    const out = walk(schema, { declared: "a" });
    assert.deepEqual(out.findings, []);
    assert.deepEqual(out.violations, []);
    assert.ok(out.objects >= 1, "it did compare an object");
  });

  test("it descends into arrays and nested objects", () => {
    const schema = z
      .object({ rows: z.array(z.object({ id: z.string() }).strict()) })
      .strict();
    const out = walk(schema, { rows: [{ id: "a" }, { id: "b", extra: 2 }] });
    assert.deepEqual(
      out.violations.map((f) => f.path),
      ["Artifact.rows[].extra"],
    );
  });

  test("it sees through `z.lazy`, which has no innerType", () => {
    // `ReviewQueueArtifact` sits behind one, and a walk that followed only
    // `innerType` stopped dead at every lazy component and reported it clean --
    // an omission `validate:schemas` caught instead.
    const inner = z.object({ id: z.string() }).strict();
    const schema = z.lazy(() => inner);
    const out = walk(schema, { id: "a", hidden: true });
    assert.deepEqual(
      out.violations.map((f) => f.path),
      ["Artifact.hidden"],
    );
  });

  test("it sees through optional/nullable wrappers", () => {
    const schema = z.object({ id: z.string() }).strict().nullable().optional();
    const out = walk(schema, { id: "a", hidden: true });
    assert.deepEqual(
      out.violations.map((f) => f.path),
      ["Artifact.hidden"],
    );
  });

  test("one key seen on many rows is ONE row, counted", () => {
    const schema = z.object({ rows: z.array(z.object({ id: z.string() })) });
    const out = walk(schema, {
      rows: [
        { id: "a", extra: 1 },
        { id: "b", extra: 2 },
        { id: "c", extra: 3 },
      ],
    });
    assert.equal(out.findings.length, 1);
    assert.equal(out.findings[0]!.seen, 3);
  });
});

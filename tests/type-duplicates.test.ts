// The census, and proof that it reports a duplicate rather than only ever
// reporting zero (#10784).
//
// `matchDuplicates` is driven with SYNTHETIC declarations here. Building the
// real `ts.Program` takes tens of seconds, and this epic has now met five gates
// that were green because they were looking at nothing -- so the matching rule
// is exercised directly, on data shaped to make it fail.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import {
  matchDuplicates,
  type Declared,
} from "../scripts/report-type-duplicates.ts";

function declared(
  name: string,
  signature: string,
  members: number,
  file = "src/example.ts",
): Declared {
  return { name, file, line: 1, signature, members };
}

describe("matchDuplicates", () => {
  test("a hand-written shape identical to a generated one is a duplicate", () => {
    const signature = "checks:number|component:string|day:string";
    const report = matchDuplicates(
      [declared("SelfHealthDailyRow", signature, 3)],
      [declared("SelfHealthDaily", signature, 3, "generated/db/types.ts")],
    );
    assert.equal(report.duplicates.length, 1);
    assert.equal(report.duplicates[0]!.hand.name, "SelfHealthDailyRow");
    assert.equal(report.duplicates[0]!.generated.name, "SelfHealthDaily");
    assert.deepEqual(report.coincidental, []);
  });

  test("a shape that differs by one member is NOT a duplicate", () => {
    // The point of the census is that a difference must be VISIBLE, not that it
    // must be zero. A type carrying a field the generated one lacks is a
    // finding for a human, not a rename.
    const report = matchDuplicates(
      [declared("Nearly", "a:string|b:number|extra:boolean", 3)],
      [declared("Generated", "a:string|b:number", 2, "generated/db/types.ts")],
    );
    assert.deepEqual(report.duplicates, []);
  });

  test("optionality is part of the shape", () => {
    // `{ a?: string }` and `{ a: string }` are different promises, and treating
    // them as one is how a producer comes to omit a field the schema requires.
    const report = matchDuplicates(
      [declared("Loose", "a?:string|b:number", 2)],
      [declared("Strict", "a:string|b:number", 2, "generated/db/types.ts")],
    );
    assert.deepEqual(report.duplicates, []);
  });

  test("a single-member match is counted apart, not as a duplicate", () => {
    const report = matchDuplicates(
      [declared("Local", "netuid:number", 1)],
      [declared("Generated", "netuid:number", 1, "generated/db/types.ts")],
    );
    assert.deepEqual(report.duplicates, []);
    assert.equal(report.coincidental.length, 1);
  });

  test("a hand-written shape with no counterpart is left alone", () => {
    // 949 of these remain and that is the correct answer. Deleting one to move
    // a number is how a census stops describing the tree.
    const report = matchDuplicates(
      [declared("OptionsBag", "onDone:() => void|retries:number", 2)],
      [declared("Generated", "a:string", 1, "generated/db/types.ts")],
    );
    assert.deepEqual(report.duplicates, []);
    assert.deepEqual(report.coincidental, []);
  });

  test("the FIRST generated match is the one reported, deterministically", () => {
    const signature = "a:string|b:number";
    const report = matchDuplicates(
      [declared("Hand", signature, 2)],
      [
        declared("FirstGenerated", signature, 2, "generated/db/types.ts"),
        declared("SecondGenerated", signature, 2, "generated/graphql/types.ts"),
      ],
    );
    assert.equal(report.duplicates.length, 1);
    assert.equal(report.duplicates[0]!.generated.name, "FirstGenerated");
  });
});

import { describe, test } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { ACCOUNT_BALANCES_COVERAGE_FLOOR_ROWS } from "../src/account-balances-staleness-watchdog.ts";
import { NEURONS_COVERAGE_FLOOR_NETUIDS } from "../src/neurons-staleness-watchdog.ts";
import { NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS } from "../src/nominator-positions-staleness-watchdog.ts";
import { VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS } from "../src/validator-nominator-counts-staleness-watchdog.ts";

// A FLOOR RESTATED IN PROSE GOES STALE ON THE NEXT RE-PIN (#11384).
//
// Each of these floors is `Math.round(EXPECTED * RATIO)`, and each carries a
// JSDoc that quotes the product for a human. Re-pinning the expectation updates
// the constant and leaves the prose, so the comment goes on describing a floor
// the code stopped computing. Found three times in one sweep on 2026-08-16:
//
//   nominator-positions        quoted ~18,934   computed 17,010
//   validator-nominator-counts quoted ~89,796   computed 17,238   (5.2x off)
//   account-balances           quoted ~244,800  computed 293,360  (understated)
//
// The 89,796 one is the reason this is a gate rather than a cleanup. Triaging a
// `partial` verdict means comparing the covered count against the floor, and a
// reader who takes the floor from the comment sees an 81% shortfall -- a scan
// that died mid-walk -- on a lane merely sitting on its floor.
//
// SCOPED TO THE JSDOC DIRECTLY ABOVE THE CONSTANT, deliberately. These files
// also carry legitimate historical prose ("At 306,000 the floor was 244,800"),
// which is correct as history and must not be rewritten. The authoritative
// restatement is the one attached to the declaration, and all three bugs were
// there.

const FLOORS = [
  {
    file: "src/nominator-positions-staleness-watchdog.ts",
    name: "NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS",
    value: NOMINATOR_POSITIONS_COVERAGE_FLOOR_COLDKEYS,
  },
  {
    file: "src/validator-nominator-counts-staleness-watchdog.ts",
    name: "VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS",
    value: VALIDATOR_NOMINATOR_COUNTS_COVERAGE_FLOOR_ROWS,
  },
  {
    file: "src/account-balances-staleness-watchdog.ts",
    name: "ACCOUNT_BALANCES_COVERAGE_FLOOR_ROWS",
    value: ACCOUNT_BALANCES_COVERAGE_FLOOR_ROWS,
  },
  {
    file: "src/neurons-staleness-watchdog.ts",
    name: "NEURONS_COVERAGE_FLOOR_NETUIDS",
    value: NEURONS_COVERAGE_FLOOR_NETUIDS,
  },
] as const;

/** The `/** ... *\/` block immediately preceding `export const <name>`. */
function docBlockAbove(source: string, name: string): string {
  const at = source.indexOf(`export const ${name}`);
  assert.ok(at > 0, `${name} is not declared where this test expects it`);
  const before = source.slice(0, at);
  const open = before.lastIndexOf("/**");
  const close = before.lastIndexOf("*/");
  // The block must be the LAST thing before the declaration: an unrelated
  // earlier block would make this read a comment about something else.
  assert.ok(
    open >= 0 && close > open && before.slice(close + 2).trim() === "",
    `${name} has no JSDoc block directly above it`,
  );
  return before.slice(open, close + 2);
}

/** Every integer in the block, tolerating `,` and `_` group separators. */
function quotedNumbers(block: string): number[] {
  return [...block.matchAll(/\b\d[\d,_]*\b/g)].map((m) =>
    Number(m[0].replace(/[,_]/g, "")),
  );
}

describe("a derived floor's own JSDoc must quote what the code computes", () => {
  for (const floor of FLOORS) {
    test(`${floor.name} states ${floor.value}`, () => {
      const source = readFileSync(
        new URL(`../${floor.file}`, import.meta.url),
        "utf8",
      );
      const block = docBlockAbove(source, floor.name);
      const numbers = quotedNumbers(block);

      // CONTAINMENT, not equality of every figure. These blocks legitimately
      // cite the value they REPLACED ("this read ~89,796 until 2026-08-16"),
      // and that history is worth keeping -- it is how the next reader learns
      // the failure mode. What must not happen is the block naming a floor and
      // never naming the current one, which is exactly what all three bugs did.
      //
      // Doubles as the positive control: a block with no figures at all cannot
      // contain the value, so deleting the number fails rather than passing
      // vacuously.
      assert.ok(
        numbers.includes(floor.value),
        `${floor.file}: the JSDoc above ${floor.name} never states ${floor.value}, ` +
          `which is what the code computes. It quotes ${JSON.stringify(numbers)}. ` +
          `Re-pinning the expectation changed the product and left the prose behind.`,
      );
    });
  }

  test("the extractor actually reads numbers out of a block", () => {
    // Guards the guard: a regex that silently matched nothing would make every
    // case above pass on an empty list.
    assert.deepEqual(
      quotedNumbers("/** floor is 17,010 or 17_010 or 103 */"),
      [17_010, 17_010, 103],
      "all three group-separator spellings read back as the same integer",
    );
    assert.deepEqual(quotedNumbers("/** prose with no figures at all */"), []);
  });
});

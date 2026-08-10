// The D1->Neon flags must say the SAME thing in every config that runs a
// gated path (#10084).
//
// `vars` in Wrangler are per-config. There is no inheritance between
// wrangler.jsonc and wrangler.data.jsonc, so a flag set in one is `undefined`
// in the other -- and every gate in this codebase is written to SKIP on
// undefined rather than throw, because skipping is right when a Worker
// genuinely has no Neon binding. That combination makes a missing flag silent.
//
// It has now cost two live defects:
//
//   * the chain_detail Neon prune never ran, and Neon was measured holding
//     1,499 blocks below D1's floor, growing without bound
//   * #10071's observation-family writer could not activate at all, so the
//     documented flip (adding the tables to NEON_SOLE_STORE_TABLES) would have
//     been a no-op while the flag claimed the migration had happened
//
// Both were invisible from the flag values alone: wrangler.data.jsonc looked
// correct, and it was -- the Worker reading it was not the Worker running the
// code.
//
// So this asserts agreement rather than presence. A flag that exists in both
// files with different values is the worse failure of the two: it makes the
// stores disagree about which one owns a table.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";

import {
  BLOCKS_HEAD_NEON_LANE,
  RAW_CAPTURE_STATE_NEON_LANE,
} from "../src/capture-state-neon-write.ts";
import { CHAIN_DETAIL_NEON_LANE } from "../src/chain-detail-neon-write.ts";
import {
  ACCOUNT_IDENTITY_NEON_LANE,
  SUBNET_HYPERPARAMS_NEON_LANE,
} from "../src/hyperparams-identity-neon-write.ts";
import { LEDGER_MIRROR_PLANS } from "../src/ledger-neon-write.ts";
import { NEURONS_NEON_LANE } from "../src/neurons-neon-write.ts";
import { NOMINATOR_POSITIONS_NEON_LANE } from "../src/nominator-positions-neon-write.ts";

/** Every config whose Worker reaches a Neon-flag gate. Hand-listed, because
 * "which Workers have gated paths" is the thing being asserted -- deriving it
 * from which files happen to contain the flags would make a config that
 * silently dropped them look like a config nobody asked about. */
// wrangler.registry.jsonc joined the list when the self-health probe moved
// there (#10194): it went from "runs no gated path" to running one, and the
// flags did not follow. The probe wrote nothing and could not even record why,
// because the verdict sink is gated on the same missing flag. A config becomes
// gated the moment any code path on it asks neonOwnsTable -- which is not
// visible from the config itself, and is why this list is checked rather than
// assumed.
const GATED_CONFIGS = [
  "wrangler.jsonc",
  "wrangler.data.jsonc",
  "wrangler.registry.jsonc",
] as const;

/** NEON_BACKFILL_LANES is gone (#10166) -- it named the tables the D1 -> Neon
 *  reconciler covered, and there is no reconciler. It is deliberately NOT left
 *  declared-and-empty: an empty flag reads as "no tables need this" rather than
 *  "this question no longer exists", and two prune gates had already inverted
 *  under exactly that ambiguity (#10152, #10164). */
const FLAGS = ["NEON_DUAL_WRITE_LANES", "NEON_SOLE_STORE_TABLES"] as const;

/** Read a flag as declared, tolerating the line break Prettier introduces
 * when a value is long enough to wrap. */
function declared(config: string, flag: string): string | null {
  const source = readFileSync(config, "utf8");
  return new RegExp(`"${flag}":\\s*"([^"]*)"`).exec(source)?.[1] ?? null;
}

describe("the Neon migration flags", () => {
  for (const flag of FLAGS) {
    test(`${flag} is declared in every config with a gated path`, () => {
      for (const config of GATED_CONFIGS) {
        assert.notEqual(
          declared(config, flag),
          null,
          `${config} declares no ${flag}; every gate reading it there answers "no" silently`,
        );
      }
    });

    test(`${flag} says the same thing in all of them`, () => {
      const [first, ...rest] = GATED_CONFIGS;
      const expected = declared(first, flag);
      for (const config of rest) {
        assert.equal(
          declared(config, flag),
          expected,
          `${flag} differs between ${first} and ${config} -- the two Workers ` +
            `would disagree about which store owns a table`,
        );
      }
    });
  }

  test("NEON_DUAL_WRITE_LANES names every lane that has a writer", () => {
    // AGREEMENT IS NOT COVERAGE, and this flag is the one where the difference
    // costs the most. Since D1 was deleted (#10179) the six *-neon-write.ts
    // modules are the ONLY writers for their tables, and each one early-returns
    // `{ attempted: false }` when its lane is absent from this flag. So a lane
    // dropped from the list is not a slower path or a fallback -- it is that
    // table's writes stopping, silently, with every config still agreeing and
    // every test above still passing.
    //
    // Derived from the lane constants the writers themselves export, so a new
    // producer cannot be added without this list forcing the decision. Hard-
    // coding the names here would assert the flag against a copy of itself.
    const writers = new Set<string>([
      BLOCKS_HEAD_NEON_LANE,
      RAW_CAPTURE_STATE_NEON_LANE,
      CHAIN_DETAIL_NEON_LANE,
      SUBNET_HYPERPARAMS_NEON_LANE,
      ACCOUNT_IDENTITY_NEON_LANE,
      NEURONS_NEON_LANE,
      NOMINATOR_POSITIONS_NEON_LANE,
      ...Object.keys(LEDGER_MIRROR_PLANS),
    ]);
    assert.ok(
      writers.size > 0,
      "the writer set is not empty -- otherwise vacuous",
    );

    for (const config of GATED_CONFIGS) {
      const value = declared(config, "NEON_DUAL_WRITE_LANES");
      assert.notEqual(
        value,
        null,
        `${config} declares no NEON_DUAL_WRITE_LANES`,
      );
      const enabled = new Set(
        value!
          .split(",")
          .map((lane) => lane.trim())
          .filter(Boolean),
      );
      const missing = [...writers].filter((lane) => !enabled.has(lane)).sort();
      assert.deepEqual(
        missing,
        [],
        `${config} omits these lanes, so their ONLY writer is off there`,
      );
      // The other direction catches a typo: a name in the flag matching no
      // writer is a lane someone believes is enabled and that nothing reads.
      const unknown = [...enabled].filter((lane) => !writers.has(lane)).sort();
      assert.deepEqual(
        unknown,
        [],
        `${config} names lanes no writer answers to -- a typo here reads as enabled`,
      );
    }
  });

  test("the flag list itself has not outgrown this test", () => {
    // A fifth flag added to the data config and not to this list would go
    // unchecked, which is the exact failure this file exists for.
    const source = readFileSync("wrangler.data.jsonc", "utf8");
    const found = new Set(
      [...source.matchAll(/"(NEON_[A-Z_]+)":/g)].map((m) => m[1]),
    );
    assert.deepEqual(
      [...found].sort(),
      [...FLAGS].sort(),
      "wrangler.data.jsonc declares a NEON_* flag this test does not compare",
    );
  });
});

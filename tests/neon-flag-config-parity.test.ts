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

/** Every config whose Worker reaches a Neon-flag gate. Hand-listed, because
 * "which Workers have gated paths" is the thing being asserted -- deriving it
 * from which files happen to contain the flags would make a config that
 * silently dropped them look like a config nobody asked about. */
const GATED_CONFIGS = ["wrangler.jsonc", "wrangler.data.jsonc"] as const;

const FLAGS = [
  "NEON_DUAL_WRITE_LANES",
  "NEON_READ_LANES",
  "NEON_BACKFILL_LANES",
  "NEON_SOLE_STORE_TABLES",
] as const;

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

  test("a table Neon SOLELY owns is never also reconciled", () => {
    // The same invariant tests/neon-backfill.test.ts pins for the data Worker,
    // asserted here against the copy this Worker reads -- a reconciler pointed
    // at a frozen D1 would copy it over live Neon rows.
    for (const config of GATED_CONFIGS) {
      const sole = new Set(
        (declared(config, "NEON_SOLE_STORE_TABLES") ?? "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      );
      const reconciled = (declared(config, "NEON_BACKFILL_LANES") ?? "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      for (const table of reconciled) {
        assert.equal(
          sole.has(table),
          false,
          `${config}: ${table} is sole-store AND reconciled`,
        );
      }
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

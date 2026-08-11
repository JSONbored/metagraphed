// Both directions between wrangler.data.jsonc's crons and the Worker that
// dispatches them (#10814).
//
// Every cron gate in this repo ran ONE direction: a constant exists, therefore
// assert it appears in the config. That can only catch a handler whose schedule
// was never declared. It cannot catch the reverse -- a declared schedule whose
// handler was deleted -- because the deleted handler exports no constant to
// start the assertion from. A test whose starting point disappears along with
// the bug passes hardest exactly when it should fail.
//
// Three expressions had been in that state since D1 was retired:
// "*/3 * * * *" (NEON_BACKFILL_CRON), "26 * * * *" (mirror-lag) and
// "38 * * * *" (D1<->Neon parity). All three producers were deleted; the
// expressions stayed, fell through to `{ skipped: true }`, and cost roughly 23
// no-op Worker invocations an hour with nothing reporting it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { DATA_API_CRON_LANES } from "../workers/data-api.ts";
import { TABLE_FRESHNESS_CRON, TAO_USD_INDEX_CRON } from "../workers/config.ts";
import { NEON_PRUNE_CRON } from "../src/neon-prune.ts";

const CONFIG = "wrangler.data.jsonc";

/**
 * The cron expressions declared in a wrangler config.
 *
 * Parsed rather than `JSON.parse`d because these files are JSONC -- comments
 * and trailing commas -- and the block is a flat array of string literals, so
 * lifting the quoted strings out of it is exact rather than approximate.
 */
function declaredCrons(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const block = /"crons"\s*:\s*\[([^\]]*)\]/.exec(source);
  assert.ok(
    block,
    `no "crons" array found in ${path} -- this test parses nothing`,
  );
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("wrangler.data.jsonc crons and their handlers", () => {
  test("the parse finds a non-trivial set, so the assertions below are real", () => {
    // Guards the regex, not the config: an empty match would make every
    // assertion in this file vacuously true.
    const declared = declaredCrons(CONFIG);
    assert.ok(
      declared.length >= 3,
      `only ${declared.length} cron(s) parsed out of ${CONFIG} -- the parse broke`,
    );
    assert.ok(Object.keys(DATA_API_CRON_LANES).length >= 3);
  });

  test("every DECLARED cron resolves to a handled lane", () => {
    // THE DIRECTION THAT WAS MISSING. Removing a producer without removing its
    // schedule fails here.
    const unhandled = declaredCrons(CONFIG).filter(
      (cron) => !(cron in DATA_API_CRON_LANES),
    );
    assert.deepEqual(
      unhandled,
      [],
      `these crons are declared in ${CONFIG} but no branch in workers/data-api.ts ` +
        `handles them, so each one is a no-op Worker invocation on its schedule:\n` +
        unhandled.join("\n"),
    );
  });

  test("every HANDLED lane has a declared cron", () => {
    // The original direction, kept: a handler whose schedule was never declared
    // simply never runs.
    const declared = new Set(declaredCrons(CONFIG));
    const undeclared = Object.keys(DATA_API_CRON_LANES).filter(
      (cron) => !declared.has(cron),
    );
    assert.deepEqual(
      undeclared,
      [],
      `these lanes are handled but never scheduled:\n${undeclared.join("\n")}`,
    );
  });

  test("the lane map names the constants, not copies of their values", () => {
    // A map built from string literals would drift silently the moment a
    // constant changed. Asserting the three constants are its keys is what ties
    // it to them.
    assert.deepEqual(
      Object.keys(DATA_API_CRON_LANES).sort(),
      [NEON_PRUNE_CRON, TABLE_FRESHNESS_CRON, TAO_USD_INDEX_CRON].sort(),
    );
  });

  test("the three retired D1-era crons are gone", () => {
    // Named explicitly so re-adding one is a deliberate act with a test to
    // argue with, rather than a paste that quietly resumes ~23 no-ops an hour.
    const declared = new Set(declaredCrons(CONFIG));
    for (const retired of ["*/3 * * * *", "26 * * * *", "38 * * * *"]) {
      assert.ok(
        !declared.has(retired),
        `${retired} was NEON_BACKFILL/mirror-lag/parity -- all three producers ` +
          `were deleted with D1, so declaring it schedules a no-op`,
      );
    }
  });
});

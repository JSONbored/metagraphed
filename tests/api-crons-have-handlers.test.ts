// Both directions between wrangler.jsonc's 37 crons and the api Worker that
// dispatches them (#10815) -- the twin of tests/data-api-crons-have-handlers,
// and the worse of the two failures it guards.
//
// On data-api an unrecognised cron fell through to `{ skipped: true }`: a
// no-op, wasteful but harmless. Here it fell through to `runHealthProber`,
// unconditionally, because `*/15 * * * *` was the only one of the 37 with no
// constant and no branch -- it WAS the fall-through. So a typo'd or retired
// expression on this Worker did not go quiet, it ran a real producer that
// writes surface_checks, surface_status, surface_uptime_daily, subnet_snapshots
// and lane_health, on whatever cadence the stray expression happened to have.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "vitest";
import { API_HANDLED_CRONS } from "../workers/api.ts";
import { HEALTH_PROBER_CRON } from "../workers/config.ts";
import { stripJsonComments } from "../scripts/lib.ts";

const CONFIG = "wrangler.jsonc";

/**
 * The cron expressions declared in a wrangler config.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not tidiness. This used to match
 * every quoted string inside the `crons` block, including quoted text inside
 * `//` comments -- and the block is heavily commented, one paragraph per lane.
 *
 * Both directions were wrong. A comment quoting a phrase that is not a cron
 * ("Workers Builds does not ...") failed the DECLARED direction on text alone.
 * Worse, the HANDLED direction builds a Set from this list, so a comment merely
 * MENTIONING a cron in quotes made that expression look declared -- and a
 * handled lane whose trigger was never actually registered would have passed,
 * while silently never firing. That is the exact failure this file exists to
 * catch, so the parser must not be the thing that hides it.
 */
function declaredCrons(path: string): string[] {
  const source = stripJsonComments(readFileSync(path, "utf8"));
  const block = /"crons"\s*:\s*\[([\s\S]*?)\]/.exec(source);
  assert.ok(block, `no "crons" array found in ${path}`);
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("the parser itself — a comment is not a declaration", () => {
  // Without these, the two directions below are assertions about prose. The
  // real `crons` block carries one commented paragraph per lane, so quoted text
  // inside comments is the normal case, not a contrived one.
  const fixture = (body: string) => {
    const file = path.join(
      os.tmpdir(),
      `crons-${Math.random().toString(36).slice(2)}.jsonc`,
    );
    writeFileSync(file, `{ "triggers": { "crons": [\n${body}\n] } }`);
    return file;
  };

  test("a cron quoted inside a // comment is NOT read as declared", () => {
    // The false-PASS direction, and the dangerous one: `every HANDLED cron is
    // declared` builds a Set from this list, so a lane whose trigger was never
    // registered would look scheduled because a comment mentioned it.
    const file = fixture(
      `      // renamed from "9,39 * * * *" when the lane moved\n      "26 * * * *",`,
    );
    const parsed = declaredCrons(file);
    assert.deepEqual(parsed, ["26 * * * *"]);
    unlinkSync(file);
  });

  test("quoted prose in a comment is not read as a cron", () => {
    // The false-FAILURE direction: this is what actually broke, on a comment
    // reading `the blanket "Workers Builds does not ..." note`.
    const file = fixture(
      `      // the blanket "Workers Builds does not apply cron triggers" claim\n      "26 * * * *",`,
    );
    assert.deepEqual(declaredCrons(file), ["26 * * * *"]);
    unlinkSync(file);
  });

  test("a /* block */ comment is stripped too", () => {
    const file = fixture(
      `      /* was "1,16,31,46 * * * *" */\n      "26 * * * *",`,
    );
    assert.deepEqual(declaredCrons(file), ["26 * * * *"]);
    unlinkSync(file);
  });

  test("a real cron containing no comment survives unchanged", () => {
    // The positive control: a stripper that returned nothing would pass every
    // test above.
    const file = fixture(`      "26 * * * *",\n      "17,56 * * * *",`);
    assert.deepEqual(declaredCrons(file), ["26 * * * *", "17,56 * * * *"]);
    unlinkSync(file);
  });
});

describe("wrangler.jsonc crons and their handlers", () => {
  test("the parse finds the full grid, so the assertions below are real", () => {
    const declared = declaredCrons(CONFIG);
    assert.ok(
      declared.length >= 30,
      `only ${declared.length} cron(s) parsed out of ${CONFIG} -- the parse broke`,
    );
    assert.ok(
      API_HANDLED_CRONS.length >= 30,
      `only ${API_HANDLED_CRONS.length} handled crons declared`,
    );
  });

  test("every DECLARED cron resolves to a handled lane", () => {
    const unhandled = declaredCrons(CONFIG).filter(
      (cron) => !API_HANDLED_CRONS.includes(cron),
    );
    assert.deepEqual(
      unhandled,
      [],
      `these crons are declared in ${CONFIG} but API_HANDLED_CRONS does not name ` +
        `them, so dispatchScheduled declines them:\n${unhandled.join("\n")}`,
    );
  });

  test("every HANDLED cron is declared", () => {
    const declared = new Set(declaredCrons(CONFIG));
    const undeclared = API_HANDLED_CRONS.filter((cron) => !declared.has(cron));
    assert.deepEqual(
      undeclared,
      [],
      `these lanes are handled but never scheduled:\n${undeclared.join("\n")}`,
    );
  });

  test("the health prober's cron is one of the declared set, not the fall-through", () => {
    // THE ACTUAL FIX. Before #10815 this expression had no constant at all --
    // `runHealthProber` sat at the bottom of dispatchScheduled and ran for
    // anything unmatched. Asserting it is a NAMED member of the handled set is
    // what stops it becoming the default again.
    assert.ok(
      API_HANDLED_CRONS.includes(HEALTH_PROBER_CRON),
      "HEALTH_PROBER_CRON must be a declared member of API_HANDLED_CRONS",
    );
    assert.ok(
      declaredCrons(CONFIG).includes(HEALTH_PROBER_CRON),
      `${HEALTH_PROBER_CRON} must be scheduled in ${CONFIG}`,
    );
  });

  test("the handled set has no duplicates", () => {
    // Two entries for one expression would mean two branches believe they own
    // it, and only the first would ever run.
    const seen = new Set(API_HANDLED_CRONS);
    assert.equal(
      seen.size,
      API_HANDLED_CRONS.length,
      "API_HANDLED_CRONS contains a duplicate expression",
    );
  });
  test("an undeclared cron is declined, and does NOT reach the health prober", () => {
    // THE BEHAVIOUR, not just the bookkeeping. Before #10815 this expression
    // would have run runHealthProber -- five tables written on a cadence
    // nobody chose. Exercised through the real `scheduled` export so the guard
    // is what is being tested, not a reimplementation of it.
    return import("../workers/api.ts").then(async ({ default: worker }) => {
      const result = (await worker.scheduled(
        { cron: "7 7 7 7 7", scheduledTime: Date.now() } as never,
        {} as never,
        { waitUntil: () => {} } as never,
      )) as Record<string, unknown>;
      assert.equal(result.ok, false);
      assert.equal(result.skipped, true);
      assert.equal(result.reason, "unknown cron");
    });
  });

  test("an empty cron is declined rather than treated as the prober's", () => {
    return import("../workers/api.ts").then(async ({ default: worker }) => {
      const result = (await worker.scheduled(
        { scheduledTime: Date.now() } as never,
        {} as never,
        { waitUntil: () => {} } as never,
      )) as Record<string, unknown>;
      assert.equal(result.skipped, true);
      assert.equal(result.reason, "unknown cron");
    });
  });
  test("every handled cron has an `if (cron === ...)` branch in the dispatcher", () => {
    // WHAT MAKES API_HANDLED_CRONS LOAD-BEARING. The dispatcher does not read
    // it -- an earlier cut had it decline against the set first, which made the
    // guard at the bottom unreachable, i.e. a branch no test could cover. So
    // the tie between the set and the branches is asserted here instead.
    //
    // An entry with no branch would fall through to the bottom `return
    // { skipped: true }` and simply never run, which is the #10814 failure
    // wearing this file's clothes.
    const source = readFileSync("workers/api.ts", "utf8");
    const branched = new Set(
      [...source.matchAll(/^ {2}if \(cron === (\w+)\) \{/gm)].map((m) => m[1]),
    );
    assert.ok(
      branched.size >= 30,
      `only ${branched.size} dispatch branches parsed -- the scan broke, so this ` +
        `test is passing on nothing`,
    );
    // HEALTH_PROBER_CRON is branched too, just further down (it guards the
    // firehose bootstrap as well as the prober), so it is expected here.
    assert.ok(
      source.includes("if (cron === HEALTH_PROBER_CRON) {"),
      "the health prober must be a named branch, not the fall-through",
    );
    branched.add("HEALTH_PROBER_CRON");

    const names = new Set(
      [...source.matchAll(/^ {2}([A-Z0-9_]+_CRON),$/gm)].map((m) => m[1]),
    );
    const unbranched = [...names].filter((n) => !branched.has(n));
    assert.deepEqual(
      unbranched,
      [],
      `these are in API_HANDLED_CRONS but no branch dispatches on them, so they ` +
        `would fire and do nothing:\n${unbranched.join("\n")}`,
    );
  });
});

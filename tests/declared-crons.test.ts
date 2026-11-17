// `declaredCrons` -- the parsed answer to "is this schedule actually declared?"
//
// Four suites used to ask that with
// `readFileSync("wrangler.jsonc", "utf8").includes(`"${CRON}"`)`, each under a
// message naming a real consequence: "so this watchdog never runs", "so no
// projection ever recomputes". A raw substring over that file answers neither
// question, and both failure modes are pinned below:
//
//   - wrangler.jsonc carries over a thousand comment lines, and the comments
//     in and around the crons block quote cron expressions to explain the
//     cadences. A commented-out schedule therefore satisfied the check while
//     nothing was scheduled.
//   - a match anywhere in the file passed, so "declared in triggers.crons"
//     and "mentioned somewhere in the config" were the same answer.
//
// The negative cases are the point. A test that only proves the real cron is
// found would pass just as happily on the substring version it replaced.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { declaredCrons, stripJsonComments } from "../scripts/lib/jsonc.ts";

const config = (body: string) => `{\n  "triggers": { "crons": [${body}] }\n}`;

describe("declaredCrons", () => {
  test("returns the declared schedules", () => {
    assert.deepEqual(declaredCrons(config('"41 * * * *", "0 * * * *"')), [
      "41 * * * *",
      "0 * * * *",
    ]);
  });

  test("a commented-out schedule is NOT declared", () => {
    // The defect this exists for: the substring check passed here.
    const source = `{
  "triggers": {
    "crons": [
      "0 * * * *"
      // "41 * * * *" -- retired 2026-11-01, kept for provenance
    ]
  }
}`;
    assert.ok(
      source.includes('"41 * * * *"'),
      "fixture must tempt a substring",
    );
    assert.deepEqual(declaredCrons(source), ["0 * * * *"]);
  });

  test("a schedule mentioned elsewhere in the config is NOT declared", () => {
    // The second failure mode: position mattered and substring could not see
    // it. Here the value sits in an unrelated field.
    const source = `{
  "vars": { "DOC": "runs at 41 * * * *" },
  "triggers": { "crons": ["0 * * * *"] }
}`;
    assert.deepEqual(declaredCrons(source), ["0 * * * *"]);
  });

  test("the real wrangler.jsonc parses, globs and cron stars included", async () => {
    // Not a tautology: this is the file whose route globs end in slash-star
    // and whose crons contain star-slash, the pair a regex stripper splices
    // together. If `stripJsonComments` ever regressed, this is where it shows.
    const { readFileSync } = await import("node:fs");
    const crons = declaredCrons(readFileSync("wrangler.jsonc", "utf8"));
    assert.ok(crons.length > 10, `expected many crons, got ${crons.length}`);
    for (const cron of crons)
      assert.match(cron, /^[\d*,\-/ ]+$/, `not a cron expression: ${cron}`);
  });

  test("an absent or malformed triggers block throws rather than reading empty", () => {
    // "no crons declared" and "I could not read the crons" are different
    // facts, and only one of them should read as a missing schedule.
    for (const source of ["{}", '{"triggers":{}}', '{"triggers":{"crons":{}}}'])
      assert.throws(() => declaredCrons(source), /no triggers\.crons array/);
    assert.throws(
      () => declaredCrons('{"triggers":{"crons":["ok",7]}}'),
      /non-string entry/,
    );
  });

  test("stripJsonComments leaves string contents alone", () => {
    // The property declaredCrons rests on, stated where it is relied upon.
    const kept = stripJsonComments('{"a":"keep // this","b":"and /* this */"}');
    assert.deepEqual(JSON.parse(kept), {
      a: "keep // this",
      b: "and /* this */",
    });
  });
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { parseNativeCron } from "../src/native-cron.ts";

const minute = 60_000;
const day = 1440 * minute;
test("UTC occurrence arithmetic preserves exact boundaries and sparse irregular grids", () => {
  const parser = parseNativeCron("17,56 7,19 * * *");
  assert.equal(parser.cron, "17,56 7,19 * * *");
  assert.deepEqual(parser.window(-1, 0), {
    count: 0,
    first: null,
    last: null,
    previous: null,
  });
  assert.deepEqual(parser.window(-1, day * 2), {
    count: 8,
    first: 437 * minute,
    last: day + 1196 * minute,
    previous: day + 1157 * minute,
  });
  assert.deepEqual(parser.window(437 * minute - 1, 437 * minute), {
    count: 1,
    first: 437 * minute,
    last: 437 * minute,
    previous: null,
  });
  assert.equal(parser.window(437 * minute, 437 * minute + 59_999).count, 0);
  assert.deepEqual(parseNativeCron("*/15 */3 * * *").window(-1, day - 1), {
    count: 32,
    first: 0,
    last: 1305 * minute,
    previous: 1290 * minute,
  });
  assert.equal(
    parseNativeCron("* * * * *").window(-1, day * 36525 - 1).count,
    52_596_000,
  );
  assert.equal(parseNativeCron("*/1 * * * *").window(0, minute).count, 1);
  assert.equal(parseNativeCron("1,1,2 0 * * *").window(-1, day - 1).count, 2);
  assert.equal(parseNativeCron("*/60 */24 * * *").window(-1, day).count, 2);
});
test("unsupported calendars, invalid lists and unsafe windows fail closed", () => {
  for (const cron of [
    "",
    "0 0 * *",
    "0 0 1 * *",
    "0 0 * * 1",
    "0 0 * 1 *",
    "60 * * * *",
    "* 24 * * *",
    "-1 * * * *",
    "1-5 * * * *",
    "*/0 * * * *",
    "*/61 * * * *",
    "* */25 * * *",
    "0, * * * *",
    "0  * * * *",
  ])
    assert.throws(() => parseNativeCron(cron), RangeError);
  for (const [start, end] of [
    [-2, 0],
    [0, -1],
    [1, 0],
    [0.5, 1],
    [0, 1.5],
    [NaN, 1],
    [0, Infinity],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ])
    assert.throws(
      () => parseNativeCron("* * * * *").window(start!, end!),
      RangeError,
    );
});

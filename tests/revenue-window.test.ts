// #10925: `window_days` was the literal `1` at nine call sites.
//
// The surface of the bug was that `?window=` did nothing. The SHAPE of it is
// worse: `windowedAmount` refuses a grain that does not divide the window, so a
// subnet publishing a MONTHLY revenue figure was permanently excluded with the
// reason "grain \"monthly\" does not divide a 1-day window" -- a correct
// sentence, published forever, for a window nobody chose and no caller could
// change. The decline was accurate and the answer was still wrong.
//
// These tests are written against that failure rather than against the enum:
// the vocabulary cases would pass on a `revenueWindowDays` that every caller
// ignored, which is exactly the state this issue describes.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { loadSubnetRevenue, revenueWindowDays } from "../src/revenue-load.ts";
import {
  ATTRIBUTION_WINDOW_DAYS,
  DEFAULT_SUBNET_REVENUE_WINDOW,
  SUBNET_REVENUE_WINDOWS,
  SUBNET_REVENUE_WINDOW_DAYS,
} from "../src/route-limits.ts";
import {
  ROUTE_QUERY_SCHEMAS,
  NO_QUERY_PARAMETERS,
} from "../schemas-src/route-queries.ts";
import {
  GetSubnetRevenueInputSchema,
  ListRevenueCoverageInputSchema,
} from "../schemas-src/mcp-tools/get-subnet-revenue.ts";

const ROUTES = [
  "/api/v1/subnets/{netuid}/revenue",
  "/api/v1/chain/revenue-coverage",
] as const;

/** A subnet whose only revenue surface reports once a month. */
function monthlySubnet(window_days: number) {
  return loadSubnetRevenue({
    netuid: 51,
    window_days,
    economics: { tao_in_emission_tao: 0.0636, excess_tao: 0 },
    surfaces: [
      {
        id: "s-monthly",
        revenue: {
          role: "external-revenue",
          provenance: "probe-derived",
          currency: "USD",
          grain: "monthly",
        },
      },
    ],
    usd_per_tao: 204.03,
    observations: new Map([
      [
        "s-monthly",
        [{ surface_id: "s-monthly", period: "2026-07", amount_usd: 30_000 }],
      ],
    ]),
  });
}

describe("the window a caller asks for reaches the denominator", () => {
  test("A MONTHLY SURFACE IS INVISIBLE AT 1d AND CONTRIBUTES AT 30d", () => {
    // THE BUG. Both calls are the same subnet, the same surface and the same
    // observation; only the window differs. Under the hardcoded `1` the second
    // case was unreachable.
    const day = monthlySubnet(revenueWindowDays("1d"));
    assert.equal(day.sources[0].contributes, false);
    assert.match(day.sources[0].excluded_reason as string, /does not divide/);
    assert.equal(day.sources[0].amount_usd, null);
    assert.equal(day.revenue_usd, null);

    const month = monthlySubnet(revenueWindowDays("30d"));
    assert.equal(month.sources[0].contributes, true);
    assert.equal(month.sources[0].excluded_reason, null);
    assert.equal(month.sources[0].amount_usd, 30_000);
    assert.equal(month.revenue_usd, 30_000);
  });

  test("the exclusion NAMES the window, so the reason is not a constant", () => {
    // A reason that never mentions the window reads as a property of the
    // surface. It is a property of the QUESTION, and the text has to say so or
    // a reader will conclude the subnet publishes nothing usable.
    const seven = monthlySubnet(revenueWindowDays("7d"));
    assert.match(seven.sources[0].excluded_reason as string, /7-day window/);
    assert.match(
      monthlySubnet(revenueWindowDays("1d")).sources[0]
        .excluded_reason as string,
      /1-day window/,
    );
  });

  test("the emission denominator scales with the window too", () => {
    // Not just the numerator. If only the revenue side moved, a 30-day figure
    // would be compared against one day of emission -- the 200x class of error
    // #10565 already fixed once, reintroduced through the window.
    const day = monthlySubnet(revenueWindowDays("1d"));
    const month = monthlySubnet(revenueWindowDays("30d"));
    assert.ok(month.emission.tao > 0);
    assert.ok(
      Math.abs(month.emission.tao / day.emission.tao - 30) < 1e-6,
      `30d emission was ${month.emission.tao / day.emission.tao}x the 1d one`,
    );
  });
});

describe("the vocabulary", () => {
  test("maps each published label to its day count", () => {
    assert.deepEqual(SUBNET_REVENUE_WINDOWS, ["1d", "7d", "30d"]);
    assert.equal(revenueWindowDays("1d"), 1);
    assert.equal(revenueWindowDays("7d"), 7);
    assert.equal(revenueWindowDays("30d"), 30);
  });

  test("every published label has a denominator, and nothing else does", () => {
    // The two lists are one source, so this cannot drift -- but a label added
    // to the enum without a day count would resolve to the DEFAULT rather than
    // failing, which is a wrong answer that looks like a right one.
    assert.deepEqual(
      SUBNET_REVENUE_WINDOWS.slice().sort(),
      Object.keys(SUBNET_REVENUE_WINDOW_DAYS).sort(),
    );
    assert.ok(SUBNET_REVENUE_WINDOWS.includes(DEFAULT_SUBNET_REVENUE_WINDOW));
  });

  test("an absent or unparseable window is the default, not a throw", () => {
    const fallback = SUBNET_REVENUE_WINDOW_DAYS[DEFAULT_SUBNET_REVENUE_WINDOW];
    for (const bad of [undefined, null, "", "90d", 7, {}, []]) {
      assert.equal(revenueWindowDays(bad), fallback, `on ${String(bad)}`);
    }
  });

  test("the default is 1d, so the pre-#10925 answer is still the default one", () => {
    // The migration claim: every caller that passed nothing before now gets
    // the identical number. This is what makes the change non-breaking.
    assert.equal(revenueWindowDays(undefined), 1);
  });
});

describe("one vocabulary, three surfaces", () => {
  for (const path of ROUTES) {
    test(`${path} publishes window and no longer claims to take nothing`, () => {
      const shape = ROUTE_QUERY_SCHEMAS[path]?.shape;
      assert.ok(shape?.window, "the route declares no window");
      assert.equal(
        NO_QUERY_PARAMETERS.includes(path),
        false,
        "still listed as taking no parameters",
      );
      for (const label of SUBNET_REVENUE_WINDOWS) {
        assert.equal(shape.window.parse(label), label);
      }
      assert.equal(shape.window.safeParse("90d").success, false);
    });
  }

  test("the MCP inputs ARE the route schemas, by identity", () => {
    // Not "equivalent to" -- the same object. A copy is how the MCP argument
    // vocabulary drifted from its route before (#10925's sibling failure).
    assert.equal(
      GetSubnetRevenueInputSchema.shape.window,
      ROUTE_QUERY_SCHEMAS[ROUTES[0]].shape.window,
    );
    assert.equal(
      ListRevenueCoverageInputSchema.shape.window,
      ROUTE_QUERY_SCHEMAS[ROUTES[1]].shape.window,
    );
  });

  test("NO SERVING SITE WRITES A LITERAL DAY COUNT", () => {
    // THE NEGATIVE INVARIANT, and the only assertion here that found anything.
    // Every check above passes on a codebase that still hardcodes the window at
    // a tenth site, because a test can only check the call sites it names.
    //
    // This one names none of them, and it caught four the issue did not list:
    // `window_days: 30` restated in the wallets and owner-cut handlers and
    // again in both of their MCP tools. Those windows are genuinely fixed --
    // the caller does not pick them -- so the fix there is
    // ATTRIBUTION_WINDOW_DAYS rather than a `?window=`. Either way the rule is
    // the same: the number is named once, and a serving file that writes a
    // digit is asserting a denominator nothing else can see.
    // DERIVED, not listed. A hardcoded file list is the same failure one level
    // up: it goes stale the moment a serving file is added or renamed, and it
    // goes stale silently. Walk src/ and workers/ instead.
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(join(root, "src"));
    walk(join(root, "workers"));
    assert.ok(files.length > 100, `only swept ${files.length} files`);

    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const [i, line] of source.split("\n").entries()) {
        // A literal day count assigned to the field, in any spacing. A
        // constant or an expression is fine; a digit is not.
        if (/window_days\s*:\s*\d/.test(line)) {
          offenders.push(`${relative(root, file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join("\n"));
  });

  test("the fixed-window routes still publish 30, via the constant", () => {
    // The other half: the sweep above is satisfied by DELETING the field, and
    // a wallets response with no `window_days` would pass it. Pin the value.
    assert.equal(ATTRIBUTION_WINDOW_DAYS, 30);
  });
});

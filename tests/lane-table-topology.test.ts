// The lane topology declaration, and the gate that keeps it honest (#11183).
//
// The declaration exists because three coverage rules were written without
// knowing three things Postgres cannot tell them, and all three were wrong
// (#11166, #11170, #11180). A declaration nobody reads would be documentation,
// so what is asserted here is that it is LOAD-BEARING: the nominator-positions
// rule takes its scoping from it, and a declaration that disagrees with the
// schema fails CI rather than quietly making a rule count the wrong thing.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import {
  COVERAGE_UNIT_ROWS,
  LANE_TABLE_TOPOLOGY,
  type LaneTableTopology,
  fullScanProducer,
  laneTableTopology,
  requireFullScanValue,
  resolveFullScan,
} from "../src/lane-table-topology.ts";
import { POSITION_SOURCE_ALPHA } from "../src/nominator-positions-neon-write.ts";
import { NOMINATOR_POSITIONS_SCAN_SOURCE } from "../src/nominator-positions-staleness-watchdog.ts";
import {
  columnsByTable,
  problemsFor,
} from "../scripts/validate-lane-topology.ts";
import { repoRoot } from "../scripts/lib.ts";

/** The real snapshot, so the declaration is checked against real columns. */
const COLUMNS = columnsByTable(
  readFileSync(path.join(repoRoot, "generated/db/schema.json"), "utf8"),
);

/** A valid single-producer declaration, cloned per case so edits stay local. */
function valid(): LaneTableTopology {
  return {
    prunes: false as const,
    producers: { lanes: ["metagraph"], column: null, fullScanValue: null },
    coverageUnit: COVERAGE_UNIT_ROWS,
    populationSource: "chain: something",
  };
}

describe("the committed declaration", () => {
  test("it agrees with the introspected schema", () => {
    assert.deepEqual(problemsFor(LANE_TABLE_TOPOLOGY, COLUMNS), []);
  });

  test("nominator_positions is declared with two producers and a discriminator", () => {
    // The specific fact #11180 turned on. Asserted by name rather than by
    // count, so a future producer added to the list cannot quietly satisfy it.
    const t = laneTableTopology("nominator_positions");
    assert.equal(t.producers.column, "source");
    assert.deepEqual([...t.producers.lanes].sort(), [
      "self_stake",
      "validator_nominators",
    ]);
    assert.equal(t.producers.fullScanValue, POSITION_SOURCE_ALPHA);
  });

  test("the accumulating tables say so, because their row counts are history", () => {
    // Each of these had (or fed) an expectation read off its own row count.
    // `prunes: false` is the property that makes that read invalid.
    for (const table of [
      "validator_nominator_counts",
      "hotkey_alpha",
      "account_balances",
    ] as const) {
      assert.equal(
        laneTableTopology(table).prunes,
        false,
        `${table} accumulates; declaring otherwise would license reading its population off itself`,
      );
    }
  });
});

describe("the declaration is load-bearing, not decorative", () => {
  test("the nominator-positions rule takes its scoping from it", () => {
    // If this were a coincidence rather than a derivation, changing the
    // declaration would leave the rule scoping to a stale literal -- which is
    // the shape of the bug the declaration exists to prevent.
    assert.equal(
      NOMINATOR_POSITIONS_SCAN_SOURCE,
      LANE_TABLE_TOPOLOGY.nominator_positions.producers.fullScanValue,
    );
  });

  test("an ambiguous declaration throws rather than defaulting", () => {
    // Returning null here would hand the caller a choice between scoping to
    // nothing and scoping to everything, and "everything" is the unscoped read
    // that made a healthy self-stake run look like a truncated alpha scan.
    const two: LaneTableTopology = {
      ...valid(),
      producers: {
        lanes: ["validator_nominators", "self_stake"],
        column: "source",
        fullScanValue: null,
      },
    };
    const ambiguous = { two } as unknown as Readonly<
      Record<string, LaneTableTopology>
    >;
    assert.throws(
      () => resolveFullScan(two, "two"),
      /cannot know whose pass/,
      "an ambiguous topology must fail loudly",
    );
    // And the gate refuses it too, so it cannot reach a rule at all.
    assert.ok(
      problemsFor(ambiguous, new Map([["two", new Set(["source"])]])).some(
        (p) => /names no fullScanValue/.test(p),
      ),
    );
  });

  test("an undeclared table throws rather than returning undefined", () => {
    // Unreachable through the typed API -- LaneTableName is `keyof typeof` the
    // map, so indexing always yields a value. The guard is defence against a
    // CAST, which is the only way in, and this documents that: a caller who
    // casts gets a throw rather than an undefined that would flow on into an
    // unscoped query.
    assert.throws(
      () => laneTableTopology("not_a_lane_table" as never),
      /no declared topology for not_a_lane_table/,
    );
  });

  test("requireFullScanValue refuses a table with nothing to scope on", () => {
    // The guard a caller building `WHERE source = ?` depends on. Binding null
    // there matches no rows at all, so the rule would report zero coverage
    // forever -- indistinguishable from the truncated pass this began with.
    assert.throws(
      () => requireFullScanValue("validator_nominator_counts"),
      /no discriminated full-scan producer/,
    );
    // And it returns the value where there IS one.
    assert.equal(
      requireFullScanValue("nominator_positions"),
      POSITION_SOURCE_ALPHA,
    );
  });

  test("a single-producer table resolves without a fullScan", () => {
    // NULL, not a value: one producer writes everything, so there is nothing to
    // scope on. That is different from the several-producer case, where null
    // would mean "scope to everything" and reintroduce #11180.
    assert.equal(fullScanProducer("validator_nominator_counts"), null);
  });
});

describe("the gate refuses declarations that would misdirect a rule", () => {
  const cols = new Map([["t", new Set(["captured_at", "coldkey", "source"])]]);

  test("a column that does not exist is caught", () => {
    const bad = {
      t: { ...valid(), coverageUnit: "ghost" },
    } as unknown as Readonly<Record<string, LaneTableTopology>>;
    assert.match(
      problemsFor(bad, cols).join("\n"),
      /coverageUnit names "ghost"/,
      "a coverageUnit pointing at a moved column counts the wrong thing silently",
    );
  });

  test("a prune key that does not exist is caught", () => {
    const bad = {
      t: { ...valid(), prunes: { perKey: "ghost" } },
    } as unknown as Readonly<Record<string, LaneTableTopology>>;
    assert.match(
      problemsFor(bad, cols).join("\n"),
      /prunes\.perKey names "ghost"/,
    );
  });

  test("several producers with no discriminator is caught", () => {
    const bad = {
      t: {
        ...valid(),
        producers: {
          lanes: ["validator_nominators", "self_stake"],
          column: null,
          fullScanValue: "alpha",
        },
      },
    } as unknown as Readonly<Record<string, LaneTableTopology>>;
    assert.match(
      problemsFor(bad, cols).join("\n"),
      /no column to tell them apart/,
    );
  });

  test("a fullScanValue with no column to match it against is caught", () => {
    // Replaces an earlier check that fullScan had to be one of the producers.
    // That check stopped meaning anything once `lanes` and `fullScanValue`
    // became the two different vocabularies they actually are: the lane is
    // `validator_nominators` and the value it stamps is `alpha`. What is still
    // checkable is that a value can be applied at all.
    const bad = {
      t: {
        ...valid(),
        producers: {
          lanes: ["validator_nominators"],
          column: null,
          fullScanValue: "alpha",
        },
      },
    } as unknown as Readonly<Record<string, LaneTableTopology>>;
    assert.match(
      problemsFor(bad, cols).join("\n"),
      /no column to match it against/,
    );
  });

  test("one producer plus a discriminator is caught as contradictory", () => {
    // Scoping on it would filter to a subset of a single writer's own rows,
    // which reads as a truncated pass forever.
    const bad = {
      t: {
        ...valid(),
        producers: {
          lanes: ["metagraph"],
          column: "source",
          fullScanValue: null,
        },
      },
    } as unknown as Readonly<Record<string, LaneTableTopology>>;
    assert.match(
      problemsFor(bad, cols).join("\n"),
      /declares one producer lane but also a discriminator/,
    );
  });

  test("a table absent from the snapshot is caught, not skipped", () => {
    const bad = { gone: valid() } as unknown as Readonly<
      Record<string, LaneTableTopology>
    >;
    assert.match(
      problemsFor(bad, cols).join("\n"),
      /absent from generated\/db\/schema\.json/,
    );
  });

  test("the real declaration is non-vacuous: the gate can fail", () => {
    // Proves the empty result above is a verdict rather than an empty sweep.
    assert.ok(problemsFor({ gone: valid() }, cols).length > 0);
  });
});

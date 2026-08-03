// The runtime-upgrade timeline, served from the lakehouse (#9265).
//
// /api/v1/runtime published `transitions: []`, `transition_count: 0` and
// `current_spec_version: null` beside a `current` block reporting spec 440
// from a live chain read -- the same payload claiming, in one breath, that the
// network runs runtime 440 and that it has never upgraded. All three surfaces
// ran `tryPostgresTier(METAGRAPH_BLOCKS_SOURCE) ?? buildRuntimeVersionHistory([])`
// and the Postgres tier is gone.
//
// The trap this file pins: `coverage_complete` is computed as "no gaps found",
// and an EMPTY timeline has no gaps in it. The dead route was therefore
// publishing `coverage_complete: true` over zero data. Declining is what keeps
// that from being reintroduced one tier lower.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { loadRuntimeVersionHistoryColdTier } from "../src/runtime-versions-cold-tier.ts";

type Row = Record<string, unknown>;

// A miniature of the real shape measured on 2026-08-03: ascending, starting at
// genesis, with a non-contiguous spec jump (424 -> 432) that is a real chain
// fact rather than missing data -- mainnet skipped 425-431.
const ROWS: Row[] = [
  { spec_version: 101, block_number: 0, observed_at: 1_600_000_000_000 },
  {
    spec_version: 424,
    block_number: 8_513_821,
    observed_at: 1_782_760_932_000,
  },
  {
    spec_version: 432,
    block_number: 8_636_191,
    observed_at: 1_784_230_224_000,
  },
  {
    spec_version: 440,
    block_number: 8_713_793,
    observed_at: 1_785_161_772_000,
  },
];
const LATEST: Row[] = [{ spec_version: 440, block_number: 8_763_320 }];

function fakeEngine(
  overrides: { rows?: Row[] | null; latest?: Row[] | null } = {},
) {
  const seen: string[] = [];
  const pick = <T>(value: T | undefined, fallback: T) =>
    value === undefined ? fallback : value;
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    // Selected on the clause only the head query can have. "GROUP BY" would
    // work today too, but LIMIT 1 is what makes it the head query.
    return sql.includes("LIMIT 1")
      ? pick(overrides.latest, LATEST)
      : pick(overrides.rows, ROWS);
  };
  return {
    query,
    seen,
    transitions: () => seen.find((sql) => sql.includes("GROUP BY"))!,
    latest: () => seen.find((sql) => sql.includes("LIMIT 1"))!,
  };
}

describe("loadRuntimeVersionHistoryColdTier", () => {
  test("builds the timeline, not raw rows", async () => {
    const engine = fakeEngine();
    const data = await loadRuntimeVersionHistoryColdTier({} as never, {
      query: engine.query as never,
    });
    assert.ok(data);
    assert.equal(data.transition_count, 4);
    assert.equal(data.transitions[0].spec_version, 101);
    assert.equal(data.transitions[0].block_number, 0);
    assert.equal(data.transitions[0].observed_at, "2020-09-13T12:26:40.000Z");
  });

  test("current_spec_version comes from the head block, not the last transition", async () => {
    // The GROUP BY collapses each spec_version to its EARLIEST block, so after
    // a rollback -- an older version reappearing once a newer one had been
    // seen -- the final transition entry is the SUPERSEDED version. Reading
    // current_spec_version off it would report the network as running a
    // runtime it had already moved off.
    const engine = fakeEngine({
      rows: [
        ...ROWS,
        // 439 reappears after 440: its group keeps 439's earliest block, so it
        // sorts last only because that block is late. It is not current.
        {
          spec_version: 439,
          block_number: 8_800_000,
          observed_at: 1_785_900_000_000,
        },
      ],
      latest: [{ spec_version: 440, block_number: 8_900_000 }],
    });
    const data = await loadRuntimeVersionHistoryColdTier({} as never, {
      query: engine.query as never,
    });
    assert.equal(
      data?.current_spec_version,
      440,
      "the head block is current, not the last GROUP BY row (439)",
    );
    assert.match(engine.latest(), /ORDER BY block_number DESC LIMIT 1/);
  });

  test("a non-contiguous spec jump over a short span is not a coverage gap", async () => {
    // Mainnet went 424 -> 432, skipping 425-431: releases that never reach
    // mainnet leave real holes in the version sequence with no data missing.
    const engine = fakeEngine();
    const data = await loadRuntimeVersionHistoryColdTier({} as never, {
      query: engine.query as never,
    });
    assert.deepEqual(
      data?.coverage_gaps.map((g) => [
        g.after_spec_version,
        g.before_spec_version,
      ]),
      [[101, 424]],
      "only the genesis->424 span is wide enough to be a gap",
    );
  });

  test("declines rather than publishing an empty timeline as complete", async () => {
    // coverage_complete is "no gaps found", and an empty timeline has no gaps
    // -- which is exactly how the dead route came to advertise
    // `coverage_complete: true` over zero data. Returning the built-but-empty
    // history here would move that lie one tier down.
    for (const miss of [{ rows: null }, { latest: null }, { rows: [] }]) {
      const engine = fakeEngine(miss);
      assert.equal(
        await loadRuntimeVersionHistoryColdTier({} as never, {
          query: engine.query as never,
        }),
        null,
        `${JSON.stringify(miss)} must decline`,
      );
    }
  });

  test("a missing head row still publishes the timeline, with a null current", async () => {
    // The timeline is the truth regardless, and the builder already publishes
    // a null current_spec_version. Defaulting it to the last transition would
    // reintroduce the rollback bug the separate query exists to avoid.
    const engine = fakeEngine({ latest: [] });
    const data = await loadRuntimeVersionHistoryColdTier({} as never, {
      query: engine.query as never,
    });
    assert.ok(data, "an unknown head does not invalidate the history");
    assert.equal(data.transition_count, 4);
    assert.equal(data.current_spec_version, null);
  });

  test("reads the lakehouse blocks table and filters unread spec_versions", async () => {
    const engine = fakeEngine();
    await loadRuntimeVersionHistoryColdTier({} as never, {
      query: engine.query as never,
    });
    for (const sql of engine.seen) {
      assert.match(sql, /FROM chain\.blocks/);
      assert.match(sql, /spec_version IS NOT NULL/);
    }
    assert.match(engine.transitions(), /GROUP BY spec_version/);
    assert.match(engine.transitions(), /ORDER BY block_number ASC/);
  });

  test("takes no caller input, so nothing reaches SQL to escape", async () => {
    // R2 SQL has no bound parameters, so the safety argument for this reader
    // is that its queries are constants. If a parameter is ever added, this
    // breaks and the identifier guards used by the event rollups become
    // required here too.
    const engine = fakeEngine();
    await loadRuntimeVersionHistoryColdTier({} as never, {
      query: engine.query as never,
    });
    assert.equal(engine.seen.length, 2);
    for (const sql of engine.seen) {
      assert.doesNotMatch(sql, /\$\{|\?/, `not a constant query: ${sql}`);
    }
  });
});

describe("all three runtime surfaces go through the one reader", () => {
  // The regression is a surface wired to the lakehouse while its siblings are
  // not. A call site either exists or it does not, so reading the sources
  // asserts it exactly.
  const sources = {
    REST: "workers/request-handlers/entities.ts",
    MCP: "src/mcp-server.ts",
    GraphQL: "src/graphql.ts",
  } as const;

  test("every surface calls loadRuntimeVersionHistoryColdTier", () => {
    for (const [surface, path] of Object.entries(sources)) {
      assert.match(
        readFileSync(path, "utf8"),
        /loadRuntimeVersionHistoryColdTier\(/,
        `${surface} (${path}) would answer an empty timeline while its ` +
          "siblings answer the real one",
      );
    }
  });

  test("no surface still claims spec_version cannot be back-filled", () => {
    // That caveat described the retired D1 tier's never-back-filled nullable
    // ALTER. The lakehouse carries a reading on every block, so repeating it
    // would tell callers to distrust a complete timeline.
    for (const path of [...Object.values(sources), "src/contracts.ts"]) {
      assert.doesNotMatch(
        readFileSync(path, "utf8"),
        /spec_version (?:wasn't tracked|is best-effort)/,
        `${path} repeats the retired tier's coverage caveat`,
      );
    }
  });
});

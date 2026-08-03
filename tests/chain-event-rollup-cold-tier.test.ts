// The per-subnet event-activity rollups served from the lakehouse.
//
// /api/v1/chain/serving and /api/v1/chain/registrations answered empty after
// the box wipe while the lakehouse held 2,791,121 AxonServed and 1,071,405
// NeuronRegistered rows. The risk in fixing that is not "no data" — it is
// publishing numbers that look measured and are not.
//
// Two specific ways that could happen here, both asserted below:
//   * summing the per-subnet distinct-hotkey counts to get a network total,
//     which overstates it, because one hotkey serving five subnets is five
//     rows and one server; and
//   * answering with per-subnet rows when the network query failed, which
//     reports zero distinct servers beside real activity — a contradiction the
//     caller cannot see.
//
// The SQL shapes were executed against the live engine while writing this:
// COUNT(DISTINCT) works (129 netuids over WeightsSet), count_if does not, and
// the AxonServed 7d rollup returns 2,941 network-wide servers against a much
// larger per-subnet sum.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  CHAIN_REGISTRATIONS_ROLLUP,
  CHAIN_SERVING_ROLLUP,
  CHAIN_WEIGHTS_ROLLUP,
  loadChainEventRollup,
  safeColumnAlias,
  safeEventKind,
} from "../src/chain-event-rollup-cold-tier.ts";

const NOW = 1_785_000_000_000;

/** Records the SQL both halves emitted, and answers with canned rows. */
function fakeEngine(
  answers: {
    rows?: Record<string, unknown>[] | null;
    network?: Record<string, unknown>[] | null;
  } = {},
) {
  const seen: string[] = [];
  // `??` would turn an EXPLICIT null — the failure being simulated — back into
  // a result, hiding the decline path this file exists to check.
  const pick = <T>(value: T | undefined, fallback: T) =>
    value === undefined ? fallback : value;
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    return sql.includes("ORDER BY")
      ? pick(answers.rows, [
          { netuid: 1, announcements: 5, distinct_servers: 3 },
        ])
      : pick(answers.network, [
          { distinct_servers: 3, newest_observed: NOW - 1000 },
        ]);
  };
  return {
    query,
    seen,
    /** Both halves run under Promise.all, so push order is not guaranteed --
     * select by content rather than by index. Discriminating on ORDER BY, not
     * on GROUP BY: the uid-keyed network total is itself a GROUP BY subquery,
     * so that would misroute it. */
    rowsSql: () => seen.find((sql) => sql.includes("ORDER BY")),
    networkSql: () => seen.find((sql) => !sql.includes("ORDER BY")),
  };
}

const load = (
  overrides: Parameters<typeof fakeEngine>[0] = {},
  options: Record<string, unknown> = {},
) => {
  const engine = fakeEngine(overrides);
  return {
    engine,
    result: loadChainEventRollup({} as never, CHAIN_SERVING_ROLLUP, {
      windowDays: 7,
      now: NOW,
      query: engine.query,
      ...options,
    } as never),
  };
};

describe("the event kind that reaches SQL", () => {
  test("a normal chain event kind is accepted", () => {
    assert.equal(safeEventKind("AxonServed"), "AxonServed");
    assert.equal(safeEventKind("NeuronRegistered"), "NeuronRegistered");
  });

  test("anything that is not a bare identifier is refused, never escaped", () => {
    // R2 SQL has no bound parameters, so this value is interpolated. Refusing
    // beats escaping: an escape that is subtly wrong still runs.
    for (const bad of [
      "AxonServed'; DROP TABLE chain.account_events--",
      "Axon Served",
      "",
      "1Axon",
      null,
      42,
    ]) {
      assert.equal(safeEventKind(bad), null, `${String(bad)} must be refused`);
    }
  });

  test("a column alias that is not a bare identifier is refused", () => {
    // countField/distinctField land in `AS <name>` and `ORDER BY <name>` --
    // IDENTIFIER position, so there are no quotes to break out of and anything
    // accepted here executes as SQL. ORDER BY is the sink an attacker can hang
    // a subquery off.
    for (const bad of [
      "announcements, (SELECT 1)",
      "announcements DESC, netuid",
      "(SELECT count(*) FROM chain.blocks)",
      "Announcements",
      "",
      null,
      7,
    ]) {
      assert.equal(
        safeColumnAlias(bad),
        null,
        `${String(bad)} must be refused`,
      );
    }
  });

  test("real column aliases are accepted", () => {
    for (const good of ["announcements", "distinct_servers", "registrations"]) {
      assert.equal(safeColumnAlias(good), good);
    }
  });

  test("a spec naming a column the table does not have declines", async () => {
    // distinctColumn is a closed set, not an alias guard: the two values are
    // the only columns that carry an identity for these events, so anything
    // else is a bug rather than merely unsafe -- and must stop before SQL.
    const engine = fakeEngine();
    const result = await loadChainEventRollup(
      {} as never,
      {
        ...CHAIN_SERVING_ROLLUP,
        distinctColumn: "coldkey" as unknown as "hotkey",
      },
      { windowDays: 7, now: NOW, query: engine.query } as never,
    );
    assert.equal(result, null);
    assert.deepEqual(engine.seen, [], "an unknown column must not reach SQL");
  });

  test("a spec with an injected column alias declines without querying", () => {
    // Exercised through the loader, not only the guard: a refused alias must
    // stop before any SQL is built, or the refusal is theoretical.
    const engine = fakeEngine();
    return loadChainEventRollup(
      {} as never,
      { ...CHAIN_SERVING_ROLLUP, countField: "announcements, (SELECT 1)" },
      { windowDays: 7, now: NOW, query: engine.query } as never,
    ).then((result) => {
      assert.equal(result, null);
      assert.deepEqual(engine.seen, [], "a refused alias must not reach SQL");
    });
  });

  test("both shipped specs pass their own guard", () => {
    // A spec that could not pass would make its route silently decline
    // forever, which looks exactly like "no data".
    for (const spec of [CHAIN_SERVING_ROLLUP, CHAIN_REGISTRATIONS_ROLLUP]) {
      assert.equal(safeEventKind(spec.eventKind), spec.eventKind);
      assert.equal(safeColumnAlias(spec.countField), spec.countField);
      assert.equal(safeColumnAlias(spec.distinctField), spec.distinctField);
    }
  });
});

describe("what the rollup refuses to publish", () => {
  test("a failed per-subnet query declines", async () => {
    assert.equal(await load({ rows: null }).result, null);
  });

  test("a failed NETWORK query declines, rather than reporting zero servers", async () => {
    // The sharp one. Per-subnet rows plus a missing network block would render
    // real activity next to "0 distinct servers" — a contradiction that reads
    // as measured, not as a failure.
    assert.equal(await load({ network: null }).result, null);
  });

  test("an empty network result declines", async () => {
    assert.equal(await load({ network: [] }).result, null);
  });

  test("a window the frozen table no longer reaches declines", async () => {
    // These events stopped when the box did. Once the window passes them,
    // publishing zeros would read as "no subnet served anything" rather than
    // "we have no data for this range".
    assert.equal(await load({ rows: [] }).result, null);
  });

  test("a spec whose event kind cannot be interpolated declines without querying", async () => {
    // The guard is exercised through the loader, not only through
    // safeEventKind: a spec that fails validation must stop before any SQL is
    // built, or the refusal is theoretical.
    const engine = fakeEngine();
    const result = await loadChainEventRollup(
      {} as never,
      { ...CHAIN_SERVING_ROLLUP, eventKind: "Axon'; DROP--" },
      { windowDays: 7, now: NOW, query: engine.query } as never,
    );
    assert.equal(result, null);
    assert.deepEqual(engine.seen, [], "a refused kind must not reach SQL");
  });

  test("a malformed limit falls back to the default rather than reaching SQL", async () => {
    // An absurd limit clamps (asserted below); a NON-INTEGER one must not be
    // interpolated at all -- `LIMIT NaN` is a syntax error that would take the
    // whole route down rather than degrade it.
    for (const limit of [Number.NaN, -1, 0, "20" as unknown as number]) {
      const engine = fakeEngine();
      await loadChainEventRollup({} as never, CHAIN_SERVING_ROLLUP, {
        windowDays: 7,
        now: NOW,
        limit,
        query: engine.query,
      } as never);
      assert.match(
        engine.rowsSql()!,
        /LIMIT 200/,
        `limit=${String(limit)} must fall back to the default`,
      );
    }
  });

  test("a clock that cannot produce a valid cutoff declines without querying", async () => {
    const { engine, result } = load({}, { now: 0 });
    assert.equal(await result, null);
    assert.deepEqual(engine.seen, [], "no query may run without a cutoff");
  });

  test("a non-positive window declines without querying", async () => {
    for (const windowDays of [0, -7, Number.NaN]) {
      const { engine, result } = load({}, { windowDays });
      assert.equal(await result, null, `windowDays=${windowDays}`);
      assert.deepEqual(engine.seen, []);
    }
  });
});

describe("the SQL it emits", () => {
  test("the network distinct is its OWN query, never summed from the rows", async () => {
    // Summing per-subnet distinct counts overstates the network total: one
    // hotkey on five subnets is five rows and one server. Measured live: 2,941
    // network-wide AxonServed servers in 7d, well under the per-subnet sum.
    const { engine, result } = load();
    await result;
    assert.equal(engine.seen.length, 2, "both halves must be queried");
    const rowsSql = engine.rowsSql()!;
    const networkSql = engine.networkSql()!;
    assert.match(rowsSql, /GROUP BY netuid/);
    assert.doesNotMatch(
      networkSql,
      /GROUP BY/,
      "the network total must be ungrouped, or it is a per-subnet count again",
    );
    assert.match(networkSql, /count\(DISTINCT hotkey\)/);
  });

  test("a uid-keyed network total counts distinct PAIRS, not distinct uids", async () => {
    // The bug this replaced: an ungrouped COUNT(DISTINCT uid) counts distinct
    // uid NUMBERS, which are capped near 256 and shared across every subnet --
    // uid 5 on twenty subnets collapsed to one. It reported 254 in production
    // where the true distinct-pair count was 1,280. A uid identifies a neuron
    // only WITHIN a subnet, so the pair is the participant.
    const engine = fakeEngine();
    await loadChainEventRollup({} as never, CHAIN_WEIGHTS_ROLLUP, {
      windowDays: 7,
      now: NOW,
      query: engine.query,
    } as never);
    const networkSql = engine.networkSql()!;
    assert.match(
      networkSql,
      /GROUP BY netuid, uid/,
      "a uid-keyed total must group by the pair",
    );
    assert.doesNotMatch(
      networkSql,
      /count\(DISTINCT uid\)/,
      "counting distinct uid numbers is not a participant count",
    );
  });

  test("a hotkey-keyed network total stays an ungrouped distinct count", async () => {
    // A hotkey IS globally unique, so the pair form would be wrong here --
    // it would count one hotkey once per subnet it serves on.
    const engine = fakeEngine();
    await loadChainEventRollup({} as never, CHAIN_SERVING_ROLLUP, {
      windowDays: 7,
      now: NOW,
      query: engine.query,
    } as never);
    const networkSql = engine.networkSql()!;
    assert.match(networkSql, /count\(DISTINCT hotkey\)/);
    assert.doesNotMatch(networkSql, /GROUP BY/);
  });

  test("the uid form still reports the newest reading", async () => {
    // The subquery changes where observed_at comes from; losing it would make
    // every uid-keyed route report a null timestamp and look unmeasured.
    const engine = fakeEngine();
    await loadChainEventRollup({} as never, CHAIN_WEIGHTS_ROLLUP, {
      windowDays: 7,
      now: NOW,
      query: engine.query,
    } as never);
    assert.match(engine.networkSql()!, /AS newest_observed/);
  });

  test("both halves carry the same kind and window predicate", async () => {
    // Two scans, one question. A half that drifted would report a rollup and a
    // network total measured over different data.
    const { engine, result } = load();
    await result;
    const cutoff = NOW - 7 * 24 * 60 * 60 * 1000;
    for (const sql of engine.seen) {
      assert.ok(sql.includes(`event_kind = 'AxonServed'`), sql.slice(0, 70));
      assert.ok(sql.includes(`observed_at >= ${cutoff}`), sql.slice(0, 70));
    }
  });

  test("the per-subnet rollup is row-capped, and the cap is bounded", async () => {
    // R2 SQL is second-scale with no indexes; an uncapped GROUP BY over
    // account_events is the read here that could pin a request open.
    const { engine, result } = load({}, { limit: 5_000_000 });
    await result;
    assert.match(
      engine.rowsSql()!,
      /LIMIT 1000\b/,
      "an absurd limit must clamp",
    );
  });

  test("no rollup uses a function the engine rejects", async () => {
    // Measured live: count_if is rejected outright, COUNT(DISTINCT) is not.
    const { engine, result } = load();
    await result;
    for (const sql of engine.seen) {
      assert.doesNotMatch(sql, /count_if/i);
    }
  });

  test("each spec names its own count columns", async () => {
    // The builders read `announcements`/`distinct_servers` and
    // `registrations`/`distinct_registrants` respectively. A shared reader that
    // emitted one naming would leave the other builder reading undefined and
    // reporting zeros.
    const engine = fakeEngine({
      rows: [{ netuid: 1, registrations: 2, distinct_registrants: 2 }],
    });
    await loadChainEventRollup({} as never, CHAIN_REGISTRATIONS_ROLLUP, {
      windowDays: 7,
      now: NOW,
      query: engine.query,
    } as never);
    const registrationsSql = engine.rowsSql()!;
    assert.match(registrationsSql, /AS registrations/);
    assert.match(registrationsSql, /AS distinct_registrants/);
    assert.ok(registrationsSql.includes("event_kind = 'NeuronRegistered'"));
  });
});

describe("what it hands back", () => {
  test("rows and the network block are returned unaltered for the builder", async () => {
    // The builders group by netuid themselves and read the network block for
    // the un-summable distinct. Reshaping here would duplicate logic that
    // already exists and can disagree with it.
    const { result } = load({
      rows: [{ netuid: 7, announcements: 9, distinct_servers: 4 }],
      network: [{ distinct_servers: 4, newest_observed: NOW - 5 }],
    });
    const rollup = await result;
    assert.ok(rollup);
    assert.deepEqual(rollup.rows, [
      { netuid: 7, announcements: 9, distinct_servers: 4 },
    ]);
    assert.equal(rollup.networkDistinct.distinct_servers, 4);
    assert.equal(rollup.networkDistinct.newest_observed, NOW - 5);
  });
});

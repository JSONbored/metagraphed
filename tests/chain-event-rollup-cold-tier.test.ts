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
  ROLLUP_POPULATION_CAP,
  safeColumnAlias,
  safeEventKind,
} from "../src/chain-event-rollup-cold-tier.ts";
import type { ChainEventRollupOutcome } from "../src/chain-event-rollup-cold-tier.ts";

/**
 * The rollup of a successful read.
 *
 * A narrowing helper rather than a cast: `kind` is what separates an answer
 * from a decline since #11417, so a test reaching straight for `.rows` would be
 * asserting against a shape the reader never promised.
 */
function answered<T>(outcome: ChainEventRollupOutcome<T>): T {
  // `assert.fail` returns `never`, so this NARROWS the union -- no cast, and a
  // decline fails the test loudly rather than reading through as undefined.
  if (outcome.kind !== "answer") {
    assert.fail(`expected an answer, got ${outcome.kind}`);
  }
  return outcome.rollup;
}

const NOW = 1_785_000_000_000;

/** Records the SQL both halves emitted, and answers with canned rows. */
function fakeEngine(
  answers: {
    rows?: Record<string, unknown>[] | null;
    network?: Record<string, unknown>[] | null;
    subnets?: Record<string, unknown>[] | null;
  } = {},
) {
  const seen: string[] = [];
  // `??` would turn an EXPLICIT null — the failure being simulated — back into
  // a result, hiding the decline path this file exists to check.
  const pick = <T>(value: T | undefined, fallback: T) =>
    value === undefined ? fallback : value;
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    // Three queries now (#10249). Routed by shape rather than by call order,
    // because they run in one `Promise.all` and order is not a contract.
    if (sql.includes("ORDER BY")) {
      return pick(answers.rows, [
        { netuid: 1, announcements: 5, distinct_servers: 3 },
      ]);
    }
    if (sql.includes("AS subnet_count")) {
      return pick(answers.subnets, [{ subnet_count: 12 }]);
    }
    return pick(answers.network, [
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
    networkSql: () =>
      seen.find(
        (sql) => !sql.includes("ORDER BY") && !sql.includes("AS subnet_count"),
      ),
    subnetCountSql: () => seen.find((sql) => sql.includes("AS subnet_count")),
  };
}

/**
 * A deployment WITH a lakehouse.
 *
 * Load-bearing since #11417: `gap` and `miss` are told apart by whether one is
 * configured, so a suite running against an empty env would drive every decline
 * down the `miss` branch and never exercise the one that marks a payload.
 */
const CONFIGURED = { R2_SQL_TOKEN: "cfut_test" };

const load = (
  overrides: Parameters<typeof fakeEngine>[0] = {},
  options: Record<string, unknown> = {},
) => {
  const engine = fakeEngine(overrides);
  return {
    engine,
    result: loadChainEventRollup(CONFIGURED as never, CHAIN_SERVING_ROLLUP, {
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
    assert.deepEqual(result, { kind: "miss" });
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
      assert.deepEqual(result, { kind: "miss" });
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
    assert.deepEqual(await load({ rows: null }).result, { kind: "gap" });
  });

  test("a failed NETWORK query declines, rather than reporting zero servers", async () => {
    // The sharp one. Per-subnet rows plus a missing network block would render
    // real activity next to "0 distinct servers" — a contradiction that reads
    // as measured, not as a failure.
    assert.deepEqual(await load({ network: null }).result, { kind: "gap" });
  });

  test("an empty network result declines", async () => {
    assert.deepEqual(await load({ network: [] }).result, { kind: "gap" });
  });

  test("a window with no rows is EMPTY, which is a measurement and not a gap", async () => {
    // #11417. This used to return the same bare `null` as a failed query,
    // expressly so zeros would not be "published as measured silence" -- and the
    // caller published them anyway, because `null` could not say which kind of
    // nothing it was. `empty` is a successful read of a quiet window, so the
    // caller's zeros are CORRECT here and must carry no marker; calling it a
    // gap would be the same category error pointing the other way.
    assert.deepEqual(await load({ rows: [] }).result, { kind: "empty" });
  });

  test("the SAME failure with no lakehouse configured is a miss, not a gap", async () => {
    // The other half of the split, and why `gap` cannot simply be the default:
    // a self-hoster or a CI run has no rows to be wrong about, so its empty
    // payload is correct and marking it would report a fault that does not
    // exist in that deployment.
    const engine = fakeEngine({ rows: null });
    assert.deepEqual(
      await loadChainEventRollup({} as never, CHAIN_SERVING_ROLLUP, {
        windowDays: 7,
        now: NOW,
        query: engine.query,
      } as never),
      { kind: "miss" },
    );
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
    assert.deepEqual(result, { kind: "miss" });
    assert.deepEqual(engine.seen, [], "a refused kind must not reach SQL");
  });

  test("no caller can put a page size into the scan, malformed or not", async () => {
    // WAS "a malformed limit falls back to the default rather than reaching
    // SQL", which guarded the interpolation of a value that must no longer be
    // interpolated at all: the builders derive the network rollup and the
    // distribution from these rows, so a page-sized scan silently redefines both
    // (see ROLLUP_POPULATION_CAP for the live figures).
    //
    // `limit` is off the option type now, so this drives it through `as never`
    // the way a JS caller or a stale build could -- the guarantee is that even
    // then nothing but the population cap reaches the SQL.
    for (const limit of [Number.NaN, -1, 0, 20, 5_000_000, "20"]) {
      const engine = fakeEngine();
      await loadChainEventRollup({} as never, CHAIN_SERVING_ROLLUP, {
        windowDays: 7,
        now: NOW,
        limit,
        query: engine.query,
      } as never);
      assert.match(
        engine.rowsSql()!,
        new RegExp(`LIMIT ${ROLLUP_POPULATION_CAP}\\b`),
        `limit=${String(limit)} must not reach the scan`,
      );
    }
  });

  test("a clock that cannot produce a valid cutoff declines without querying", async () => {
    const { engine, result } = load({}, { now: 0 });
    assert.deepEqual(await result, { kind: "miss" });
    assert.deepEqual(engine.seen, [], "no query may run without a cutoff");
  });

  test("a non-positive window declines without querying", async () => {
    for (const windowDays of [0, -7, Number.NaN]) {
      const { engine, result } = load({}, { windowDays });
      assert.deepEqual(
        await result,
        { kind: "miss" },
        `windowDays=${windowDays}`,
      );
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
    assert.equal(engine.seen.length, 3, "every half must be queried");
    const rowsSql = engine.rowsSql()!;
    const networkSql = engine.networkSql()!;
    assert.match(rowsSql, /GROUP BY netuid/);
    assert.doesNotMatch(
      networkSql,
      /GROUP BY netuid/,
      "the network total must not be grouped per subnet, or it is a per-subnet count again",
    );
  });

  test("neither half uses COUNT(DISTINCT), at any window", async () => {
    // #9227: the single-level `count(DISTINCT x) ... GROUP BY netuid` form is
    // rejected by R2 SQL at 30d -- one of the two windows these routes offer --
    // with `40015: scan budget exceeded ... count(DISTINCT) with GROUP BY`, and
    // a rejection declines the whole rollup, so /chain/serving and
    // /chain/weights served an EMPTY 30d window while 7d worked. Adding a GROUP
    // BY is not the cure the message implies: that query already had one. The
    // budget is spent on the DISTINCT, so the only durable fix is to emit none.
    //
    // Asserted over EVERY spec, because the shape is the reader's, not one
    // route's -- and CI cannot catch a regression here any other way: the fake
    // engine below never executes the SQL, so a reintroduced COUNT(DISTINCT)
    // would pass every other assertion in this file and fail only in
    // production.
    for (const spec of [
      CHAIN_SERVING_ROLLUP,
      CHAIN_WEIGHTS_ROLLUP,
      CHAIN_REGISTRATIONS_ROLLUP,
    ]) {
      for (const windowDays of [7, 30]) {
        const engine = fakeEngine();
        await loadChainEventRollup({} as never, spec, {
          windowDays,
          now: NOW,
          query: engine.query,
        } as never);
        for (const sql of engine.seen) {
          assert.doesNotMatch(
            sql,
            /count\(DISTINCT/i,
            `${spec.eventKind} @${windowDays}d still emits COUNT(DISTINCT): ${sql}`,
          );
        }
      }
    }
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

  test("a hotkey-keyed network total groups by the hotkey ALONE", async () => {
    // A hotkey IS globally unique, so the pair form would be wrong here -- it
    // would count one hotkey once per subnet it serves on, turning a network
    // total into a sum of per-subnet counts. The uid form above must group by
    // the pair; this one must NOT. Same reason the old ungrouped
    // count(DISTINCT hotkey) was right about the semantics even though the
    // engine could no longer be trusted to run it: verified live, the grouped
    // form returns the identical 14,883 over a 90d AxonServed window.
    const engine = fakeEngine();
    await loadChainEventRollup({} as never, CHAIN_SERVING_ROLLUP, {
      windowDays: 7,
      now: NOW,
      query: engine.query,
    } as never);
    const networkSql = engine.networkSql()!;
    assert.match(networkSql, /GROUP BY hotkey/);
    assert.doesNotMatch(
      networkSql,
      /GROUP BY netuid/,
      "grouping a globally-unique identity per subnet counts it once per subnet",
    );
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
    // account_events is the read here that could pin a request open. The bound
    // is a safety bound and nothing else -- it is not a page size, and no
    // caller supplies it.
    const { engine, result } = load();
    await result;
    assert.match(
      engine.rowsSql()!,
      new RegExp(`LIMIT ${ROLLUP_POPULATION_CAP}\\b`),
      "the population cap must bound the scan",
    );
    assert.ok(
      ROLLUP_POPULATION_CAP >= 1000,
      "the cap must clear the ~129-subnet population by an order of magnitude",
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
    const rollup = answered(await result);
    assert.deepEqual(rollup.rows, [
      { netuid: 7, announcements: 9, distinct_servers: 4 },
    ]);
    assert.equal(rollup.networkDistinct.distinct_servers, 4);
    assert.equal(rollup.networkDistinct.newest_observed, NOW - 5);
  });

  test("the subnet count comes from its own query, not from the page", async () => {
    // #10249. `rows` used to be capped at the caller's page size, so counting it
    // answered "how big was the page" the moment the cap bound -- measured live,
    // /chain/weights published subnet_count 20 at ?limit=20 and 99 at ?limit=100
    // while the window covered 129. The page size is out of the scan now, but
    // this number keeps its own query: the safety cap can still bind in
    // principle, and a population must not be read off a bounded page. One row
    // here against a count of 12 is the whole point: the two numbers must be
    // allowed to disagree.
    const { result } = load({
      rows: [{ netuid: 7, announcements: 9, distinct_servers: 4 }],
      subnets: [{ subnet_count: 12 }],
    });
    const rollup = answered(await result);
    assert.equal(rollup.rows.length, 1);
    assert.equal(rollup.subnetCount, 12);
  });

  test("the subnet count emits no COUNT(DISTINCT), at any window", async () => {
    // The shape this module has routed around twice, and re-measured for
    // #10249: `count(DISTINCT netuid)` over the network block's derived table
    // LOOKS free -- same source scan -- and executes at 7d for the uid
    // identity. R2 SQL refuses it everywhere else (`40015: scan budget
    // exceeded ... for count(DISTINCT) without GROUP BY` on AxonServed at 7d
    // and 30d, on WeightsSet at 30d), because the budget is priced against the
    // SOURCE scan rather than the few thousand rows it would run over.
    for (const windowDays of [1, 7, 30, 90]) {
      const { engine, result } = load({}, { windowDays });
      await result;
      const sql = engine.subnetCountSql();
      assert.ok(sql, `no subnet-count query at ${windowDays}d`);
      assert.doesNotMatch(
        sql,
        /count\s*\(\s*distinct/i,
        `${windowDays}d reintroduced the shape the budget refuses`,
      );
      assert.match(sql, /GROUP BY netuid/);
    }
  });

  test("the two per-subnet queries require a subnet; the network one does not", async () => {
    // `account_events.netuid` is nullable and WeightsSet uses it. Visible from
    // outside on 2026-08-11 in /api/v1/chain/weights/setters, which publishes
    // `{"hotkey": null, "netuid": null, "uid": 0, "weight_sets": 633}` -- so
    // grouping by netuid produced a row no builder can attribute to a subnet.
    // Every builder here drops it, correctly, but it still spent a slot in the
    // page and a unit in the subnet count: /chain/weights?limit=N published N-1
    // subnets at every N, and ?limit=1 an entirely empty card beside a
    // subnet_count of 129.
    //
    // The NETWORK query must stay unfiltered. It counts distinct participants,
    // and a participant whose subnet the export did not record is still a
    // participant -- narrowing it would drop real ones to fix a per-subnet
    // problem.
    const { engine, result } = load();
    await result;
    assert.match(engine.rowsSql()!, /netuid IS NOT NULL/);
    assert.match(engine.subnetCountSql()!, /netuid IS NOT NULL/);
    assert.doesNotMatch(
      engine.networkSql()!,
      /netuid IS NOT NULL/,
      "the participant count is not a per-subnet question",
    );
  });

  test("a missing subnet count degrades to null, it does not decline", async () => {
    // The other two queries ARE the payload; this one refines a number that
    // already has an honest fallback. Blanking the card over it would trade a
    // slightly-wrong count for no card at all.
    const { result } = load({ subnets: null });
    const rollup = answered(await result);
    assert.equal(rollup.subnetCount, null);
  });
});

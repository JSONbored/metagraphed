// The shared chain-prometheus loader — the rung this route never had (#10248).
//
// /chain/prometheus resolved `tryPostgresTier(METAGRAPH_ACCOUNT_EVENTS_SOURCE)`
// and, on the miss that flag guarantees ("retired", one of the eight #10190
// counts), fell straight to the empty stub. Its axon twin has read the
// lakehouse rollup at that same point since #9216. So the card published a
// confident zero beside a live sibling, and no amount of curating the event
// stream could have changed it -- there was nothing wired to read the stream.
//
// These assert the properties that differ from "does it aggregate" (the rollup
// reader's own tests cover that): the rollup is asked for the RIGHT event kind,
// the window and limit are resolved ONCE, and a declining lakehouse yields null
// so each caller keeps its own fallback.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadChainPrometheusColdTier } from "../src/chain-prometheus-loader.ts";
import { CHAIN_PROMETHEUS_LIMIT_DEFAULT } from "../src/chain-prometheus.ts";

const ROWS = [
  { netuid: 7, announcements: 9, distinct_exporters: 4 },
  { netuid: 3, announcements: 2, distinct_exporters: 1 },
];
const NETWORK = [{ distinct_exporters: 5, newest_observed: 1_785_000_000_000 }];

function fakeEngine(
  overrides: {
    rows?: Record<string, unknown>[] | null;
    network?: Record<string, unknown>[] | null;
  } = {},
) {
  const seen: string[] = [];
  const pick = <T>(value: T | undefined, fallback: T) =>
    value === undefined ? fallback : value;
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    return sql.includes("ORDER BY")
      ? pick(overrides.rows, ROWS)
      : pick(overrides.network, NETWORK);
  };
  return { query, seen };
}

describe("the shared chain-prometheus loader", () => {
  test("asks the rollup for PrometheusServed, not its axon twin", async () => {
    // The twins share a pallet arm and a row shape, so a copy-paste that left
    // AxonServed in the spec would return plausible numbers for the wrong
    // event -- the failure this route is least able to survive again.
    const engine = fakeEngine();
    await loadChainPrometheusColdTier({} as never, {
      window: "7d",
      query: engine.query as never,
    });
    assert.ok(engine.seen.length > 0, "expected the rollup to be queried");
    for (const sql of engine.seen) {
      assert.match(sql, /event_kind = 'PrometheusServed'/);
      assert.doesNotMatch(sql, /AxonServed/);
    }
  });

  test("builds the response shape, not raw rollup rows", async () => {
    const engine = fakeEngine();
    const data = await loadChainPrometheusColdTier({} as never, {
      window: "7d",
      query: engine.query as never,
    });
    assert.ok(data);
    assert.equal(data.window, "7d");
    assert.equal(Array.isArray(data.subnets), true);
    // The whole point: a real read is NOT marked degraded. The marker exists
    // for the empty answer, and an empty answer is no longer the only one.
    assert.equal(data.degraded, undefined);
  });

  test("subnet_count is the WINDOW's count, not the returned page", async () => {
    // Without the builder's `subnetCount`, a limit of 1 would publish
    // `subnet_count: 1` for a window covering two -- a truncation reported as
    // a measurement. buildChainServing has carried this parameter; its twin
    // did not, which is the drift this closes.
    const engine = fakeEngine();
    const data = await loadChainPrometheusColdTier({} as never, {
      window: "7d",
      limit: 1,
      query: engine.query as never,
    });
    assert.ok(data);
    assert.equal(data.subnets.length, 1, "the page is capped");
    assert.equal(data.subnet_count, 2, "the count is the window's");
  });

  test("an unrecognised window narrows the SCAN and the LABEL together", async () => {
    // #9239 on the serving side: the scan fell back to 7d while the caller's
    // original string still reached the builder, so the card misdescribed data
    // that was itself correct.
    const engine = fakeEngine();
    const data = await loadChainPrometheusColdTier({} as never, {
      window: "not-a-window",
      query: engine.query as never,
    });
    assert.ok(data);
    assert.notEqual(data.window, "not-a-window");
  });

  test("an omitted limit resolves once, so the scan cannot outrun the response", async () => {
    // The rollup reader caps at 200 and the builder at 20; left to their own
    // defaults an omitted limit scans ten times the rows the card can carry.
    const engine = fakeEngine();
    await loadChainPrometheusColdTier({} as never, {
      window: "7d",
      query: engine.query as never,
    });
    const ordered = engine.seen.find((s) => s.includes("ORDER BY"));
    assert.ok(ordered);
    assert.match(
      ordered,
      new RegExp(`LIMIT ${CHAIN_PROMETHEUS_LIMIT_DEFAULT}\\b`),
    );
  });

  test("a declining lakehouse is null, never a zeroed card", async () => {
    // Each caller keeps its own fallback and error contract -- GraphQL answers
    // a schema-stable card rather than an error, and that belongs at the call
    // site, not here.
    const engine = fakeEngine({ rows: null, network: null });
    const data = await loadChainPrometheusColdTier({} as never, {
      window: "7d",
      query: engine.query as never,
    });
    assert.equal(data, null);
  });
});

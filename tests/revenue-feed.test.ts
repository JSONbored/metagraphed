// #10480: the revenue feed's items.
//
// The wording is the deliverable here, not the arithmetic. A "surface went
// dark" item is read by people who will draw a conclusion about an operator
// from it, so the tests assert what the text may NOT say as hard as what it
// must: no reason is named, our own error is offered as a live possibility, and
// a subnet that simply stopped being readable is never rendered as a subnet
// that stopped earning.
//
// The other half is the refusals. An item must not be emitted from an absence
// -- an unpriced endpoint, a recovered surface, a dust-sized prior figure --
// because a number-shaped event over a gap is a claim nobody made.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  RATIO_MOVE_THRESHOLD,
  loadRevenueFeedItems,
  revenueFeedItems,
  type RevenueDenominatorPoint,
  type RevenueObservationRow,
  type RevenueProbeFailureRow,
} from "../src/revenue-feed.ts";
import { handleFeedRequest } from "../src/feeds.ts";
import { resolveRevenueFeedItems } from "../workers/api.ts";
import { REVENUE_FEED_TABLES } from "../src/read-store-tables.ts";
import { mockEnv } from "./row-type.ts";

const NOW = Date.parse("2026-08-10T00:00:00Z");
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

function observation(
  over: Partial<RevenueObservationRow> = {},
): RevenueObservationRow {
  return {
    surface_id: "sn-64-chutes-daily-revenue-summary",
    netuid: 64,
    period: "2026-08-09",
    grain: "daily",
    amount: 1000,
    currency: "USD",
    provenance: "probe-derived",
    observed_at: day(1),
    ...over,
  };
}

function failure(
  over: Partial<RevenueProbeFailureRow> = {},
): RevenueProbeFailureRow {
  return {
    surface_id: "sn-64-chutes-daily-revenue-summary",
    netuid: 64,
    reason: "http_404",
    observed_at: day(0),
    ...over,
  };
}

const items = (
  observations: RevenueObservationRow[],
  failures: RevenueProbeFailureRow[] = [],
  denominators?: Map<string, RevenueDenominatorPoint>,
) => revenueFeedItems({ observations, failures, denominators, now: NOW });

describe("a revenue surface that goes dark", () => {
  test("is an item, dated, carrying the last figure it did return", () => {
    const [item] = items([observation()], [failure()]);
    assert.ok(item);
    assert.deepEqual(item.tags, ["revenue", "surface-dark"]);
    assert.equal(item.timestamp, day(0));
    assert.match(item.summary, /\$1,000/, "the last readable figure");
    assert.match(item.summary, /2026-08-09/, "the period it was for");
  });

  test("names no reason, and offers our own error as one", () => {
    // The highest-blast-radius wording in either epic. An operator withdrawing
    // an unflattering figure and an endpoint that moved are indistinguishable
    // from here, and the item must not pick.
    const [item] = items([observation()], [failure()]);
    assert.match(item.summary, /asserts nothing about why/);
    assert.match(item.summary, /misread by us/);
    assert.doesNotMatch(
      item.summary,
      /withdrew|removed it|hiding|concealed|refus/i,
      "no item may characterise an operator's action",
    );
  });

  test("says the feed stopping is not the subnet stopping", () => {
    const [item] = items([observation()], [failure()]);
    assert.match(item.summary, /not a subnet that stopped earning/);
  });

  test("is NOT emitted when the surface recovered", () => {
    // Newest reading is an observation, not the failure. A surface that failed
    // once and is answering again would otherwise carry a withdrawal notice.
    const out = items(
      [observation({ observed_at: day(0) })],
      [failure({ observed_at: day(1) })],
    );
    assert.equal(out.filter((i) => i.tags.includes("surface-dark")).length, 0);
  });

  test("a surface that NEVER answered is a different item", () => {
    // "Stopped returning a figure" would be false: it never returned one. That
    // is a statement about our reader, not about a withdrawal.
    const [item] = items([], [failure()]);
    assert.deepEqual(item.tags, ["revenue", "surface-unreadable"]);
    assert.match(item.summary, /has never returned a figure/);
    assert.match(item.summary, /not about whether the subnet earns anything/);
  });

  test("a failure older than the window is not news", () => {
    assert.deepEqual(items([], [failure({ observed_at: day(120) })]), []);
  });
});

describe("provenance changes", () => {
  test("are reported when the ladder rung changes", () => {
    const [item] = items([
      observation({ period: "2026-08-09", provenance: "probe-derived" }),
      observation({
        period: "2026-08-08",
        provenance: "operator-attested",
        observed_at: day(2),
      }),
    ]).filter((i) => i.tags.includes("provenance"));
    assert.ok(item);
    assert.deepEqual(item.tags, ["revenue", "provenance"]);
    assert.match(item.summary, /operator-attested.+probe-derived/s);
  });

  test("are reported DOWNWARD too", () => {
    // A downgrade weakens every figure derived from the surface. Publishing
    // only upgrades would make the ladder look like it only ever improves.
    const [item] = items([
      observation({ period: "2026-08-09", provenance: "operator-attested" }),
      observation({
        period: "2026-08-08",
        provenance: "probe-derived",
        observed_at: day(2),
      }),
    ]).filter((i) => i.tags.includes("provenance"));
    assert.ok(item);
    assert.match(item.title, /changed to operator-attested/);
  });

  test("an unchanged provenance is not an event", () => {
    const out = items([
      observation({ period: "2026-08-09" }),
      observation({ period: "2026-08-08", observed_at: day(2) }),
    ]);
    assert.equal(
      out.filter((i) => i.tags.includes("provenance")).length,
      0,
      "two readings at the same rung are not a change",
    );
  });
});

describe("a newly readable surface", () => {
  test("is an item, and describes what changed as OUR reach", () => {
    const [item] = items([observation()]);
    assert.deepEqual(item.tags, ["revenue", "surface-new"]);
    assert.match(item.summary, /changes what we can say about this subnet/);
    assert.doesNotMatch(item.summary, /started earning|new revenue stream/i);
  });

  test("an old surface is not newly readable", () => {
    const out = items([observation({ observed_at: day(200) })]);
    assert.equal(out.filter((i) => i.tags.includes("surface-new")).length, 0);
  });
});

describe("a material coverage-ratio move", () => {
  const denominators = new Map<string, RevenueDenominatorPoint>([
    ["64:2026-08-09", { tao_total: 10, usd_per_tao: 200 }],
    ["64:2026-08-08", { tao_total: 10, usd_per_tao: 200 }],
  ]);
  const pair = [
    observation({ period: "2026-08-09", amount: 2000 }),
    observation({ period: "2026-08-08", amount: 1000, observed_at: day(2) }),
  ];

  test("reports both endpoints and both sides of the ratio", () => {
    const [item] = items(pair, [], denominators).filter((i) =>
      i.tags.includes("coverage-move"),
    );
    assert.ok(item);
    assert.match(item.title, /rose to 100\.0%/);
    assert.match(
      item.summary,
      /50\.0% \(2026-08-08\) to 100\.0% \(2026-08-09\)/,
    );
    // Emission is stated too: a reader must be able to see which side moved.
    assert.match(item.summary, /against emission of/);
  });

  test("refuses to attribute the move to any one side", () => {
    const [item] = items(pair, [], denominators).filter((i) =>
      i.tags.includes("coverage-move"),
    );
    assert.match(item.summary, /does not attribute it to any of them/);
    assert.match(item.summary, /not an accusation/);
  });

  test("is NOT emitted when an endpoint is unpriced", () => {
    // "The ratio moved to unknown" is a gap, not a movement.
    const half = new Map([...denominators].slice(0, 1));
    const out = items(pair, [], half);
    assert.equal(out.filter((i) => i.tags.includes("coverage-move")).length, 0);
  });

  test("is NOT emitted with no denominators at all", () => {
    const out = items(pair);
    assert.equal(out.filter((i) => i.tags.includes("coverage-move")).length, 0);
  });

  test("a move under the threshold is not an event", () => {
    const small = [
      observation({
        period: "2026-08-09",
        amount: 1000 * (1 + RATIO_MOVE_THRESHOLD / 2),
      }),
      observation({ period: "2026-08-08", amount: 1000, observed_at: day(2) }),
    ];
    const out = items(small, [], denominators);
    assert.equal(out.filter((i) => i.tags.includes("coverage-move")).length, 0);
  });

  test("a dust-sized prior figure produces no percentage", () => {
    // A 1000x move off $0.02 is arithmetic, not information.
    const dust = [
      observation({ period: "2026-08-09", amount: 20 }),
      observation({ period: "2026-08-08", amount: 0.02, observed_at: day(2) }),
    ];
    const out = items(dust, [], denominators);
    assert.equal(out.filter((i) => i.tags.includes("coverage-move")).length, 0);
  });

  test("a zero-emission day has no ratio, not an infinite one", () => {
    const zero = new Map<string, RevenueDenominatorPoint>([
      ["64:2026-08-09", { tao_total: 0, usd_per_tao: 200 }],
      ["64:2026-08-08", { tao_total: 10, usd_per_tao: 200 }],
    ]);
    const out = items(pair, [], zero);
    assert.equal(out.filter((i) => i.tags.includes("coverage-move")).length, 0);
  });
});

/** A statement client over fixed result sets, keyed by the table each query
 * names. Deliberately not a full SQL engine: what is under test is which reads
 * happen and how their absence degrades, not the SQL itself. */
function storeDouble(
  tables: Record<string, unknown[] | Error>,
): Parameters<typeof loadRevenueFeedItems>[0] {
  const resolve = (sql: string) => {
    const name = Object.keys(tables).find((t) => sql.includes(t));
    const value = name ? tables[name] : [];
    if (value instanceof Error) throw value;
    return { results: value ?? [] };
  };
  return {
    prepare(sql: string) {
      return {
        bind: () => ({ all: async () => resolve(sql) }),
        all: async () => resolve(sql),
      };
    },
  };
}

const STORE_OBS = {
  surface_id: "sn-64-x",
  netuid: 64,
  period: "2026-08-09",
  grain: "daily",
  amount: 1000,
  currency: "USD",
  provenance: "probe-derived",
  observed_at: NOW - 86_400_000,
};

describe("the store read", () => {
  const OBS = [STORE_OBS];

  test("builds items from epoch-ms timestamps", async () => {
    const out = await loadRevenueFeedItems(
      storeDouble({
        revenue_probe_failures: [],
        revenue_observations: OBS,
        subnet_snapshots: [],
        tao_usd_index: [],
      }),
      { now: NOW },
    );
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].tags, ["revenue", "surface-new"]);
    assert.equal(out[0].timestamp, day(1));
  });

  test("no store binding is no items, never an error", async () => {
    assert.deepEqual(await loadRevenueFeedItems(null, { now: NOW }), []);
    assert.deepEqual(await loadRevenueFeedItems(undefined, {}), []);
  });

  test("an unreadable observations table yields no items", async () => {
    // Both reads fail. An empty feed derived from a broken store would read as
    // "nothing moved", so the loader must not manufacture one.
    const out = await loadRevenueFeedItems(
      storeDouble({ revenue: new Error("relation does not exist") }),
      { now: NOW },
    );
    assert.deepEqual(out, []);
  });

  test("an unreadable denominator leg keeps the dark-surface items", async () => {
    // The ordering of value this lane was built for: losing the ratio items
    // must not lose the item that says a surface stopped answering.
    const out = await loadRevenueFeedItems(
      storeDouble({
        revenue_probe_failures: [
          {
            surface_id: "sn-64-x",
            netuid: 64,
            reason: "http_404",
            observed_at: NOW,
          },
        ],
        revenue_observations: OBS,
        subnet_snapshots: new Error("store unavailable"),
        tao_usd_index: [],
      }),
      { now: NOW },
    );
    assert.ok(
      out.some((i) => i.tags.includes("surface-dark")),
      "the dark item survives a denominator failure",
    );
    assert.equal(out.filter((i) => i.tags.includes("coverage-move")).length, 0);
  });

  test("prices the denominator from the day's latest reading", async () => {
    const out = await loadRevenueFeedItems(
      storeDouble({
        revenue_probe_failures: [],
        revenue_observations: [
          { ...OBS[0], period: "2026-08-09", amount: 2000 },
          {
            ...OBS[0],
            period: "2026-08-08",
            amount: 1000,
            observed_at: NOW - 2 * 86_400_000,
          },
        ],
        subnet_snapshots: [
          {
            netuid: 64,
            snapshot_date: "2026-08-09",
            tao_in_emission_tao: 8,
            excess_tao: 2,
          },
          {
            netuid: 64,
            snapshot_date: "2026-08-08",
            tao_in_emission_tao: 8,
            excess_tao: 2,
          },
        ],
        tao_usd_index: [
          { observed_at: Date.parse("2026-08-09T23:00:00Z"), usd_per_tao: 200 },
          // Earlier the same day: must NOT win, and must not be averaged in --
          // an average is a price nobody observed.
          { observed_at: Date.parse("2026-08-09T01:00:00Z"), usd_per_tao: 999 },
          { observed_at: Date.parse("2026-08-08T23:00:00Z"), usd_per_tao: 200 },
        ],
      }),
      { now: NOW },
    );
    const move = out.find((i) => i.tags.includes("coverage-move"));
    assert.ok(move, "both endpoints priced, so the move is emitted");
    assert.match(move.title, /rose to 100\.0%/);
  });

  test("a snapshot missing its excess leg is skipped, not summed as zero", async () => {
    // An unread excess is not a zero excess; treating it as one understates
    // the denominator and overstates every ratio built on it.
    const out = await loadRevenueFeedItems(
      storeDouble({
        revenue_probe_failures: [],
        revenue_observations: [
          { ...OBS[0], period: "2026-08-09", amount: 2000 },
          {
            ...OBS[0],
            period: "2026-08-08",
            amount: 1000,
            observed_at: NOW - 2 * 86_400_000,
          },
        ],
        subnet_snapshots: [
          {
            netuid: 64,
            snapshot_date: "2026-08-09",
            tao_in_emission_tao: 8,
            excess_tao: null,
          },
          {
            netuid: 64,
            snapshot_date: "2026-08-08",
            tao_in_emission_tao: 8,
            excess_tao: 2,
          },
        ],
        tao_usd_index: [
          { observed_at: Date.parse("2026-08-09T23:00:00Z"), usd_per_tao: 200 },
          { observed_at: Date.parse("2026-08-08T23:00:00Z"), usd_per_tao: 200 },
        ],
      }),
      { now: NOW },
    );
    assert.equal(out.filter((i) => i.tags.includes("coverage-move")).length, 0);
  });

  test("observations with no netuid produce no denominator lookup", async () => {
    const out = await loadRevenueFeedItems(
      storeDouble({
        revenue_probe_failures: [],
        revenue_observations: [{ ...OBS[0], netuid: null }],
        subnet_snapshots: [],
        tao_usd_index: [],
      }),
      { now: NOW },
    );
    assert.equal(out.length, 1);
    assert.match(out[0].title, /an unattributed surface/);
  });
});

// ── the wiring ──────────────────────────────────────────────────────────────
//
// The item builder above is pure. What is only reachable from here is that the
// items actually REACH a subscriber: on their own feed, folded into the
// site-wide one, and narrowable by tag. And that an unreadable store costs this
// feed its items rather than 500ing the registry feed it sits inside.

const FEED_ITEM = {
  id: "revenue-surface-dark:sn-64-x:2026-08-10T00:00:00.000Z",
  url: "https://metagraph.sh/subnets/64",
  title: "Subnet 64 — revenue surface stopped returning a figure",
  summary: "…",
  timestamp: "2026-08-10T00:00:00.000Z",
  tags: ["revenue", "surface-dark"],
};

async function feed(path: string, loadRevenueFeed?: () => Promise<unknown>) {
  const url = new URL(`https://api.metagraph.sh${path}`);
  const res = await handleFeedRequest(new Request(url), mockEnv(), url, {
    readArtifact: async () => ({ ok: false, status: 404 }) as never,
    loadRevenueFeed: loadRevenueFeed as never,
  });
  return { res, body: await res.text() };
}

describe("GET /api/v1/feeds/revenue", () => {
  test("serves the items on their own feed", async () => {
    const { res, body } = await feed("/api/v1/feeds/revenue.json", async () => [
      FEED_ITEM,
    ]);
    assert.equal(res.status, 200);
    const json = JSON.parse(body);
    assert.equal(json.items.length, 1);
    assert.match(json.description, /never why/);
  });

  test("is folded into the registry feed and narrows by tag", async () => {
    // A subscriber already on the site-wide feed learns a surface went dark
    // without adding a second URL -- the same contract the upgrade items have.
    const { body } = await feed(
      "/api/v1/feeds/registry.json?tag=revenue",
      async () => [FEED_ITEM],
    );
    const json = JSON.parse(body);
    assert.equal(json.items.length, 1);
    assert.equal(json.items[0].id, FEED_ITEM.id);
  });

  test("a store that throws costs the items, never the feed", async () => {
    // The registry feed must not 500 because a Postgres read blipped.
    const { res, body } = await feed(
      "/api/v1/feeds/registry.json",
      async () => {
        throw new Error("store unavailable");
      },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(body).items, []);
  });

  test("no injected loader is an empty feed, not an error", async () => {
    const { res, body } = await feed("/api/v1/feeds/revenue.json");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(body).items, []);
  });

  test("a loader returning a non-array is ignored, not spread", async () => {
    const { res, body } = await feed(
      "/api/v1/feeds/revenue.json",
      async () => null,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(body).items, []);
  });

  test("the 404 for an unknown feed names this one", async () => {
    const { res, body } = await feed("/api/v1/feeds/nope.json");
    assert.equal(res.status, 404);
    assert.match(body, /\/api\/v1\/feeds\/revenue/);
  });
});

describe("resolveRevenueFeedItems", () => {
  test("no Hyperdrive binding is no items, never a throw", async () => {
    assert.deepEqual(await resolveRevenueFeedItems(mockEnv() as never), []);
  });

  test("closes the connection after the read", async () => {
    // A per-request producer connection that is not closed leaks one socket per
    // feed hit. The close goes through waitUntil, so the read still returns.
    const waited: Promise<unknown>[] = [];
    const env = mockEnv({
      HYPERDRIVE: { connectionString: "postgres://example.invalid/db" },
      NEON_SOLE_STORE_TABLES: REVENUE_FEED_TABLES.join(","),
    });
    const out = await resolveRevenueFeedItems(env as never, {
      waitUntil: (p) => void waited.push(p),
    });
    assert.deepEqual(out, [], "an unreachable store yields no items");
    assert.ok(waited.length > 0, "the connection close was scheduled");
    await Promise.allSettled(waited);
  });
});

// ── degenerate rows ─────────────────────────────────────────────────────────
//
// Every field below arrives from a Postgres row, and Postgres hands back NULL
// for anything unset and a numeric STRING for a BIGINT. Each case here is a
// shape the store can really produce, and the assertion is that it degrades to
// an absent field rather than to a fabricated one.

describe("rows the store can really produce", () => {
  test("a BIGINT timestamp arrives as a numeric string and still parses", async () => {
    // The form the pg driver actually returns. Parsed as a year, it would be
    // NaN and the whole feed would go silent against a full table.
    const out = await loadRevenueFeedItems(
      storeDouble({
        revenue_probe_failures: [],
        revenue_observations: [
          { ...STORE_OBS, observed_at: String(NOW - 86_400_000) },
        ],
        subnet_snapshots: [],
        tao_usd_index: [],
      }),
      { now: NOW },
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].timestamp, day(1));
  });

  test("a row with no surface_id is skipped rather than keyed on empty", async () => {
    const out = await loadRevenueFeedItems(
      storeDouble({
        revenue_probe_failures: [{ surface_id: null, observed_at: NOW }],
        revenue_observations: [{ ...STORE_OBS, surface_id: null }],
        subnet_snapshots: [],
        tao_usd_index: [],
      }),
      { now: NOW },
    );
    assert.deepEqual(out, []);
  });

  test("null grain, currency, provenance and period degrade to absent", async () => {
    const out = await loadRevenueFeedItems(
      storeDouble({
        revenue_probe_failures: [],
        revenue_observations: [
          {
            surface_id: "sn-64-x",
            netuid: null,
            period: null,
            grain: null,
            amount: 1000,
            currency: null,
            provenance: null,
            observed_at: NOW - 86_400_000,
          },
        ],
        subnet_snapshots: [],
        tao_usd_index: [],
      }),
      { now: NOW },
    );
    assert.equal(out.length, 1);
    assert.match(out[0].summary, /Provenance is `unrecorded`/);
    assert.doesNotMatch(out[0].summary, /\(null\)|undefined/);
  });

  test("an undated observation is not dropped, it sorts last", () => {
    // It is still evidence the surface answered; only its position is unknown.
    const out = items(
      [
        observation({ observed_at: null }),
        observation({ observed_at: day(1) }),
      ],
      [failure()],
    );
    const dark = out.find((i) => i.tags.includes("surface-dark"));
    assert.ok(dark);
    assert.match(dark.summary, /2026-08-09/);
  });

  test("a dark item with no dated last-good says so rather than inventing one", () => {
    const out = items(
      [observation({ observed_at: null, amount: Number.NaN })],
      [failure()],
    );
    const dark = out.find((i) => i.tags.includes("surface-dark"));
    assert.ok(dark);
    assert.match(dark.summary, /an unrecorded date/);
    assert.doesNotMatch(dark.summary, /\$NaN/);
  });

  test("a failure with no netuid borrows the observation's, not a guess", () => {
    const out = items(
      [observation({ netuid: 64 })],
      [failure({ netuid: null, observed_at: day(0) })],
    );
    const dark = out.find((i) => i.tags.includes("surface-dark"));
    assert.match(dark!.title, /Subnet 64/);
  });

  test("a provenance change older than the window is not news", () => {
    const out = items([
      observation({ provenance: "probe-derived", observed_at: day(200) }),
      observation({ provenance: "operator-attested", observed_at: day(300) }),
    ]);
    assert.equal(out.filter((i) => i.tags.includes("provenance")).length, 0);
  });

  test("a ratio that FELL says fell", () => {
    const d = new Map([
      ["64:2026-08-09", { tao_total: 10, usd_per_tao: 200 }],
      ["64:2026-08-08", { tao_total: 10, usd_per_tao: 200 }],
    ]);
    const [item] = items(
      [
        observation({ period: "2026-08-09", amount: 1000 }),
        observation({
          period: "2026-08-08",
          amount: 2000,
          observed_at: day(2),
        }),
      ],
      [],
      d,
    ).filter((i) => i.tags.includes("coverage-move"));
    assert.match(item.title, /fell to 50\.0%/);
  });

  test("an unattributed observation is never keyed to a subnet", () => {
    const d = new Map([[":2026-08-09", { tao_total: 10, usd_per_tao: 200 }]]);
    const out = items(
      [
        observation({ netuid: null, period: "2026-08-09", amount: 2000 }),
        observation({
          netuid: null,
          period: "2026-08-08",
          amount: 1000,
          observed_at: day(2),
        }),
      ],
      [],
      d,
    );
    // The second endpoint is unpriced, so no ratio item -- and the surface-new
    // item names no subnet rather than defaulting to one.
    assert.equal(out.filter((i) => i.tags.includes("coverage-move")).length, 0);
    assert.match(out[0].url, /\/subnets$/);
  });

  test("two readings of the same period do not order arbitrarily", () => {
    // Equal periods: the comparator returns 0 rather than flapping, so the
    // ratio item is deterministic across runs.
    const d = new Map([["64:2026-08-09", { tao_total: 10, usd_per_tao: 200 }]]);
    const out = items(
      [
        observation({ period: "2026-08-09", amount: 2000 }),
        observation({
          period: "2026-08-09",
          amount: 2000,
          observed_at: day(2),
        }),
      ],
      [],
      d,
    );
    assert.equal(out.filter((i) => i.tags.includes("coverage-move")).length, 0);
  });

  test("a non-numeric emission leg is unread, not zero", async () => {
    const out = await loadRevenueFeedItems(
      storeDouble({
        revenue_probe_failures: [],
        revenue_observations: [
          { ...STORE_OBS, period: "2026-08-09", amount: 2000 },
          {
            ...STORE_OBS,
            period: "2026-08-08",
            amount: 1000,
            observed_at: NOW - 2 * 86_400_000,
          },
        ],
        subnet_snapshots: [
          {
            netuid: 64,
            snapshot_date: "2026-08-09",
            tao_in_emission_tao: "not a number",
            excess_tao: 2,
          },
          {
            netuid: 64,
            snapshot_date: null,
            tao_in_emission_tao: 8,
            excess_tao: 2,
          },
        ],
        tao_usd_index: [
          { observed_at: Date.parse("2026-08-09T23:00:00Z"), usd_per_tao: 200 },
          // Unpriced and undated rows: both skipped, neither defaulted.
          {
            observed_at: Date.parse("2026-08-08T23:00:00Z"),
            usd_per_tao: null,
          },
          { observed_at: null, usd_per_tao: 200 },
          { observed_at: Date.parse("2026-08-07T23:00:00Z"), usd_per_tao: 0 },
        ],
      }),
      { now: NOW },
    );
    assert.equal(out.filter((i) => i.tags.includes("coverage-move")).length, 0);
  });

  test("a driver returning no results key is an empty read, not a crash", async () => {
    const out = await loadRevenueFeedItems(
      {
        prepare: () => ({
          bind: () => ({ all: async () => ({}) }),
          all: async () => ({}),
        }),
      },
      { now: NOW },
    );
    assert.deepEqual(out, []);
  });

  test("failures readable while observations are not still reports", async () => {
    // The half-degraded case: the dark-surface signal survives even when the
    // observation read is the leg that failed.
    const out = await loadRevenueFeedItems(
      storeDouble({
        revenue_observations: new Error("relation does not exist"),
        revenue_probe_failures: [
          { surface_id: "sn-64-x", netuid: 64, reason: null, observed_at: NOW },
        ],
        subnet_snapshots: [],
        tao_usd_index: [],
      }),
      { now: NOW },
    );
    assert.equal(out.length, 1);
    assert.ok(out[0].tags.includes("surface-unreadable"));
  });

  test("an overflowing epoch string is unparseable, not a date", () => {
    const out = items([observation({ observed_at: "9".repeat(400) })]);
    assert.equal(out.filter((i) => i.tags.includes("surface-new")).length, 0);
  });

  test("defaults to now and a 30-day window when neither is given", () => {
    // The production call passes neither. A default that read as epoch zero
    // would put every item outside the window and serve an empty feed forever.
    const out = revenueFeedItems({
      observations: [
        {
          surface_id: "sn-64-x",
          netuid: 64,
          period: "2026-08-09",
          grain: "daily",
          amount: 1000,
          currency: "USD",
          provenance: "probe-derived",
          observed_at: new Date().toISOString(),
        },
      ],
      failures: [],
    });
    assert.equal(out.length, 1);
  });
});

describe("the last of the degenerate shapes", () => {
  test("a NULL observed_at column is undated, not epoch zero", async () => {
    const out = await loadRevenueFeedItems(
      storeDouble({
        revenue_probe_failures: [],
        revenue_observations: [{ ...STORE_OBS, observed_at: null }],
        subnet_snapshots: [],
        tao_usd_index: [],
      }),
      { now: NOW },
    );
    // Undated means it cannot be placed in the window, so it is no longer
    // "newly readable" -- but it must not become 1970 and flood the feed.
    assert.deepEqual(out, []);
  });

  test("a corrupt numeric timestamp is undated, not a date in year 275760", async () => {
    const out = await loadRevenueFeedItems(
      storeDouble({
        revenue_probe_failures: [],
        revenue_observations: [{ ...STORE_OBS, observed_at: Number.NaN }],
        subnet_snapshots: [],
        tao_usd_index: [],
      }),
      { now: NOW },
    );
    assert.deepEqual(out, []);
  });

  test("an undated row sorts after a dated one whichever way round it arrives", () => {
    const out = items(
      [
        observation({ observed_at: day(1) }),
        observation({ observed_at: null }),
      ],
      [failure()],
    );
    const dark = out.find((i) => i.tags.includes("surface-dark"));
    assert.match(dark!.summary, /2026-08-09/);
  });

  test("a dark surface with no netuid anywhere names no subnet", () => {
    const out = items(
      [observation({ netuid: null })],
      [failure({ netuid: null })],
    );
    const dark = out.find((i) => i.tags.includes("surface-dark"));
    assert.match(dark!.title, /an unattributed surface/);
    assert.match(dark!.url, /\/subnets$/);
  });

  test("a provenance change on an unattributed surface names no subnet", () => {
    const [item] = items([
      observation({ netuid: null, provenance: "probe-derived" }),
      observation({
        netuid: null,
        provenance: "operator-attested",
        observed_at: day(2),
      }),
    ]).filter((i) => i.tags.includes("provenance"));
    assert.match(item.title, /an unattributed surface/);
    assert.match(item.url, /\/subnets$/);
  });

  test("a coverage move on an unattributed surface names no subnet", () => {
    const d = new Map([
      [":2026-08-09", { tao_total: 10, usd_per_tao: 200 }],
      [":2026-08-08", { tao_total: 10, usd_per_tao: 200 }],
    ]);
    const [item] = items(
      [
        observation({ netuid: null, period: "2026-08-09", amount: 2000 }),
        observation({
          netuid: null,
          period: "2026-08-08",
          amount: 1000,
          observed_at: day(2),
        }),
      ],
      [],
      d,
    ).filter((i) => i.tags.includes("coverage-move"));
    assert.ok(item);
    assert.match(item.title, /an unattributed surface/);
  });

  test("periods arriving oldest-first still compare newest against previous", () => {
    // The store orders by observed_at, not by period, so the rows can arrive
    // either way round. Comparing the wrong pair would invert every move.
    const d = new Map([
      ["64:2026-08-09", { tao_total: 10, usd_per_tao: 200 }],
      ["64:2026-08-08", { tao_total: 10, usd_per_tao: 200 }],
    ]);
    const [item] = items(
      [
        observation({
          period: "2026-08-08",
          amount: 1000,
          observed_at: day(2),
        }),
        observation({ period: "2026-08-09", amount: 2000 }),
      ],
      [],
      d,
    ).filter((i) => i.tags.includes("coverage-move"));
    assert.match(item.title, /rose to 100\.0%/);
  });

  test("an unreadable failures table keeps the observation items", async () => {
    const out = await loadRevenueFeedItems(
      storeDouble({
        revenue_probe_failures: new Error("relation does not exist"),
        revenue_observations: [STORE_OBS],
        subnet_snapshots: [],
        tao_usd_index: [],
      }),
      { now: NOW },
    );
    assert.equal(out.length, 1);
    assert.ok(out[0].tags.includes("surface-new"));
  });

  test("an unreadable price index suppresses ratios but keeps the rest", () => {
    // The two denominator legs fail independently. A price read that failed is
    // not a price of zero, so no endpoint may be priced from the other leg
    // alone -- but the dark-surface item does not depend on either.
    return loadRevenueFeedItems(
      storeDouble({
        revenue_probe_failures: [
          {
            surface_id: "sn-64-x",
            netuid: 64,
            reason: "http_404",
            observed_at: NOW,
          },
        ],
        revenue_observations: [
          { ...STORE_OBS, period: "2026-08-09", amount: 2000 },
          {
            ...STORE_OBS,
            period: "2026-08-08",
            amount: 1000,
            observed_at: NOW - 2 * 86_400_000,
          },
        ],
        subnet_snapshots: [
          {
            netuid: 64,
            snapshot_date: "2026-08-09",
            tao_in_emission_tao: 8,
            excess_tao: 2,
          },
        ],
        tao_usd_index: new Error("store unavailable"),
      }),
      { now: NOW },
    ).then((out) => {
      assert.ok(out.some((i) => i.tags.includes("surface-dark")));
      assert.equal(
        out.filter((i) => i.tags.includes("coverage-move")).length,
        0,
      );
    });
  });
});

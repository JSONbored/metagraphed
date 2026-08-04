// The shared cold tier for every per-subnet account_events summary card (#9369).
//
// #9368 fixed one of these after finding it served a confident 0 for every subnet.
// Probing the family the same way found four more. Measured live 2026-08-04:
//
//   family            chain-wide                          /subnets/64/…
//   serving           3,036 servers over 20 subnets       0
//   stake-moves         674 movers  over 128 subnets      0
//   stake-transfers     430 senders / 12,168 over 126     0
//   registrations     6,317 registrants / 8,055 over 98   0
//
// The two properties that make a wrong answer here look right are the netuid filter and
// reading window totals rather than a capped page — both pinned below, per family, so a
// regression names which one broke.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadSubnetEventCardColdTier } from "../src/subnet-event-card-loader.ts";
import {
  CHAIN_REGISTRATIONS_ROLLUP,
  CHAIN_SERVING_ROLLUP,
  CHAIN_STAKE_MOVES_ROLLUP,
  CHAIN_STAKE_TRANSFERS_ROLLUP,
} from "../src/chain-event-rollup-cold-tier.ts";
import { buildSubnetServing } from "../src/subnet-serving.ts";
import { buildSubnetStakeMoves } from "../src/subnet-stake-moves.ts";
import { buildSubnetStakeTransfers } from "../src/subnet-stake-transfers.ts";
import { buildSubnetRegistrations } from "../src/subnet-registrations.ts";

type Row = Record<string, unknown>;

// Page rows sum to 50; totals are deliberately far larger, so a card summed from the
// capped page is visibly wrong rather than plausibly small.
const ROWS = [
  { netuid: 7, hotkey: "5A", count: 40 },
  { netuid: 7, hotkey: "5B", count: 10 },
];

function fakeEngine(
  totals: Row,
  distinct: Row,
  overrides: {
    rows?: Row[] | null;
    totals?: Row[] | null;
    distinct?: Row[] | null;
  } = {},
) {
  const seen: string[] = [];
  const pick = <T>(v: T | undefined, fallback: T) =>
    v === undefined ? fallback : v;
  const query = async (_env: unknown, sql: string) => {
    seen.push(sql);
    if (sql.includes("ORDER BY")) return pick(overrides.rows, ROWS);
    if (sql.includes("FROM (")) return pick(overrides.distinct, [distinct]);
    return pick(overrides.totals, [totals]);
  };
  return { query, seen };
}

// Each family's live chain-wide reading, so a card that regresses reports a number the
// blame line can be traced to.
const FAMILIES = [
  {
    name: "serving",
    spec: CHAIN_SERVING_ROLLUP,
    build: buildSubnetServing,
    totals: { announcements: 9_100, newest_observed: 1_754_300_000_000 },
    distinct: { distinct_servers: 3_036 },
    countKey: "announcements",
    distinctKey: "distinct_servers",
  },
  {
    name: "stake-moves",
    spec: CHAIN_STAKE_MOVES_ROLLUP,
    build: buildSubnetStakeMoves,
    totals: { movements: 1_820, newest_observed: 1_754_300_000_000 },
    distinct: { distinct_movers: 674 },
    countKey: "movements",
    distinctKey: "distinct_movers",
  },
  {
    name: "stake-transfers",
    spec: CHAIN_STAKE_TRANSFERS_ROLLUP,
    build: buildSubnetStakeTransfers,
    totals: { transfers: 12_168, newest_observed: 1_754_300_000_000 },
    distinct: { distinct_senders: 430 },
    countKey: "transfers",
    distinctKey: "distinct_senders",
  },
  {
    name: "registrations",
    spec: CHAIN_REGISTRATIONS_ROLLUP,
    build: buildSubnetRegistrations,
    totals: { registrations: 8_055, newest_observed: 1_754_300_000_000 },
    distinct: { distinct_registrants: 6_317 },
    countKey: "registrations",
    distinctKey: "distinct_registrants",
  },
] as const;

describe("loadSubnetEventCardColdTier", () => {
  for (const family of FAMILIES) {
    describe(family.name, () => {
      const engine = () => fakeEngine(family.totals, family.distinct);

      test("reports the window totals, not the page sum", async () => {
        const e = engine();
        const card = (await loadSubnetEventCardColdTier(
          {} as never,
          family.spec,
          7,
          family.build,
          { windowLabel: "7d", windowDays: 7, query: e.query as never },
        )) as Row;
        assert.equal(
          card[family.countKey],
          family.totals[family.countKey as never],
        );
        assert.equal(
          card[family.distinctKey],
          family.distinct[family.distinctKey as never],
        );
        assert.notEqual(card[family.countKey], 50, "summed the capped page");
      });

      test("narrows EVERY read to the requested subnet", async () => {
        // A per-subnet question answered by a chain-wide scan is plausible and wrong for
        // every subnet but the busiest.
        const e = engine();
        await loadSubnetEventCardColdTier(
          {} as never,
          family.spec,
          7,
          family.build,
          {
            windowLabel: "7d",
            windowDays: 7,
            query: e.query as never,
          },
        );
        assert.ok(e.seen.length > 0);
        for (const sql of e.seen) assert.match(sql, /netuid\s*=\s*7/, sql);
      });

      test("filters on this family's own event kind", async () => {
        // Four cards read one table. A card reading a sibling's kind would report a
        // confident, wrong, non-zero number — worse than the zero it replaced.
        const e = engine();
        await loadSubnetEventCardColdTier(
          {} as never,
          family.spec,
          7,
          family.build,
          {
            windowLabel: "7d",
            windowDays: 7,
            query: e.query as never,
          },
        );
        for (const sql of e.seen)
          assert.ok(sql.includes(family.spec.eventKind), sql);
      });

      test("declines rather than returning a zeroed card when a read misses", async () => {
        // Declining is what lets the caller tell "no activity" from "could not read".
        // Returning zeros here would reproduce the exact bug being fixed.
        for (const missing of [
          { totals: null },
          { distinct: null },
          { rows: null },
        ]) {
          const e = fakeEngine(family.totals, family.distinct, missing);
          const card = await loadSubnetEventCardColdTier(
            {} as never,
            family.spec,
            7,
            family.build,
            { windowLabel: "7d", windowDays: 7, query: e.query as never },
          );
          assert.equal(card, null, JSON.stringify(missing));
        }
      });
    });
  }

  test("netuid 0 is a real subnet, not an absent filter", async () => {
    const e = fakeEngine(FAMILIES[0].totals, FAMILIES[0].distinct);
    await loadSubnetEventCardColdTier(
      {} as never,
      FAMILIES[0].spec,
      0,
      FAMILIES[0].build,
      {
        windowLabel: "7d",
        windowDays: 7,
        query: e.query as never,
      },
    );
    for (const sql of e.seen) assert.match(sql, /netuid\s*=\s*0/, sql);
  });

  test("a malformed netuid declines without scanning the lakehouse", async () => {
    const e = fakeEngine(FAMILIES[0].totals, FAMILIES[0].distinct);
    const card = await loadSubnetEventCardColdTier(
      {} as never,
      FAMILIES[0].spec,
      Number.NaN,
      FAMILIES[0].build,
      { windowLabel: "7d", windowDays: 7, query: e.query as never },
    );
    assert.equal(card, null);
    assert.deepEqual(e.seen, [], "scanned every subnet for a malformed netuid");
  });

  test("the four specs do not collide on event kind or field names", async () => {
    // They share one table and one loader; two specs agreeing on a field would make one
    // card silently serve the other's numbers.
    const kinds = FAMILIES.map((f) => f.spec.eventKind);
    const counts = FAMILIES.map((f) => f.spec.countField);
    const distincts = FAMILIES.map((f) => f.spec.distinctField);
    assert.equal(new Set(kinds).size, kinds.length);
    assert.equal(new Set(counts).size, counts.length);
    assert.equal(new Set(distincts).size, distincts.length);
  });
});

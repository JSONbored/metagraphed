// The ≥v441 basket-claim era of the root-claim surface (#13163): the
// kind-filtered hot-tier read, the serve-time block assembly, and the loader
// attachment beside field_sources. The legacy v440 adapter is untouched and
// keeps its own suites (tests/account-root-claim.test.ts,
// tests/account-root-claim-compatibility.test.ts).
import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  loadAccountRootClaim,
  loadRootClaimBasketClaims,
  ACCOUNT_ROOT_CLAIM_FIELD_SOURCES,
  ROOT_CLAIM_BASKET_CLAIMS_LIMIT,
  ROOT_CLAIM_BASKET_EVENT_KINDS,
} from "../src/account-root-claim.ts";
import { loadAccountBasketClaimEventsHotTier } from "../src/chain-detail-hot-tier.ts";
import type { Row } from "./row-type.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const OBSERVED_MS = 1_763_000_000_000;

function eventRow(overrides: Row = {}): Row {
  return {
    block_number: 6_500_000,
    event_index: 2,
    extrinsic_index: 1,
    event_kind: "BasketClaimed",
    hotkey: "5Hotkey_one",
    coldkey: SS58,
    netuid: 0,
    uid: null,
    amount_tao: 1.25,
    alpha_amount: null,
    observed_at: OBSERVED_MS,
    ...overrides,
  };
}

function hotTierEnv(rows: {
  events?: Row[];
  floorMs?: number | null;
  fail?: boolean;
}) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const store = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (rows.fail) throw new Error("native unavailable");
      if (/MIN\(observed_at\)/.test(sql))
        return [{ floor_ms: rows.floorMs ?? null }];
      return rows.events ?? [];
    },
    async first() {
      throw new Error("unexpected first");
    },
  };
  return {
    calls,
    env: {
      NATIVE_READ_STORE: {
        tables: [
          "chain_detail_blocks",
          "chain_detail_extrinsics",
          "chain_detail_chain_events",
          "chain_detail_account_events",
        ],
        store,
      },
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("loadAccountBasketClaimEventsHotTier", () => {
  test("filters to the caller's kinds with one bounded indexed read", async () => {
    const { calls, env } = hotTierEnv({ events: [eventRow()] });
    const rows = await loadAccountBasketClaimEventsHotTier(
      env,
      SS58,
      ROOT_CLAIM_BASKET_EVENT_KINDS,
      100,
    );
    assert.deepEqual(rows, [eventRow()]);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM chain_detail_account_events/);
    assert.match(
      calls[0].sql,
      /event_kind IN \('BasketClaimed','BasketClaimDustSkipped'\)/,
    );
    assert.match(calls[0].sql, /ORDER BY observed_at DESC/);
    assert.deepEqual(calls[0].values, [SS58, SS58, 100]);
  });

  test("declines an unusable limit or kind list before any read", async () => {
    const { calls, env } = hotTierEnv({ events: [eventRow()] });
    assert.equal(
      await loadAccountBasketClaimEventsHotTier(env, SS58, ["Basket"], 0),
      null,
    );
    assert.equal(
      await loadAccountBasketClaimEventsHotTier(env, SS58, [], 10),
      null,
    );
    // A kind that is not a bare event name must never reach the statement:
    // the list is interpolated (fixed in-repo constants), so the guard is
    // what keeps that interpolation inert.
    assert.equal(
      await loadAccountBasketClaimEventsHotTier(env, SS58, ["x'y"], 10),
      null,
    );
    assert.equal(calls.length, 0);
  });

  test("an unbound store or failed read is null, never a throw", async () => {
    assert.equal(
      await loadAccountBasketClaimEventsHotTier(
        {},
        SS58,
        ROOT_CLAIM_BASKET_EVENT_KINDS,
        10,
      ),
      null,
    );
    const { env } = hotTierEnv({ fail: true });
    assert.equal(
      await loadAccountBasketClaimEventsHotTier(
        env,
        SS58,
        ROOT_CLAIM_BASKET_EVENT_KINDS,
        10,
      ),
      null,
    );
  });
});

describe("loadRootClaimBasketClaims", () => {
  test("a non-finney network is the decline: the event stream is the finney lane", async () => {
    const { calls, env } = hotTierEnv({ events: [eventRow()] });
    assert.equal(
      await loadRootClaimBasketClaims(env as unknown as Env, SS58, "testnet"),
      null,
    );
    assert.equal(calls.length, 0);
  });

  test("no bound event store is the decline", async () => {
    assert.equal(await loadRootClaimBasketClaims({} as Env, SS58), null);
  });

  test("formats claims newest-first with the store's coverage floor", async () => {
    const { env } = hotTierEnv({
      events: [
        eventRow(),
        eventRow({
          event_kind: "BasketClaimDustSkipped",
          amount_tao: null,
          observed_at: OBSERVED_MS - 1000,
        }),
      ],
      floorMs: OBSERVED_MS - 86_400_000,
    });
    const block = await loadRootClaimBasketClaims(
      env as unknown as Env,
      SS58,
      "mainnet",
    );
    assert.ok(block);
    assert.equal(block.claim_count, 2);
    assert.equal(block.claims[0].event_kind, "BasketClaimed");
    assert.equal(block.claims[0].amount_tao, 1.25);
    assert.equal(
      block.claims[0].observed_at,
      new Date(OBSERVED_MS).toISOString(),
    );
    assert.equal(block.claims[1].event_kind, "BasketClaimDustSkipped");
    assert.equal(
      block.covered_since,
      new Date(OBSERVED_MS - 86_400_000).toISOString(),
    );
  });

  test("an empty page from a bound store is a measurement, not a decline", async () => {
    const { env } = hotTierEnv({ events: [], floorMs: OBSERVED_MS });
    const block = await loadRootClaimBasketClaims(env as unknown as Env, SS58);
    assert.ok(block);
    assert.equal(block.claim_count, 0);
    assert.deepEqual(block.claims, []);
    assert.equal(block.covered_since, new Date(OBSERVED_MS).toISOString());
  });

  test("an unreadable coverage floor degrades to null alone", async () => {
    const { env } = hotTierEnv({ events: [eventRow()], floorMs: null });
    const block = await loadRootClaimBasketClaims(env as unknown as Env, SS58);
    assert.ok(block);
    assert.equal(block.covered_since, null);
    assert.equal(block.claim_count, 1);
  });
});

describe("loadAccountRootClaim attaches the era block beside field_sources", () => {
  test("the served record carries basket_claims outside the legacy snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("rpc down");
      }),
    );
    const { env } = hotTierEnv({
      events: [eventRow()],
      floorMs: OBSERVED_MS,
    });
    const record = await loadAccountRootClaim(env as unknown as Env, SS58);
    // The legacy read degraded (RPC down) without taking the era block with it.
    assert.equal(record.compatibility.status, "unavailable");
    assert.equal(record.claim_type, null);
    assert.ok(record.basket_claims);
    assert.equal(record.basket_claims.claim_count, 1);
    assert.equal(record.field_sources, ACCOUNT_ROOT_CLAIM_FIELD_SOURCES);
    assert.deepEqual(ACCOUNT_ROOT_CLAIM_FIELD_SOURCES.basket_claims, {
      kind: "reconstructed",
      storage: null,
    });
  });

  test("the page bound is the card's own, stated once", () => {
    assert.equal(ROOT_CLAIM_BASKET_CLAIMS_LIMIT, 100);
    assert.deepEqual(
      [...ROOT_CLAIM_BASKET_EVENT_KINDS],
      ["BasketClaimed", "BasketClaimDustSkipped"],
    );
  });
});

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
const native = vi.hoisted(() => ({ block: vi.fn(), hash: vi.fn() }));
vi.mock("../src/indexed-history-store.ts", () => ({
  readSelectedHistoryBlock: native.block,
  readSelectedHistoryHash: native.hash,
}));
import {
  loadBlockFeedFromR2Sql,
  loadBlockFromR2Sql,
  loadBlockWithEconomicsFromR2Sql,
  OFFSET_EMULATION_CAP,
  currentOffsetCapDeclineGeneration,
  offsetBeyondEmulationCap,
  safeAuthorLiteral,
} from "../src/r2-sql-blocks.ts";
import { declineBlock } from "../src/blocks.ts";
import { CHAIN_EVENTS_LIMIT_MAX } from "../src/route-limits.ts";
const TOKEN = { R2_SQL_TOKEN: "obsolete-fixture" };
const AUTHOR = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
beforeEach(() => {
  native.block.mockReset().mockResolvedValue(undefined);
  native.hash.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("SQL transport is retired");
    }),
  );
});
afterEach(() => {
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
  vi.unstubAllGlobals();
});
test("block input guards preserve their published bounds", async () => {
  assert.equal(safeAuthorLiteral(AUTHOR), AUTHOR);
  for (const bad of ["", "short", "has space", "0'; DROP--", 42, null])
    assert.equal(safeAuthorLiteral(bad), null);
  for (const query of [
    { limit: 0 },
    { limit: 1, offset: -1 },
    { limit: 1, offset: 251 },
    { limit: 1, author: "bad" },
    { limit: 1, specVersion: -1 },
    { limit: 1, blockStart: NaN },
    { limit: 1, blockEnd: -1 },
    { limit: 1, from: -1 },
    { limit: 1, to: -1 },
    { limit: 1, minExtrinsics: -1 },
    { limit: 1, minEvents: -1 },
    { limit: 1, ceilingBlock: -1 },
  ])
    assert.equal(
      await loadBlockFeedFromR2Sql(TOKEN, { offset: 0, ...query }),
      null,
    );
  for (const ref of ["bad", "-1", "0xz"])
    assert.equal(await loadBlockFromR2Sql(TOKEN, ref), null);
});
test("missing native ownership never invokes the obsolete transport or manufactures absence", async () => {
  assert.equal(
    await loadBlockFeedFromR2Sql(TOKEN, { limit: 1, offset: 0 }),
    null,
  );
  assert.deepEqual(await loadBlockFromR2Sql(TOKEN, "42"), declineBlock("42"));
  assert.equal(await loadBlockFromR2Sql(null, "42"), null);
  assert.deepEqual(
    await loadBlockFromR2Sql(
      Object.assign(
        { R2_SQL_TOKEN: undefined },
        { NATIVE_PROJECTIONS: "enabled" },
      ),
      "0xabc",
    ),
    declineBlock("0xabc"),
  );
});
function row(n: number) {
  return {
    block_number: n,
    block_hash: `0xh${n}`,
    parent_hash: `0xh${n - 1}`,
    author: AUTHOR,
    extrinsic_count: 3,
    event_count: 7,
    spec_version: 240,
    observed_at: 1_700_000_000_000 + n,
  };
}

function economicsExtrinsic(overrides: Record<string, unknown> = {}) {
  return {
    block_number: 42,
    extrinsic_index: 0,
    extrinsic_hash: "0xext",
    signer: AUTHOR,
    call_module: "SubtensorModule",
    call_function: "add_stake",
    success: true,
    fee_tao: 0.125,
    tip_tao: 0.005,
    call_args: JSON.stringify([{ name: "netuid", value: 7 }]),
    observed_at: 1_700_000_000_042,
    ...overrides,
  };
}

function economicsEvent(overrides: Record<string, unknown> = {}) {
  return {
    block_number: 42,
    event_index: 0,
    extrinsic_index: 0,
    event_kind: "Transfer",
    hotkey: AUTHOR,
    coldkey: null,
    netuid: 19,
    uid: null,
    amount_tao: 2.5,
    alpha_amount: null,
    observed_at: 1_700_000_000_042,
    ...overrides,
  };
}

test("the cap check RECORDS the decline it takes (#11142)", () => {
  // The counter is the only way a declined page can be told from an empty
  // one: the cap is checked before any SQL is built, so the r2-sql failure
  // generation -- which is what handleRequest compares around a dispatch --
  // never moves. A bare `offset > CAP` comparison is therefore invisible to
  // the labeller, which is how ten routes shipped answering a declined page
  // as end-of-feed.
  const start = currentOffsetCapDeclineGeneration();

  // At or below the ceiling: servable, and nothing to declare.
  assert.equal(offsetBeyondEmulationCap(0), false);
  assert.equal(offsetBeyondEmulationCap(OFFSET_EMULATION_CAP), false);
  assert.equal(
    currentOffsetCapDeclineGeneration(),
    start,
    "a servable depth must not report a decline, or the marker means nothing",
  );

  // Past it: declined, and said so.
  assert.equal(offsetBeyondEmulationCap(OFFSET_EMULATION_CAP + 1), true);
  assert.equal(currentOffsetCapDeclineGeneration(), start + 1);
  assert.equal(offsetBeyondEmulationCap(OFFSET_EMULATION_CAP + 10_000), true);
  assert.equal(
    currentOffsetCapDeclineGeneration(),
    start + 2,
    "each decline counts, so concurrent reads on one isolate cannot mask one another",
  );
});

test("the offset cap keeps the worst measured page under the body cap (#11140)", () => {
  // NOT `OFFSET_EMULATION_CAP === 250` -- that asserts the code's own
  // assumption and passes at any value. This pins the ARITHMETIC the constant
  // exists to satisfy, so raising it back fails here with the reason.
  //
  // The over-fetch is `limit + offset` rows (R2 SQL has no OFFSET), each
  // carrying an unbounded `call_args`. Measured 2026-08-14 on
  // chain_detail_extrinsics: a filtered read concentrates the wide rows, and
  // the density that actually declined in production implies ~11.4 KB/row --
  // that page tripped a 12 MB cap, so the cap is not the free variable.
  // Imported, not retyped: raising the limit ceiling widens the same
  // over-fetch, so this must fail then too rather than pass on a stale 100.
  const MAX_PAGE_LIMIT = CHAIN_EVENTS_LIMIT_MAX;
  const OBSERVED_WIDE_ROW_BYTES = 11_400;
  const PRODUCTION_BODY_CAP = 8 * 1024 * 1024;

  const worstFetch = OFFSET_EMULATION_CAP + MAX_PAGE_LIMIT;
  const worstBytes = worstFetch * OBSERVED_WIDE_ROW_BYTES;
  assert.ok(
    worstBytes < PRODUCTION_BODY_CAP,
    `an emulated-offset page may fetch ${worstFetch} rows, which is ` +
      `${worstBytes} bytes at the observed wide-row density and exceeds the ` +
      `${PRODUCTION_BODY_CAP}-byte cap. Lower OFFSET_EMULATION_CAP; do not ` +
      `raise the body cap -- 8 MB was already raised to 12 MB and still declined.`,
  );
  // And the margin is real, not a hair under: at least 2x headroom, so an
  // era with denser payloads than the one measured does not reintroduce it.
  assert.ok(
    worstBytes * 2 < PRODUCTION_BODY_CAP,
    "the offset cap should leave at least 2x headroom against the body cap",
  );
});

describe("loadBlockWithEconomicsFromR2Sql", () => {
  test("derives complete block economics and subnet involvement from companion tables", async () => {
    native.block.mockImplementation(async (_env, table, height) => {
      if (table === "blocks") return [row(height)];
      if (table === "extrinsics")
        return [
          economicsExtrinsic(),
          economicsExtrinsic({
            extrinsic_index: 1,
            signer: null,
            fee_tao: null,
            tip_tao: null,
          }),
        ];
      if (table === "account_events")
        return [
          economicsEvent(),
          economicsEvent({
            event_index: 1,
            event_kind: "StakeAdded",
            amount_tao: 1.25,
          }),
          economicsEvent({
            event_index: 2,
            event_kind: "Issued",
            amount_tao: 0.5,
            netuid: null,
          }),
          economicsEvent({
            event_index: 3,
            amount_tao: 0.000000113,
            netuid: null,
          }),
        ];
      return null;
    });

    const data = await loadBlockWithEconomicsFromR2Sql(TOKEN, "42");
    assert.ok(data?.block);
    assert.equal(data.block.decode_status, "complete");
    assert.equal(data.block.native_transfer_tao, 2.500000113);
    assert.equal(data.block.stake_flow_tao, 1.25);
    assert.equal(data.block.economic_activity_tao, 3.750000113);
    assert.equal(data.block.fee_tao, 0.125);
    assert.equal(data.block.tip_tao, 0.005);
    assert.equal(data.block.issuance_tao, 0.5);
    assert.deepEqual(data.block.subnet_ids, [7, 19]);
    assert.equal(data.prev_block_number, 41);
    assert.equal(data.next_block_number, 43);
    assert.equal(native.block.mock.calls.length, 5);
    for (const call of native.block.mock.calls.filter((c) => c[1] !== "blocks"))
      assert.equal(call[2], 42);
  });

  for (const failedTable of ["extrinsics", "account_events"] as const) {
    test(`keeps economics unavailable when ${failedTable} fails`, async () => {
      native.block.mockImplementation(async (_env, table, height) => {
        if (table === "blocks") return [row(height)];
        if (table === failedTable) return null;
        return [];
      });

      const data = await loadBlockWithEconomicsFromR2Sql(TOKEN, "42");
      assert.ok(data?.block, "the header is still an answer");
      assert.equal(data.block.decode_status, "unavailable");
      assert.equal(data.block.economic_activity_tao, null);
      assert.deepEqual(data.block.subnet_ids, []);
    });
  }

  test("hash resolution precedes companion lookup and missing economics stays unknown", async () => {
    native.hash.mockResolvedValue(row(42));
    native.block.mockImplementation(async (_env, table, height) =>
      table === "blocks" ? [row(height)] : [],
    );
    const data = await loadBlockWithEconomicsFromR2Sql(TOKEN, "0xABCDEF");
    assert.equal(data?.block?.economic_activity_tao, 0);
    for (const call of native.block.mock.calls.filter((c) => c[1] !== "blocks"))
      assert.equal(call[2], 42);
    native.block.mockImplementation(async (_env, table, height) =>
      table === "blocks" ? [row(height)] : null,
    );
    assert.equal(
      (await loadBlockWithEconomicsFromR2Sql(TOKEN, "0xABCDEF"))?.block
        ?.decode_status,
      "unavailable",
    );
    native.block.mockResolvedValue([]);
    assert.equal(
      (await loadBlockWithEconomicsFromR2Sql(TOKEN, "42"))?.block,
      null,
    );
    native.block.mockClear();
    native.hash.mockClear();
    assert.equal(await loadBlockWithEconomicsFromR2Sql(TOKEN, "bad-ref"), null);
    assert.equal(
      native.block.mock.calls.length + native.hash.mock.calls.length,
      0,
    );
  });
});

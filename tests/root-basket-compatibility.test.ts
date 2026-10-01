import assert from "node:assert/strict";
import { test } from "vitest";
import { ROOT_BASKET_RUNTIME_ADAPTERS } from "../schemas-src/root-basket-compatibility.ts";
import { RootBasketSourceSchema } from "../schemas-src/root-basket-runtime.ts";
import { RootBasketRuntimeObservationSchema } from "../schemas-src/root-basket-observation.ts";
import { BASKET_RUNTIME_API_ID, openRootBasketRuntime } from "../src/root-basket-runtime.ts";
import { loadRootBaskets } from "../src/root-baskets-read.ts";
import { collectRootBasketObservation } from "../src/root-basket-observation.ts";
import { decodeBasketSummaries, decodeBasketSummary, decodeBasketEntitlements } from "../src/root-basket-runtime-codec.ts";
import { CONCRETE_PATH_SS58 } from "./concrete-path.ts";
import {
  basketRuntimeFixture, BASKET_FIXTURE_BLOCK, BASKET_FIXTURE_HOTKEY,
  BASKET_FIXTURE_COLDKEY, BASKET_FIXTURE_SUMMARY,
  BASKET_FIXTURE_WEIGHTED_SUMMARY, BASKET_FIXTURE_ENTITLEMENT,
} from "./fixtures/root-basket-runtime.ts";

// Independent release-generation expectation from the pinned official sources.
// Integer gaps are not automatically admitted as compatible official releases.
const generations = [
  [441, 1], [442, 1], [443, 1], [445, 1], [446, 1], [447, 1], [448, 1],
  [450, 3], [452, 3], [453, 3], [454, 3], [459, 3],
  [464, 4], [466, 4], [467, 4], [468, 5], [469, 5], [470, 5],
] as const;

function fixture(spec: number, api: number, overrides: Record<string, unknown> = {}) {
  return basketRuntimeFixture({
    state_getRuntimeVersion: { specName: "node-subtensor", specVersion: spec, apis: [[BASKET_RUNTIME_API_ID, api]] },
    get_validator_basket_summary: `0x${api < 4 ? BASKET_FIXTURE_WEIGHTED_SUMMARY : BASKET_FIXTURE_SUMMARY}`,
    get_all_validator_baskets: `0x04${api < 4 ? BASKET_FIXTURE_WEIGHTED_SUMMARY : BASKET_FIXTURE_SUMMARY}`,
    ...overrides,
  });
}

test("release identities retain exact commits and generations without integer-range admission", () => {
  assert.deepEqual(ROOT_BASKET_RUNTIME_ADAPTERS.map(({spec, api}) => [spec, api]), generations);
  for (const row of ROOT_BASKET_RUNTIME_ADAPTERS) {
    assert.match(row.commit, /^[0-9a-f]{40}$/);
    assert.equal(row.decoder, `subtensor-v${row.spec}-${row.commit.slice(0, 8)}-v1`);
  }
});

for (const [spec, api] of generations) {
  test(`v${spec} serves directory, fund and account views without invoking later runtime methods`, async () => {
    for (const [params, ss58, kind] of [
      [{}, undefined, api === 1 ? "legacy-directory" : "directory"],
      [{hotkey: BASKET_FIXTURE_HOTKEY}, undefined, "fund"],
      [{limit: 1}, CONCRETE_PATH_SS58, "account"],
    ] as const) {
      const source = fixture(spec, api);
      const out = await loadRootBaskets(params, "mainnet", ss58, source.rpc);
      assert.equal(out.status, "available");
      if (out.status !== "available") throw new Error("fixture failed");
      assert.equal(out.data.kind, kind);
      assert.equal(out.source.runtime_spec_version, spec);
      assert.equal(out.source.runtime_api_version, api);
      assert.deepEqual(out.source.capabilities, {
        pricing: api >= 3, beta_positions: api >= 3, target_weights: api < 4,
        trading_status: api >= 4, claim_preview: api >= 5,
      });
      const calls = source.calls.filter((call) => call.method === "state_call");
      assert.ok(calls.every((call) => call.params[2] === BASKET_FIXTURE_BLOCK));
      const names = calls.map((call) => String(call.params[0]));
      if (api < 3) assert.ok(names.every((name) => !/beta_|claim_preview|trading_status/.test(name)));
      if (api < 4) assert.ok(names.every((name) => !/trading_status/.test(name)));
      if (api < 5) assert.ok(names.every((name) => !/claim_preview/.test(name)));
      if (out.data.kind === "fund") {
        assert.equal(out.data.pricing !== null, api >= 3);
        assert.equal(out.data.baseline !== null, api >= 3);
        assert.equal(out.data.trading !== null, api >= 4);
        assert.equal(out.data.summary.target_weights !== undefined, api < 4);
        if (api < 4) assert.deepEqual(out.data.summary.target_weights, [{netuid:19, weight_u16:32767}, {netuid:0, weight_u16:0}]);
      }
      if (out.data.kind === "account") {
        const row = out.data.entries[0]!;
        assert.equal(row.position !== null, api >= 3);
        assert.equal(row.claim !== null, api >= 5);
        if (api === 1) assert.deepEqual(row.entitlement, {hotkey:BASKET_FIXTURE_HOTKEY, owed_shares_atomic:"11", payout_rao:"9"});
      }
      assert.equal(RootBasketSourceSchema.safeParse({...out.source, runtime_api_version: api + 1}).success, false);
      assert.equal(RootBasketSourceSchema.safeParse({...out.source, decoder_version: "subtensor-unknown"}).success, false);
      assert.equal(RootBasketSourceSchema.safeParse({...out.source, capabilities: {...out.source.capabilities, pricing: api < 3}}).success, false);
    }
  });
}

test("API 1 narrows entitlement meaning and declines unsupported methods before doing their work", async () => {
  const source = fixture(441, 1);
  const runtime = await openRootBasketRuntime(source.rpc, "local");
  const count = source.calls.length;
  assert.equal(await runtime.pricing(BASKET_FIXTURE_HOTKEY), null);
  assert.equal(await runtime.position(BASKET_FIXTURE_HOTKEY, BASKET_FIXTURE_COLDKEY), null);
  assert.equal(await runtime.tradingStatus(BASKET_FIXTURE_HOTKEY), null);
  assert.equal(await runtime.claimPreview(BASKET_FIXTURE_HOTKEY, BASKET_FIXTURE_COLDKEY), null);
  await assert.rejects(runtime.baseline(BASKET_FIXTURE_HOTKEY), /not published/);
  await assert.rejects(runtime.pricingPage(null), /not published/);
  await assert.rejects(runtime.portfolio(BASKET_FIXTURE_COLDKEY), /not published/);
  await assert.rejects(runtime.claimPreviews(BASKET_FIXTURE_COLDKEY), /not published/);
  await assert.rejects(runtime.index(), /not published/);
  await assert.rejects(runtime.indexSnapshot(), /not published/);
  assert.equal(source.calls.length, count);
  await assert.rejects(collectRootBasketObservation(source.rpc, "local"), /requires runtime pricing/);
  assert.ok(!source.calls.some((call) => call.method === "state_call"));
});

test("legacy summary pagination is bounded, deterministic and retains exact weights", async () => {
  const lower = `0x${"01".repeat(32)}`;
  const upper = `0x${"ff".repeat(32)}`;
  const withHotkey = (key: string) => key.slice(2) + BASKET_FIXTURE_WEIGHTED_SUMMARY.slice(64);
  const source = fixture(441, 1, {get_all_validator_baskets:`0x0c${withHotkey(upper)}${withHotkey(lower)}${BASKET_FIXTURE_WEIGHTED_SUMMARY}`});
  const runtime = await openRootBasketRuntime(source.rpc, "local");
  const first = await runtime.summaryPage(null, 2);
  assert.deepEqual(first.summaries.map((row) => row.hotkey), [lower, BASKET_FIXTURE_HOTKEY]);
  assert.equal(first.next_after, BASKET_FIXTURE_HOTKEY);
  const second = await runtime.summaryPage(first.next_after, 2);
  assert.deepEqual(second.summaries.map((row) => row.hotkey), [upper]);
  assert.equal(second.next_after, null);
  assert.deepEqual((await runtime.summaryPage(upper)).summaries, []);
  await assert.rejects(runtime.summaryPage("invalid"));
  await assert.rejects(runtime.summaryPage(null, 0));
  await assert.rejects((await openRootBasketRuntime(fixture(441,1,{get_all_validator_baskets:`0x08${BASKET_FIXTURE_WEIGHTED_SUMMARY.repeat(2)}`}).rpc,"local")).summaryPage(null), /Duplicate/);
  const empty = await openRootBasketRuntime(fixture(441,1,{get_all_validator_baskets:"0x00"}).rpc,"local");
  assert.deepEqual(await empty.summaryPage(null), {summaries:[],next_after:null});
  const modern = await openRootBasketRuntime(fixture(470,5).rpc, "local");
  assert.equal((await modern.summaryPage(null)).summaries[0]!.target_weights, undefined);
});

test("API 1 account pages distinguish missing entitlement, malformed membership and confirmed empty", async () => {
  const source = fixture(441,1,{get_root_basket_positions:"0x00"});
  const runtime = await openRootBasketRuntime(source.rpc,"local");
  const missing = (await runtime.accountPage(BASKET_FIXTURE_COLDKEY)).entries[0]!;
  assert.ok("entitlement" in missing);
  assert.equal(missing.entitlement,null);
  const before = source.calls.length;
  assert.deepEqual(await runtime.accountPage(BASKET_FIXTURE_COLDKEY,1),{entries:[],total_relationships:1,next_offset:null});
  assert.equal(source.calls.filter((call) => call.method === "state_call").length,1);
  assert.ok(source.calls.length > before); // pinned relationship storage still establishes the total
  const empty = await openRootBasketRuntime(fixture(441,1,{state_getStorage:null}).rpc,"local");
  assert.deepEqual(await empty.accountPage(BASKET_FIXTURE_COLDKEY),{entries:[],total_relationships:0,next_offset:null});
  for (const encoded of [
    `0x08${BASKET_FIXTURE_ENTITLEMENT.repeat(2)}`,
    `0x04${BASKET_FIXTURE_COLDKEY.slice(2)}${BASKET_FIXTURE_ENTITLEMENT.slice(64)}`,
  ]) await assert.rejects((await openRootBasketRuntime(fixture(441,1,{get_root_basket_positions:encoded}).rpc,"local")).accountPage(BASKET_FIXTURE_COLDKEY), /Invalid basket relationship/);
});

test("all new SCALE layouts reject truncation, trailing bytes and oversized vectors", () => {
  for (const [decode, encoded] of [
    [decodeBasketSummaries, `0x04${BASKET_FIXTURE_WEIGHTED_SUMMARY}`],
    [decodeBasketEntitlements, `0x04${BASKET_FIXTURE_ENTITLEMENT}`],
  ] as const) {
    assert.equal(decode(encoded).length,1);
    assert.deepEqual(decode("0x00"),[]);
    assert.throws(() => decode(encoded.slice(0,-2)));
    assert.throws(() => decode(encoded+"00"),/Trailing/);
  }
  assert.throws(() => decodeBasketSummaries("0x0520"),/budget/);
  assert.throws(() => decodeBasketEntitlements("0x0540"),/budget/);
  assert.throws(() => decodeBasketSummary(`0x${BASKET_FIXTURE_WEIGHTED_SUMMARY}`));
  assert.throws(() => decodeBasketSummary(`0x${BASKET_FIXTURE_SUMMARY}`,true));
});

test("earlier priced observations retain weights and explicit absent trading status", async () => {
  const observation = await collectRootBasketObservation(fixture(454,3).rpc,"local");
  assert.equal(observation.funds[0]!.trading,null);
  assert.equal(observation.funds[0]!.summary.target_weights!.length,2);
  assert.equal(RootBasketRuntimeObservationSchema.safeParse(observation).success,true);
  const wrongTrading = structuredClone(observation);
  wrongTrading.funds[0]!.trading = {enabled:true,frozen:false,refill_blocks:"1",available_rao:"1",budget_rao:"1"};
  assert.equal(RootBasketRuntimeObservationSchema.safeParse(wrongTrading).success,false);
  const noPricing = structuredClone(observation);
  noPricing.source = (await openRootBasketRuntime(fixture(441,1).rpc,"local")).source;
  assert.equal(RootBasketRuntimeObservationSchema.safeParse(noPricing).success,false);
});

test("untagged and pre-basket versions do not inherit neighboring decoder identities", async () => {
  for (const spec of [0,430,440,444,449,451,455,458,460,465,471,1000]) {
    const source = fixture(spec,5);
    await assert.rejects(openRootBasketRuntime(source.rpc,"local"),/Unsupported/);
    assert.ok(!source.calls.some((call) => ["state_call","state_getMetadata"].includes(call.method)));
  }
});

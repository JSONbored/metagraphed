import assert from "node:assert/strict";
import { test } from "vitest";
import {
  openRootBasketRuntime,
  BASKET_RUNTIME_API_ID,
} from "../src/root-basket-runtime.ts";
import {
  BASKET_FIXTURE_BLOCK,
  BASKET_FIXTURE_CLAIM,
  BASKET_FIXTURE_COLDKEY,
  BASKET_FIXTURE_GENESIS,
  BASKET_FIXTURE_HOTKEY,
  BASKET_FIXTURE_POSITION,
  BASKET_FIXTURE_PRICING,
  pricingPage,
  basketRuntimeFixture,
} from "./fixtures/root-basket-runtime.ts";

const source = basketRuntimeFixture;

test("runtime API identity matches the independent Blake2b-64 trait-name golden", () => {
  assert.equal(BASKET_RUNTIME_API_ID, "0x43580abff6baab45");
});

test("all modern basket views share one finalized runtime and encoded account identity", async () => {
  const fixture = source();
  const runtime = await openRootBasketRuntime(fixture.rpc, "local");
  assert.equal(runtime.source.finalized_block, "500");
  assert.equal(runtime.source.network_genesis_hash, BASKET_FIXTURE_GENESIS);
  assert.equal(runtime.source.runtime_api_version, 5);
  assert.equal(runtime.source.decoder_version, "subtensor-v469-370bac46-v1");
  assert.match(runtime.source.metadata_sha256, /^0x[0-9a-f]{64}$/);
  assert.equal((await runtime.pricingPage(null)).pricing.length, 1);
  assert.equal(
    (await runtime.pricingPage(BASKET_FIXTURE_COLDKEY, 1)).pricing.length,
    1,
  );
  assert.equal(
    (await runtime.pricing(BASKET_FIXTURE_HOTKEY))!.hotkey,
    BASKET_FIXTURE_HOTKEY,
  );
  assert.equal(
    (await runtime.summary(BASKET_FIXTURE_HOTKEY)).shares_atomic,
    "17",
  );
  assert.equal(
    (await runtime.tradingStatus(BASKET_FIXTURE_HOTKEY)).enabled,
    true,
  );
  assert.equal(
    (await runtime.position(BASKET_FIXTURE_HOTKEY, BASKET_FIXTURE_COLDKEY))!
      .beta_atomic,
    "11",
  );
  assert.equal((await runtime.portfolio(BASKET_FIXTURE_COLDKEY)).length, 1);
  assert.equal(
    (await runtime.claimPreview(BASKET_FIXTURE_HOTKEY, BASKET_FIXTURE_COLDKEY))!
      .redeemable_rao,
    "9",
  );
  assert.equal((await runtime.claimPreviews(BASKET_FIXTURE_COLDKEY)).length, 1);
  assert.equal((await runtime.index()).stake_index_q64_bits, "8");
  assert.equal(
    (await runtime.baseline(BASKET_FIXTURE_HOTKEY)).provisional,
    true,
  );
  assert.equal((await runtime.indexSnapshot()).status, "not_published");
  assert.deepEqual(await runtime.stakingHotkeys(BASKET_FIXTURE_COLDKEY), [
    BASKET_FIXTURE_HOTKEY,
  ]);
  const reads = fixture.calls.filter((call) => call.method === "state_call");
  assert.equal(reads.length, 10);
  assert.ok(reads.every((call) => call.params[2] === BASKET_FIXTURE_BLOCK));
  assert.deepEqual(reads[0]!.params.slice(0, 2), [
    "BetaBasketRuntimeApi_get_all_beta_pricing",
    "0x0040000000",
  ]);
  assert.equal(
    reads[1]!.params[1],
    `0x01${BASKET_FIXTURE_COLDKEY.slice(2)}01000000`,
  );
  assert.equal(
    reads[5]!.params[1],
    BASKET_FIXTURE_HOTKEY + BASKET_FIXTURE_COLDKEY.slice(2),
  );
  assert.ok(
    fixture.calls
      .filter((call) => call.method === "state_getStorage")
      .every((call) => call.params[1] === BASKET_FIXTURE_BLOCK),
  );
  assert.ok(
    fixture.calls.every(
      (call) => !/submit|author_|extrinsic/.test(call.method),
    ),
  );
});

test("unsupported or ambiguous runtime APIs fail before metadata or basket work", async () => {
  for (const runtime of [
    { specName: "other", specVersion: 469, apis: [[BASKET_RUNTIME_API_ID, 5]] },
    {
      specName: "node-subtensor",
      specVersion: 470,
      apis: [[BASKET_RUNTIME_API_ID, 5]],
    },
    {
      specName: "node-subtensor",
      specVersion: 454,
      apis: [[BASKET_RUNTIME_API_ID, 3]],
    },
    { specName: "node-subtensor", specVersion: 469, apis: [] },
    {
      specName: "node-subtensor",
      specVersion: 469,
      apis: [[BASKET_RUNTIME_API_ID, 4]],
    },
    {
      specName: "node-subtensor",
      specVersion: 469,
      apis: [
        [BASKET_RUNTIME_API_ID, 5],
        [BASKET_RUNTIME_API_ID, 5],
      ],
    },
  ]) {
    const fixture = source({ state_getRuntimeVersion: runtime });
    await assert.rejects(
      openRootBasketRuntime(fixture.rpc, "local"),
      /Unsupported/,
    );
    assert.ok(
      !fixture.calls.some((call) =>
        ["state_call", "state_getMetadata"].includes(call.method),
      ),
    );
  }
});

test("source failures, metadata corruption and malformed runtime fields never become zero data", async () => {
  for (const overrides of [
    { chain_getFinalizedHead: null },
    { chain_getHeader: { number: "0x10000000000000000" } },
    { state_getRuntimeVersion: null },
    { chain_getBlockHash: "wrong genesis" },
    { state_getMetadata: undefined },
    { state_getMetadata: "0x" },
    { state_getMetadata: "0xgg" },
    { state_getMetadata: `0x${"00".repeat(1_048_577)}` },
    {
      state_getMetadata: () => {
        throw new Error("RPC failed");
      },
    },
  ])
    await assert.rejects(openRootBasketRuntime(source(overrides).rpc, "local"));
});

test("a resume hash must be canonical and below the current finalized ceiling", async () => {
  const old = `0x${"55".repeat(32)}`;
  const valid = source({
    chain_getBlockHash: (params: unknown[]) =>
      params[0] === 0 ? BASKET_FIXTURE_GENESIS : old,
  });
  assert.equal(
    (await openRootBasketRuntime(valid.rpc, "local", old)).source
      .finalized_block_hash,
    old,
  );
  assert.equal(
    (await openRootBasketRuntime(source().rpc, "local", BASKET_FIXTURE_BLOCK))
      .source.finalized_block_hash,
    BASKET_FIXTURE_BLOCK,
  );
  await assert.rejects(
    openRootBasketRuntime(source().rpc, "local", old),
    /canonical finalized/,
  );
  const future = source({
    chain_getHeader: (params: unknown[]) => ({
      number: params[0] === old ? "0x201" : "0x1f4",
    }),
    chain_getBlockHash: (params: unknown[]) =>
      params[0] === 0 ? BASKET_FIXTURE_GENESIS : old,
  });
  await assert.rejects(
    openRootBasketRuntime(future.rpc, "local", old),
    /canonical finalized/,
  );
});

test("pricing pagination and requested fund identities are validated", async () => {
  const fixture = source({
    get_all_beta_pricing: pricingPage([], BASKET_FIXTURE_HOTKEY),
  });
  const runtime = await openRootBasketRuntime(fixture.rpc, "local");
  await assert.rejects(runtime.pricingPage(BASKET_FIXTURE_HOTKEY), /progress/);
  for (const limit of [0, 65, 1.5])
    await assert.rejects(runtime.pricingPage(null, limit));
  const excess = await openRootBasketRuntime(
    source({
      get_all_beta_pricing: pricingPage([
        BASKET_FIXTURE_PRICING,
        BASKET_FIXTURE_PRICING,
      ]),
    }).rpc,
    "local",
  );
  await assert.rejects(excess.pricingPage(null, 1), /progress/);
  const ordinary = await openRootBasketRuntime(source().rpc, "local");
  for (const read of [
    () => ordinary.pricing(BASKET_FIXTURE_COLDKEY),
    () => ordinary.summary(BASKET_FIXTURE_COLDKEY),
    () => ordinary.position(BASKET_FIXTURE_COLDKEY, BASKET_FIXTURE_COLDKEY),
    () => ordinary.claimPreview(BASKET_FIXTURE_COLDKEY, BASKET_FIXTURE_COLDKEY),
  ])
    await assert.rejects(read(), /another fund/);
  const absent = await openRootBasketRuntime(
    source({
      get_beta_pricing: "0x00",
      get_beta_position: "0x00",
      get_basket_claim_preview: "0x00",
    }).rpc,
    "local",
  );
  assert.equal(await absent.pricing(BASKET_FIXTURE_HOTKEY), null);
  assert.equal(
    await absent.position(BASKET_FIXTURE_HOTKEY, BASKET_FIXTURE_COLDKEY),
    null,
  );
  assert.equal(
    await absent.claimPreview(BASKET_FIXTURE_HOTKEY, BASKET_FIXTURE_COLDKEY),
    null,
  );
});

test("the native portfolio shortcut cannot silently drop relationships beyond its cap", async () => {
  const hotkeys = Array.from({ length: 257 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  // SCALE compact 257 = two-byte little-endian 0x0405.
  const fixture = source({ state_getStorage: `0x0504${hotkeys.join("")}` });
  const runtime = await openRootBasketRuntime(fixture.rpc, "local");
  assert.equal(
    (await runtime.stakingHotkeys(BASKET_FIXTURE_COLDKEY)).length,
    257,
  );
  await assert.rejects(
    runtime.portfolio(BASKET_FIXTURE_COLDKEY),
    /relationship pagination/,
  );
  await assert.rejects(
    runtime.claimPreviews(BASKET_FIXTURE_COLDKEY),
    /relationship pagination/,
  );
  assert.ok(!fixture.calls.some((call) => call.method === "state_call"));
});

test("account pages cover relationships beyond the upstream shortcut and bound per-page work", async () => {
  const hotkeys = Array.from(
    { length: 257 },
    (_, i) => `0x${i.toString(16).padStart(64, "0")}`,
  );
  const fixture = source({
    state_getStorage: `0x0504${hotkeys.map((key) => key.slice(2)).join("")}`,
    get_beta_position: (params: unknown[]) =>
      `0x01${String(params[1]).slice(2, 66)}${BASKET_FIXTURE_POSITION.slice(64)}`,
    get_basket_claim_preview: "0x00",
  });
  const runtime = await openRootBasketRuntime(fixture.rpc, "local");
  const observed: string[] = [];
  let offset = 0;
  for (;;) {
    const before = fixture.calls.filter(
      (call) => call.method === "state_call",
    ).length;
    const page = await runtime.accountPage(BASKET_FIXTURE_COLDKEY, offset);
    assert.equal(page.total_relationships, 257);
    assert.ok(page.entries.length <= 16);
    assert.ok(
      fixture.calls.filter((call) => call.method === "state_call").length -
        before <=
        32,
    );
    assert.ok(
      page.entries.every(
        (entry) =>
          entry.position?.hotkey === entry.hotkey && entry.claim === null,
      ),
    );
    observed.push(...page.entries.map((entry) => entry.hotkey));
    if (page.next_offset === null) break;
    offset = page.next_offset;
  }
  assert.deepEqual(observed, hotkeys);
  assert.deepEqual(
    (await runtime.accountPage(BASKET_FIXTURE_COLDKEY, 257)).entries,
    [],
  );
  for (const offset of [-1, 1.5, 258, 4097])
    await assert.rejects(runtime.accountPage(BASKET_FIXTURE_COLDKEY, offset));
  for (const limit of [0, 17, 1.5])
    await assert.rejects(runtime.accountPage(BASKET_FIXTURE_COLDKEY, 0, limit));
  const empty = await openRootBasketRuntime(
    source({ state_getStorage: null }).rpc,
    "local",
  );
  assert.deepEqual(await empty.accountPage(BASKET_FIXTURE_COLDKEY), {
    entries: [],
    total_relationships: 0,
    next_offset: null,
  });
  const absent = await openRootBasketRuntime(
    source({ get_beta_position: "0x00", get_basket_claim_preview: "0x00" }).rpc,
    "local",
  );
  assert.deepEqual(
    (await absent.accountPage(BASKET_FIXTURE_COLDKEY, 0, 1)).entries,
    [{ hotkey: BASKET_FIXTURE_HOTKEY, position: null, claim: null }],
  );
  await assert.rejects(runtime.accountPage("invalid"));
});

test("shortcut results cannot contain foreign or duplicate relationships", async () => {
  for (const read of ["portfolio", "claimPreviews"] as const) {
    const key =
      read === "portfolio"
        ? "get_beta_portfolio"
        : "get_root_basket_claim_previews";
    const row =
      read === "portfolio" ? BASKET_FIXTURE_POSITION : BASKET_FIXTURE_CLAIM;
    for (const bad of [
      `0x08${row.repeat(2)}`,
      `0x04${BASKET_FIXTURE_COLDKEY.slice(2)}${row.slice(64)}`,
    ]) {
      const runtime = await openRootBasketRuntime(
        source({ [key]: bad }).rpc,
        "local",
      );
      await assert.rejects(
        runtime[read](BASKET_FIXTURE_COLDKEY),
        /relationship response/,
      );
    }
  }
  const duplicate = await openRootBasketRuntime(
    source({
      get_all_beta_pricing: pricingPage([
        BASKET_FIXTURE_PRICING,
        BASKET_FIXTURE_PRICING,
      ]),
    }).rpc,
    "local",
  );
  await assert.rejects(duplicate.pricingPage(null), /Duplicate/);
});

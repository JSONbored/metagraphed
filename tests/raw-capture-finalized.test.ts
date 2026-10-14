import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  captureTick,
  CANONICAL_MAX_RPC_REQUESTS,
  SYSTEM_EVENTS_STORAGE_KEY,
} from "../src/raw-chain-capture.ts";
import {
  finalizedCaptureContext,
  qualifyCaptureEndpoint,
} from "../src/raw-capture-finalized-rpc.ts";
import { RAW_CAPTURE_GENESIS } from "../src/raw-capture-provenance.ts";
import {
  nativeRawFixture,
  syntheticNode,
} from "./helpers/raw-capture-fixture.ts";
const opened: Awaited<ReturnType<typeof nativeRawFixture>>[] = [];
afterEach(async () => {
  for (const f of opened.splice(0)) await f.runtime.dispose();
  vi.useRealTimers();
});
async function fixture() {
  vi.useRealTimers();
  const f = await nativeRawFixture();
  opened.push(f);
  return f;
}
const noLegacy = {
  read: async () => {
    throw new Error("legacy read must not run");
  },
  write: async () => {
    throw new Error("legacy write must not run");
  },
};
async function run(
  f: Awaited<ReturnType<typeof fixture>>,
  node: ReturnType<typeof syntheticNode>,
  over: Partial<Parameters<typeof captureTick>[0]> = {},
) {
  return captureTick({
    rpcUrls: ["https://fixture.example"],
    store: f.store,
    canonical: f.store.canonical,
    watermark: noLegacy,
    network: node.network,
    genesisFloor: node.first,
    maxPerTick: 50,
    flushEvery: 25,
    fetchImpl: node.fetchImpl,
    now: () => 1000,
    sleepFn: async () => {},
    ...over,
  });
}

test("capture pins finality, qualifies hashes and resumes with durable canonical state", async () => {
  const f = await fixture(),
    node = syntheticNode({ shuffle: true });
  const result = await run(f, node);
  assert.equal(result.captured, 5);
  assert.equal(result.watermark, 14);
  assert.equal(result.behind, 0);
  assert.equal((await f.store.canonical!.read("mainnet"))?.verifiedFrom, 10);
  assert.equal(
    node.requests.some(
      (r) => r.method === "chain_getHeader" && r.params.length === 0,
    ),
    false,
    "best head is never queried",
  );
  assert.ok(
    node.requests
      .filter((r) => r.method === "state_getStorage")
      .every((r) => r.params[0] === SYSTEM_EVENTS_STORAGE_KEY),
  );
  const again = await run(f, node);
  assert.equal(again.captured, 0);
  assert.equal(again.watermark, 14);
});

test.each(["eventsAt", "badHeaderAt", "badParentAt"] as const)(
  "%s refuses the first invalid block but preserves its valid prefix",
  async (field) => {
    const f = await fixture(),
      node = syntheticNode({ [field]: 12 });
    const result = await run(f, node);
    assert.equal(result.captured, 2);
    assert.equal(result.watermark, 11);
    assert.equal(result.stoppedAt, 12);
    const cp = await f.store.canonical!.read("mainnet");
    assert.equal(cp?.height, 11);
    assert.equal(cp?.hash, node.hash(11));
    const good = syntheticNode();
    if (field === "badParentAt") {
      // The claimed finalized branch changed. Repair requires separate review;
      // never silently replace the persisted anchor to accept the other branch.
      await assert.rejects(run(f, good), /anchor differs/);
      assert.equal((await f.store.canonical!.read("mainnet"))?.height, 11);
    } else assert.equal((await run(f, good)).captured, 3);
  },
);

test("mismatched failover anchors cannot supply bytes under a trusted frontier", async () => {
  const f = await fixture(),
    primary = syntheticNode({ failAt: 12 }),
    different = syntheticNode({ seed: "other-source" });
  const first = await run(f, primary);
  assert.equal(first.watermark, 11);
  const fetchImpl: typeof fetch = (url, init) =>
    String(url).includes("different")
      ? different.fetchImpl(url, init)
      : primary.fetchImpl(url, init);
  const result = await run(f, primary, {
    rpcUrls: ["https://primary.example", "https://different.example"],
    fetchImpl,
  });
  assert.equal(result.captured, 0);
  assert.equal(result.watermark, 11);
  assert.match(result.reason!, /anchor differs/);
});

test("a qualified secondary endpoint recovers missing source bytes", async () => {
  const f = await fixture(),
    primary = syntheticNode({ failAt: 10 }),
    secondary = syntheticNode();
  const fetchImpl: typeof fetch = (url, init) =>
    String(url).includes("secondary")
      ? secondary.fetchImpl(url, init)
      : primary.fetchImpl(url, init);
  const result = await run(f, primary, {
    rpcUrls: ["https://primary.example", "https://secondary.example"],
    fetchImpl,
  });
  assert.equal(result.captured, 5);
  assert.equal(result.watermark, 14);
});

test("wrong genesis refuses bootstrap, and transient singleton HTTP failure retries once", async () => {
  const f = await fixture();
  await assert.rejects(
    run(f, syntheticNode({ genesis: `0x${"ff".repeat(32)}` })),
    /genesis differs/,
  );
  assert.equal(await f.store.canonical!.read("mainnet"), null);
  const recovered = await run(f, syntheticNode({ httpOnce: 525 }));
  assert.equal(recovered.watermark, 14);
});

test("a legacy best-head frontier ahead of finality waits without rewind or certification", async () => {
  const f = await fixture(),
    node = syntheticNode();
  await f.db
    .prepare(
      "INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at) VALUES('mainnet',15,7)",
    )
    .run();
  await assert.rejects(run(f, node), /Substrate hash|head regressed/);
  const legacy = await f.store.canonical!.read("mainnet");
  assert.equal(legacy?.height, 15);
  assert.equal(legacy?.genesis, null);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) n FROM raw_capture_finality")
      .first<number>("n"),
    0,
  );
});

test("finalized regression and persisted fork mismatch refuse a later tick", async () => {
  const f = await fixture(),
    first = syntheticNode();
  await run(f, first);
  await assert.rejects(
    run(f, syntheticNode({ head: 13 })),
    /Substrate hash|head regressed/,
  );
  await assert.rejects(
    run(f, syntheticNode({ seed: "changed-chain" })),
    /anchor differs/,
  );
  assert.equal((await f.store.canonical!.read("mainnet"))?.height, 14);
});

test("inconsistent finalized canonical lookup cannot poison an initial checkpoint", async () => {
  const f = await fixture(),
    node = syntheticNode();
  let calls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    calls++;
    if (calls === 3)
      return Response.json(
        body.map((c: { id: number }) => ({
          jsonrpc: "2.0",
          id: c.id,
          result: `0x${"ff".repeat(32)}`,
        })),
      );
    return node.fetchImpl(url, init);
  };
  await assert.rejects(
    run(f, node, { fetchImpl }),
    /finalized canonical hash differs/,
  );
  assert.equal(await f.store.canonical!.read("mainnet"), null);
});

test("HTTP budget exhaustion stops at the committed prefix rather than skipping", async () => {
  const f = await fixture(),
    node = syntheticNode({ head: 200 });
  const result = await run(f, node, { maxPerTick: 200, flushEvery: 1 });
  assert.ok(result.captured > 0);
  assert.ok(result.watermark < 200);
  assert.match(result.reason!, /RPC request budget exhausted/);
  assert.ok(
    new Set(node.requests.map((r) => r.request)).size <=
      CANONICAL_MAX_RPC_REQUESTS,
  );
  assert.equal(
    (await f.store.canonical!.read("mainnet"))?.height,
    result.watermark,
  );
});

test("empty endpoint list and missing original predecessor refuse", async () => {
  const f = await fixture(),
    node = syntheticNode();
  await assert.rejects(run(f, node, { rpcUrls: [] }), /rpcUrls is empty/);
  const fetchImpl: typeof fetch = async (url, init) => {
    const response = await node.fetchImpl(url, init);
    const body = JSON.parse(String(init?.body));
    if (Array.isArray(body) && body.some((c) => c.method === "chain_getHeader"))
      return Response.json(
        body.map((c) => ({
          jsonrpc: "2.0",
          id: c.id,
          result: c.method === "chain_getHeader" ? null : node.hash(14),
        })),
      );
    return response;
  };
  await assert.rejects(run(f, node, { fetchImpl }), /Invalid Substrate header/);
  assert.equal(await f.store.canonical!.read("mainnet"), null);
});

test("direct endpoint qualification rejects older fixed finality and foreign identity", async () => {
  const f = await fixture(),
    node = syntheticNode();
  await run(f, node);
  const cp = await f.store.canonical!.read("mainnet");
  assert(cp?.genesis);
  const canonical = cp as Parameters<typeof qualifyCaptureEndpoint>[1];
  await assert.rejects(
    qualifyCaptureEndpoint(
      "https://fixture.example",
      canonical,
      { height: 13, hash: node.hash(13) },
      { fetchImpl: node.fetchImpl },
    ),
    /head regressed/,
  );
  await assert.rejects(
    finalizedCaptureContext("https://fixture.example", "testnet", cp, 10, {
      fetchImpl: node.fetchImpl,
    }),
    /chain identity changed/,
  );
  await assert.rejects(
    finalizedCaptureContext("https://fixture.example", "mainnet", null, -1, {
      fetchImpl: node.fetchImpl,
    }),
    /Invalid raw capture predecessor/,
  );
  assert.notEqual(RAW_CAPTURE_GENESIS.mainnet, RAW_CAPTURE_GENESIS.testnet);
});

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

test("the virtual predecessor is explicit at floor zero and endpoint qualification preserves it", async () => {
  const f = await fixture(),
    node = syntheticNode();
  const transport = { fetchImpl: node.fetchImpl };
  const context = await finalizedCaptureContext(
    "https://fixture.example",
    "mainnet",
    null,
    0,
    transport,
  );
  assert.equal(context.previousHeight, -1);
  assert.equal(context.previousHash, `0x${"00".repeat(32)}`);
  const cp = await f.store.canonical!.bootstrap({
    network: "mainnet",
    previousHeight: null,
    height: -1,
    hash: context.previousHash,
    genesis: context.genesis,
    finalized: context.finalized,
    now: 1000,
  });
  await qualifyCaptureEndpoint(
    "https://fixture.example",
    cp,
    context.finalized,
    transport,
  );
  const again = await finalizedCaptureContext(
    "https://fixture.example",
    "mainnet",
    cp,
    0,
    transport,
  );
  assert.equal(again.previousHeight, -1);
  assert.equal(cp.verifiedFrom, 0);
  assert.equal(cp.revision, 0);
});

test("each fast failover spends a paced slot, and endpoint count cannot widen the attempt budget", async () => {
  const f = await fixture(),
    primary = syntheticNode({ failAt: 10 }),
    secondary = syntheticNode();
  let clock = 1000;
  const sleeps: number[] = [],
    starts: { host: string; at: number }[] = [];
  const fetchImpl: typeof fetch = (url, init) => {
    starts.push({ host: String(url), at: clock });
    return String(url).includes("secondary")
      ? secondary.fetchImpl(url, init)
      : primary.fetchImpl(url, init);
  };
  const result = await run(f, primary, {
    rpcUrls: ["https://primary.example", "https://secondary.example"],
    fetchImpl,
    now: () => clock,
    minGapMs: 100,
    sleepFn: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    maxPerTick: 50,
  });
  assert.equal(result.captured, 5);
  assert.deepEqual(sleeps, [100, 100]);
  assert.equal(starts.find((x) => x.host.includes("secondary"))?.at, 1200);

  const tight = await fixture();
  const refused = await run(tight, primary, {
    rpcUrls: ["https://primary.example", "https://secondary.example"],
    fetchImpl,
    maxPerTick: 25,
  });
  assert.equal(refused.captured, 0);
  assert.equal(refused.watermark, 9);
  assert.match(refused.reason!, /attempt budget exhausted/);
});

interface FixtureRpcCall {
  id: number;
  method: string;
  params: unknown[];
}
interface FixtureRpcReply {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}
/** Preserve the node's request recorder while changing one semantic RPC reply. */
function rewriteReply(
  node: ReturnType<typeof syntheticNode>,
  rewrite: (call: FixtureRpcCall, reply: FixtureRpcReply) => FixtureRpcReply,
): typeof fetch {
  return async (url, init) => {
    const request = JSON.parse(String(init?.body)) as
      | FixtureRpcCall
      | FixtureRpcCall[];
    const calls = Array.isArray(request) ? request : [request];
    const response = await node.fetchImpl(url, init);
    const payload = (await response.json()) as
      | FixtureRpcReply
      | FixtureRpcReply[];
    const replies = (Array.isArray(payload) ? payload : [payload]).map(
      (reply) => {
        const call = calls.find((entry) => entry.id === reply.id);
        assert.ok(call, "the fixture reply must retain its request identity");
        return rewrite(call, reply);
      },
    );
    return Response.json(Array.isArray(request) ? replies : replies[0]);
  };
}

test("a failed finalized-anchor batch member cannot initialize a durable checkpoint", async () => {
  const f = await fixture(),
    node = syntheticNode();
  const fetchImpl = rewriteReply(node, (call, reply) =>
    call.method === "chain_getBlockHash" && call.params[0] === 0
      ? {
          jsonrpc: "2.0",
          id: reply.id,
          error: { code: -32000, message: "genesis lookup unavailable" },
        }
      : reply,
  );
  await assert.rejects(
    run(f, node, { fetchImpl }),
    /genesis lookup unavailable/,
  );
  assert.equal(await f.store.canonical!.read("mainnet"), null);
  assert.equal(
    new Set(node.requests.map((request) => request.request)).size,
    1,
  );
  assert.equal(
    node.requests.some((request) => request.method === "chain_getBlock"),
    false,
  );
});

test("a finalized hash whose returned header is a different valid block is rejected before bootstrap", async () => {
  const f = await fixture(),
    node = syntheticNode();
  const fetchImpl = rewriteReply(node, (call, reply) =>
    call.method === "chain_getHeader" && call.params[0] === node.hash(14)
      ? { ...reply, result: node.headers.get(13) }
      : reply,
  );
  await assert.rejects(
    run(f, node, { fetchImpl }),
    /finalized header hash differs/,
  );
  assert.equal(await f.store.canonical!.read("mainnet"), null);
  assert.equal(
    new Set(node.requests.map((request) => request.request)).size,
    2,
  );
});

test.each([11, 13])(
  "a coherent lower finalized assertion refuses durable predecessor %i without changing its proof",
  async (height) => {
    const f = await fixture(),
      node = syntheticNode();
    const checkpoint = await f.store.canonical!.bootstrap({
      network: "mainnet",
      previousHeight: null,
      height,
      hash: node.hash(height),
      genesis: RAW_CAPTURE_GENESIS.mainnet,
      finalized: { height: 14, hash: node.hash(14) },
      now: 1000,
    });
    // Keep all prior canonical hashes available. Only the newly asserted head
    // regresses, so this reaches the finality guard rather than a missing hash.
    const fetchImpl = rewriteReply(node, (call, reply) =>
      call.method === "chain_getFinalizedHead"
        ? { ...reply, result: node.hash(12) }
        : reply,
    );
    await assert.rejects(
      run(f, node, { fetchImpl }),
      /finalized head regressed/,
    );
    assert.deepEqual(await f.store.canonical!.read("mainnet"), checkpoint);
    assert.equal(
      new Set(node.requests.map((request) => request.request)).size,
      2,
    );
    assert.equal(
      await f.db
        .prepare("SELECT count(*) n FROM raw_capture_finality")
        .first<number>("n"),
      0,
    );
  },
);

test.each(["height", "hash"] as const)(
  "a bootstrap predecessor header with a different %s cannot certify the legacy frontier",
  async (field) => {
    const f = await fixture(),
      node = syntheticNode(),
      other = syntheticNode({ seed: "other-predecessor" });
    await f.db
      .prepare(
        "INSERT INTO raw_capture_state(network,last_contiguous_block,updated_at) VALUES('mainnet',9,7)",
      )
      .run();
    const legacy = await f.store.canonical!.read("mainnet");
    const fetchImpl = rewriteReply(node, (call, reply) =>
      call.method === "chain_getHeader" && call.params[0] === node.hash(9)
        ? {
            ...reply,
            result:
              field === "height" ? node.headers.get(10) : other.headers.get(9),
          }
        : reply,
    );
    await assert.rejects(
      run(f, node, { fetchImpl }),
      /bootstrap header differs/,
    );
    assert.deepEqual(await f.store.canonical!.read("mainnet"), legacy);
    assert.equal(
      new Set(node.requests.map((request) => request.request)).size,
      3,
    );
    assert.equal(
      await f.db
        .prepare("SELECT count(*) n FROM raw_capture_finality")
        .first<number>("n"),
      0,
    );
  },
);

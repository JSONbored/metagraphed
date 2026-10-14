import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  runRawCaptureSync,
  RAW_CAPTURE_LANES,
} from "../src/raw-capture-sync.ts";
import { rawCaptureD1 } from "../src/raw-capture-d1.ts";
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
const noPool = { readArtifact: async () => ({ ok: false }) };
function nodes(over: Partial<Parameters<typeof syntheticNode>[0]> = {}) {
  const main = syntheticNode({
    first: RAW_CAPTURE_LANES[0]!.genesisFloor,
    ...over,
  });
  const testnet = syntheticNode({
    network: "testnet",
    first: RAW_CAPTURE_LANES[1]!.genesisFloor,
  });
  const fetchImpl: typeof fetch = (url, init) =>
    String(url).includes("test.finney")
      ? testnet.fetchImpl(url, init)
      : main.fetchImpl(url, init);
  return { main, testnet, fetchImpl };
}
function options(
  f: Awaited<ReturnType<typeof fixture>>,
  fetchImpl = nodes().fetchImpl,
) {
  return {
    d1CaptureStore: f.store,
    fetchImpl,
    now: () => 1000,
    sleepFn: async () => {},
    recordException: vi.fn(async () => false),
    endpointDeps: noPool,
  };
}

test("disabled and unbound D1 storage refuse before RPC; R2 cannot serve as a fallback", async () => {
  const f = await fixture();
  const rpc = vi.fn(async () => {
    throw new Error("must refuse before RPC");
  });
  for (const [over, reason] of [
    [{ RAW_CAPTURE_ENABLED: undefined }, "disabled"],
    [{ RAW_CAPTURE_STORAGE: "r2" }, "store_unavailable"],
    [{ RAW_CAPTURE_STORAGE: undefined }, "store_unavailable"],
    [{ D1_STATE: undefined }, "store_unavailable"],
    [
      {
        D1_STATE_TABLES: "lane_health",
        HYPERDRIVE: { connectionString: "postgres://fixture" },
      },
      "watermark_unavailable",
    ],
  ] as const) {
    const deps = options(f, rpc);
    const result = await runRawCaptureSync(
      { ...f.env, ...over } as never,
      deps,
    );
    assert.equal(result.reason, reason);
    assert.equal(result.skipped, true);
    assert.equal(
      deps.recordException.mock.calls.length,
      reason === "disabled" ? 0 : 1,
    );
  }
  assert.equal(rpc.mock.calls.length, 0);
  assert.equal(await f.store.canonical!.read("mainnet"), null);
});

test("a bound database also requires the native writer and canonical contract", async () => {
  const f = await fixture();
  const deps = options(f);
  assert.equal(
    (await runRawCaptureSync(f.env, { ...deps, d1CaptureStore: undefined }))
      .reason,
    "store_unavailable",
  );
  assert.equal(
    (
      await runRawCaptureSync(f.env, {
        ...deps,
        d1CaptureStore: {
          put: async () => {
            throw new Error("legacy capture must not run");
          },
        },
      })
    ).reason,
    "checkpoint_unavailable",
  );
  assert.equal(await f.store.canonical!.read("mainnet"), null);
});

test("production wiring captures each network through native receipts, resumes, and reports finalized lag", async () => {
  const f = await fixture(),
    n = nodes();
  const result = await runRawCaptureSync(f.env, options(f, n.fetchImpl));
  assert.equal(result.ok, true);
  assert.equal(result.captured, 5);
  for (const node of [n.main, n.testnet]) {
    const cp = await f.store.canonical!.read(node.network);
    assert.equal(cp?.height, node.head);
    assert.equal(cp?.hash, node.hash(node.head));
    assert.equal(cp?.verifiedFrom, node.first);
    assert.equal(cp?.revision, 1);
    assert.ok(
      node.requests.every(
        (r) => r.method !== "chain_getHeader" || r.params.length === 1,
      ),
    );
  }
  const proofs = await f.db
    .prepare("SELECT network,key FROM raw_capture_finality ORDER BY network")
    .all<{ network: string; key: string }>();
  assert.equal(proofs.results.length, 2);
  assert.match(proofs.results[0]!.key, /^chain\/raw\/blocks\//);
  assert.match(proofs.results[1]!.key, /^chain\/raw\/testnet\/blocks\//);
  const again = await runRawCaptureSync(f.env, options(f, n.fetchImpl));
  assert.equal(again.captured, 0);
  assert.equal(again.behind, 0);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) n FROM raw_capture_finality")
      .first<number>("n"),
    2,
  );
});

test("one failed network leaves the other intact and replaces its old healthy status", async () => {
  const f = await fixture(),
    n = nodes();
  await runRawCaptureSync(f.env, options(f, n.fetchImpl));
  const fetchImpl: typeof fetch = (url, init) =>
    String(url).includes("test.finney")
      ? Promise.reject(new Error("testnet unavailable"))
      : n.main.fetchImpl(url, init);
  const deps = { ...options(f, fetchImpl), now: () => 2000 };
  const result = await runRawCaptureSync(f.env, deps);
  assert.equal(result.ok, true);
  assert.equal(result.lanes?.find((l) => l.network === "mainnet")?.ok, true);
  assert.equal(result.lanes?.find((l) => l.network === "testnet")?.ok, false);
  assert.equal(deps.recordException.mock.calls.length, 1);
  const health = await f.db
    .prepare(
      "SELECT verdict FROM lane_health_current WHERE lane='raw-capture:testnet'",
    )
    .first<string>("verdict");
  assert.equal(health, "stale");
  await runRawCaptureSync(f.env, {
    ...options(f, n.fetchImpl),
    now: () => 3000,
  });
  assert.equal(
    await f.db
      .prepare(
        "SELECT verdict FROM lane_health_current WHERE lane='raw-capture:testnet'",
      )
      .first<string>("verdict"),
    "ok",
  );
});

test("partial capture persists its valid prefix, reports stalled zero-progress, and recovers at the same height", async () => {
  const f = await fixture();
  const floor = RAW_CAPTURE_LANES[0]!.genesisFloor;
  const n = nodes({ eventsAt: floor + 2 });
  const first = await runRawCaptureSync(f.env, options(f, n.fetchImpl));
  assert.equal(first.captured, 2);
  assert.equal(first.watermark, floor + 1);
  assert.equal(first.stoppedAt, floor + 2);
  const next = await runRawCaptureSync(f.env, {
    ...options(f, n.fetchImpl),
    now: () => 2000,
  });
  assert.equal(next.captured, 0);
  assert.equal(next.watermark, floor + 1);
  assert.equal(
    await f.db
      .prepare(
        "SELECT verdict FROM lane_health_current WHERE lane='raw-capture:mainnet'",
      )
      .first<string>("verdict"),
    "stale",
  );
  const good = nodes();
  const repaired = await runRawCaptureSync(f.env, {
    ...options(f, good.fetchImpl),
    now: () => 3000,
  });
  assert.equal(repaired.captured, 3);
  assert.equal(repaired.watermark, floor + 4);
});

test("the real cron factory's native commit cannot acknowledge an ignored frontier update", async () => {
  const f = await fixture();
  await f.db
    .prepare(
      "CREATE TRIGGER refuse_mainnet BEFORE UPDATE ON raw_capture_state WHEN NEW.network='mainnet' AND NEW.last_contiguous_block>OLD.last_contiguous_block BEGIN SELECT RAISE(IGNORE); END",
    )
    .run();
  const result = await runRawCaptureSync(f.env, {
    ...options(f),
    d1CaptureStore: rawCaptureD1(f.db),
  });
  assert.equal(result.lanes?.find((l) => l.network === "mainnet")?.ok, false);
  assert.match(result.reason!, /frontier CAS refused/);
  assert.equal(
    (await f.store.canonical!.read("mainnet"))?.height,
    RAW_CAPTURE_LANES[0]!.genesisFloor - 1,
  );
  assert.equal(
    await f.db
      .prepare(
        "SELECT count(*) n FROM raw_capture_finality WHERE network='mainnet'",
      )
      .first<number>("n"),
    0,
  );
  await f.db.prepare("DROP TRIGGER refuse_mainnet").run();
  assert.equal((await runRawCaptureSync(f.env, options(f))).captured, 5);
});

test("a pool member is actually used after qualifying the fixed genesis/finality/frontier anchors", async () => {
  const f = await fixture(),
    floor = RAW_CAPTURE_LANES[0]!.genesisFloor;
  const primary = nodes({ failAt: floor }),
    secondary = nodes();
  const fetchImpl: typeof fetch = (url, init) =>
    String(url).includes("secondary.example")
      ? secondary.main.fetchImpl(url, init)
      : primary.fetchImpl(url, init);
  const endpointDeps = {
    readArtifact: async () => ({
      ok: true,
      data: {
        pools: [
          {
            id: "finney-rpc",
            endpoints: [
              {
                url: "https://secondary.example",
                archive_support: true,
                pool_eligible: true,
              },
            ],
          },
        ],
      },
    }),
  };
  const result = await runRawCaptureSync(f.env, {
    ...options(f, fetchImpl),
    endpointDeps,
  });
  assert.equal(result.captured, 5);
  assert.ok(
    secondary.main.requests.some((r) => r.method === "state_getStorage"),
  );
  assert.ok(
    secondary.main.requests.some(
      (r) => r.method === "chain_getBlockHash" && r.params[0] === 0,
    ),
  );
});

test("an unreadable pool falls back to configured endpoints and non-Error failures stay visible", async () => {
  const f = await fixture(),
    n = nodes();
  const endpointDeps = {
    readArtifact: async () => {
      throw new Error("pool unavailable");
    },
  };
  assert.equal(
    (
      await runRawCaptureSync(f.env, {
        ...options(f, n.fetchImpl),
        endpointDeps,
      })
    ).captured,
    5,
  );
  const result = await runRawCaptureSync(f.env, {
    ...options(f),
    fetchImpl: async () => {
      throw "plain failure";
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason!, /plain failure/);
});

test("both lanes enter transport concurrently before either one has completed", async () => {
  const f = await fixture(),
    n = nodes();
  const seen = new Set<string>();
  let release!: () => void;
  const both = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetchImpl: typeof fetch = async (url, init) => {
    seen.add(String(url));
    if (seen.size >= 2) release();
    await both;
    return n.fetchImpl(url, init);
  };
  assert.equal(
    (await runRawCaptureSync(f.env, options(f, fetchImpl))).ok,
    true,
  );
  assert.equal(seen.size, 2);
});

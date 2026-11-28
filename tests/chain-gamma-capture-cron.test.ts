import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { handleScheduled, runChainGammaLane } from "../workers/api.ts";
import { SUBNET_BURN_CAPTURE_CRON } from "../workers/config.ts";
import { CHAIN_GAMMA_CAPTURE_TABLES } from "../src/chain-gamma-capture.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

// The Gamma capture rides the burn tick (src/chain-gamma-capture.ts). With no
// store bound, both lanes decline by name, each records its own verdict, and
// neither throws: the burn series' result is still what the cron reports.
test("the burn capture tick also captures gamma, each lane with its own verdict", async () => {
  const waited: Promise<unknown>[] = [];
  const result = (await handleScheduled(
    { cron: SUBNET_BURN_CAPTURE_CRON } as unknown as ScheduledController,
    {} as unknown as Env,
    {
      waitUntil(promise: Promise<unknown>) {
        waited.push(promise);
      },
    } as unknown as ExecutionContext,
  )) as Record<string, unknown>;
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_store_binding");
  // Both verdicts were scheduled, burn's and gamma's, and both settle.
  const settled = await Promise.allSettled(waited);
  assert.ok(settled.length >= 2);
  assert.ok(settled.every((s) => s.status === "fulfilled"));
});

/** A lane-health store that keeps each verdict it is handed. */
function verdicts() {
  const rows: unknown[][] = [];
  return {
    rows,
    LANE_HEALTH_STORE: {
      run: async (_text: string, values: unknown[]) => {
        rows.push(values);
        return { changes: 1 };
      },
      retentionReady: async () => false,
    },
  };
}

/** A native producer store that owns `tables` and accepts every write. */
function producer(tables: readonly string[]) {
  return {
    tables,
    store: {
      query: async () => [],
      first: async () => null,
      run: async () => ({ changes: 0 }),
      transaction: async (statements: readonly unknown[]) =>
        statements.map(() => ({ changes: 1 })),
    },
  };
}

test("a captured block is the lane's ok verdict", async () => {
  // An empty chain: a finalized head, and no value under any key it reads.
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const { id, method } = JSON.parse(String(init.body)) as {
      id: number;
      method: string;
    };
    const result =
      method === "chain_getFinalizedHead"
        ? "0xf1"
        : method === "chain_getHeader"
          ? { number: "0x928300" }
          : method === "state_queryStorageAt"
            ? [{ changes: [] }]
            : [];
    return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
      headers: { "content-type": "application/json" },
    });
  });
  const lane = verdicts();
  await runChainGammaLane(
    {
      NATIVE_PRODUCER_STORE: producer(CHAIN_GAMMA_CAPTURE_TABLES),
      LANE_HEALTH_STORE: lane.LANE_HEALTH_STORE,
    } as unknown as Env,
    {},
  );
  assert.equal(lane.rows.length, 1);
  const [name, verdict, , detail] = lane.rows[0];
  assert.equal(name, "chain-gamma");
  assert.equal(verdict, "ok");
  assert.match(String(detail), /^captured \d+$/);
});

test("a store that cannot open is the lane's stale verdict, never a throw", async () => {
  const lane = verdicts();
  // The selected native store owns another lane's table, not these.
  await runChainGammaLane(
    {
      NATIVE_PRODUCER_STORE: producer(["subnet_burn_history"]),
      LANE_HEALTH_STORE: lane.LANE_HEALTH_STORE,
    } as unknown as Env,
    {},
  );
  const [name, verdict, , detail] = lane.rows[0];
  assert.equal(name, "chain-gamma");
  assert.equal(verdict, "stale");
  assert.match(
    String(detail),
    /^store_unavailable: .*does not own every requested table/,
  );
});

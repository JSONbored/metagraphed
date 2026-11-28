import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import {
  buildHotkeyCommitment,
  buildSubnetCommitments,
  hotkeyPublicKey,
  loadHotkeyCommitment,
  loadSubnetCommitments,
} from "../src/subnet-commitments.ts";
import { selectedCommitmentsStore } from "../src/commitments-store.ts";
import { isFinneySs58Address } from "../src/finney-ss58.ts";
import {
  handleSubnetCommitments,
  handleSubnetHotkeyCommitment,
} from "../workers/request-handlers/entities.ts";
import {
  handleRequest,
  handleScheduled,
  runCommitmentsLane,
} from "../workers/api.ts";
import { SUBNET_BURN_CAPTURE_CRON } from "../workers/config.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import {
  HotkeyCommitmentArtifactSchema,
  SubnetCommitmentsArtifactSchema,
} from "../schemas-src/routes/subnet-commitments.ts";

type Row = Record<string, unknown>;

// The Substrate development account: a valid address that is nobody's
// hotkey, and its public key.
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ALICE_KEY =
  "d43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
// Address-shaped, with a checksum that does not hold.
const MISTYPED = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQZ";

const observation = {
  block_number: "9604440",
  observed_at_ms: "1795900000000",
};
const row = (overrides: Row = {}) => ({
  hotkey: ALICE_KEY,
  valid_from: "9604440",
  valid_to: null,
  committed_block: "9604000",
  deposit: "0",
  fields: [
    { kind: "raw", hex: "0x6869", text: "hi" },
    { kind: "timelock", hex: "0xabcd", reveal_round: 7 },
  ],
  reveals: [{ block: 9_603_000, hex: "0x1468656c6c6f", text: "hello" }],
  ...overrides,
});
const closed = row({
  valid_from: "9600000",
  valid_to: "9604440",
  fields: [{ kind: "none" }],
  reveals: [],
});

function fakeStore(overrides: Row = {}) {
  return {
    write: async () => ({ written: true, opened: 0, closed: 0 }),
    subnet: async () => ({ observation, total: 1, rows: [row()] }),
    hotkey: async () => ({ observation, rows: [row(), closed] }),
    ...overrides,
  };
}

const PAGE = { limit: 100, offset: 0 };

describe("the builders", () => {
  test("no store, or no observation, is the decline: no total and no rows", () => {
    for (const page of [null, { observation: null, total: 1, rows: [row()] }]) {
      const data = buildSubnetCommitments(page, 3, PAGE);
      assert.deepEqual(data, {
        schema_version: 1,
        netuid: 3,
        observed_block: null,
        observed_at: null,
        total: null,
        limit: 100,
        offset: 0,
        commitments: [],
      });
      SubnetCommitmentsArtifactSchema.parse(data);
    }
    const one = buildHotkeyCommitment(null, 3, ALICE);
    assert.deepEqual(
      [one.observed_block, one.exists, one.current, one.history],
      [null, null, null, []],
    );
    HotkeyCommitmentArtifactSchema.parse(one);
  });

  test("a subnet's page: SS58 hotkeys, every field read whole", () => {
    const data = buildSubnetCommitments(
      {
        observation,
        total: 2,
        rows: [
          row(),
          row({ fields: null, committed_block: null, deposit: null }),
        ],
      },
      3,
      PAGE,
    );
    SubnetCommitmentsArtifactSchema.parse(data);
    assert.equal(data.observed_block, 9_604_440);
    assert.equal(data.observed_at, "2026-11-28T21:06:40.000Z");
    assert.equal(data.total, 2);
    assert.deepEqual((data.commitments as Row[])[0], {
      hotkey: ALICE,
      valid_from: 9_604_440,
      commitment: {
        block: 9_604_000,
        deposit: "0",
        fields: [
          { kind: "raw", hex: "0x6869", text: "hi", reveal_round: null },
          { kind: "timelock", hex: "0xabcd", text: null, reveal_round: 7 },
        ],
      },
      reveals: [{ block: 9_603_000, hex: "0x1468656c6c6f", text: "hello" }],
    });
    // A hotkey holding only reveals has no commitment.
    assert.equal((data.commitments as Row[])[1].commitment, null);
  });

  test("a row that does not read whole is never served as one", () => {
    const bad = [
      { hotkey: "zz" },
      { valid_from: "x" },
      { reveals: null },
      { reveals: [null] },
      { reveals: [{ block: 1, hex: "zz" }] },
      { reveals: [{ hex: "0x00" }] },
      { reveals: [{ block: 1, hex: "0x00", text: 5 }] },
      { fields: "raw" },
      { fields: [null] },
      { fields: [{ kind: "hash" }] },
      { fields: [{ kind: "raw", hex: "0xz" }] },
      { fields: [{ kind: "raw", text: 1 }] },
      { fields: [{ kind: "timelock", reveal_round: -1 }] },
      { committed_block: null },
      { deposit: "-1" },
      { deposit: 0 },
    ];
    for (const overrides of bad) {
      const data = buildSubnetCommitments(
        { observation, total: 1, rows: [row(overrides)] },
        3,
        PAGE,
      );
      assert.deepEqual(data.commitments, [], JSON.stringify(overrides));
    }
  });

  test("one hotkey: its current state and its ranges, newest first", () => {
    const data = buildHotkeyCommitment(
      { observation, rows: [row(), closed] },
      3,
      ALICE,
    );
    HotkeyCommitmentArtifactSchema.parse(data);
    assert.equal(data.exists, true);
    assert.equal((data.current as Row).valid_to, null);
    assert.deepEqual(
      (data.history as Row[]).map((r) => [r.valid_from, r.valid_to]),
      [
        [9_604_440, null],
        [9_600_000, 9_604_440],
      ],
    );
    const gone = buildHotkeyCommitment(
      { observation, rows: [closed] },
      3,
      ALICE,
    );
    assert.deepEqual([gone.exists, gone.current], [false, null]);
  });

  test("an SS58 hotkey's public key, or nothing", () => {
    assert.equal(hotkeyPublicKey(ALICE), ALICE_KEY);
    assert.equal(hotkeyPublicKey(MISTYPED), null);
    assert.equal(hotkeyPublicKey("not-an-address"), null);
  });
});

describe("the store seam and its loaders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("no key means no store, which loads as the null decline", async () => {
    assert.equal(selectedCommitmentsStore({}), null);
    assert.equal(selectedCommitmentsStore(null), null);
    assert.equal(await loadSubnetCommitments({}, 3, PAGE), null);
    assert.equal(await loadHotkeyCommitment({}, 3, ALICE_KEY), null);
  });

  test("a key with the wrong shape is a configuration error, not a decline", () => {
    for (const store of [null, {}, { ...fakeStore(), hotkey: 1 }])
      assert.throws(
        () => selectedCommitmentsStore({ COMMITMENTS_STORE: store }),
        /Invalid native commitments store/,
      );
  });

  test("a failing read declines rather than erroring the route", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      COMMITMENTS_STORE: fakeStore({
        subnet: async () => Promise.reject(new Error("pool")),
        hotkey: async () => Promise.reject(new Error("pool")),
      }),
    };
    assert.equal(await loadSubnetCommitments(failing, 3, PAGE), null);
    assert.equal(await loadHotkeyCommitment(failing, 3, ALICE_KEY), null);
    assert.equal(error.mock.calls.length, 2);
  });
});

describe("the handlers and the router", () => {
  const ctx = {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
  const get = (path: string, env: unknown = {}) =>
    handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env as Env,
      ctx,
    );

  test("no bound store is the schema-stable decline on both routes", async () => {
    const list = await get("/api/v1/subnets/3/commitments");
    assert.equal(list.status, 200);
    const body = (await list.json()) as { data: Row; meta: Row };
    assert.deepEqual(
      [
        body.data.observed_block,
        body.data.total,
        body.data.limit,
        body.data.offset,
      ],
      [null, null, 100, 0],
    );
    assert.equal(
      body.meta.artifact_path,
      "/metagraph/subnets/3/commitments.json",
    );
    const one = await get(`/api/v1/subnets/3/commitments/${ALICE}`);
    assert.equal(one.status, 200);
    assert.equal(((await one.json()) as { data: Row }).data.exists, null);
  });

  test("a bound store serves both routes, the page as asked", async () => {
    const asked: unknown[] = [];
    const env = {
      COMMITMENTS_STORE: fakeStore({
        subnet: async (netuid: number, page: unknown) => {
          asked.push([netuid, page]);
          return { observation, total: 1, rows: [row()] };
        },
      }),
    };
    const list = (await (
      await get("/api/v1/subnets/3/commitments?limit=2&offset=1", env)
    ).json()) as { data: Row };
    assert.equal(list.data.total, 1);
    assert.deepEqual(asked, [[3, { limit: 2, offset: 1 }]]);
    const one = (await (
      await get(`/api/v1/subnets/3/commitments/${ALICE}`, env)
    ).json()) as { data: Row };
    assert.equal(one.data.exists, true);
    assert.equal(one.data.hotkey, ALICE);
  });

  test("a mistyped hotkey is a 400, an unshaped one names no route", async () => {
    assert.equal(isFinneySs58Address(MISTYPED), false);
    const mistyped = await get(`/api/v1/subnets/3/commitments/${MISTYPED}`);
    assert.equal(mistyped.status, 400);
    assert.match(await mistyped.text(), /invalid_ss58/);
    assert.equal(
      (await get("/api/v1/subnets/3/commitments/nobody")).status,
      404,
    );
    // The handler itself declines an address it cannot read.
    const direct = await handleSubnetHotkeyCommitment(
      new Request("https://api.metagraph.sh/api/v1/subnets/3/commitments/x"),
      { COMMITMENTS_STORE: fakeStore() } as unknown as Env,
      3,
      MISTYPED,
    );
    assert.equal(
      ((await direct.json()) as { data: Row }).data.observed_block,
      null,
    );
  });

  test("the page is the route's, and testnet has no variant", async () => {
    assert.equal(
      (await get("/api/v1/subnets/3/commitments?limit=257")).status,
      400,
    );
    assert.equal(
      (await get("/api/v1/subnets/3/commitments?cursor=a")).status,
      400,
    );
    assert.equal(
      (await get(`/api/v1/subnets/3/commitments/${ALICE}?limit=5`)).status,
      400,
    );
    assert.equal(
      (await get("/api/v1/testnet/subnets/3/commitments")).status,
      404,
    );
    const direct = await handleSubnetCommitments(
      new Request("https://api.metagraph.sh/api/v1/subnets/3/commitments"),
      {} as unknown as Env,
      3,
      new URL("https://api.metagraph.sh/api/v1/subnets/3/commitments"),
    );
    assert.equal(((await direct.json()) as { data: Row }).data.limit, 100);
  });
});

describe("the capture lane, hourly on the burn tick", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const verdicts = () => {
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
  };

  test("a written capture is the lane's ok verdict", async () => {
    // An empty chain: a finalized head, and no commitment under either map.
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const { id, method } = JSON.parse(String(init.body)) as {
        id: number;
        method: string;
      };
      const result =
        method === "chain_getFinalizedHead"
          ? "0xf1"
          : method === "chain_getHeader"
            ? { number: "0x928461" }
            : [];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        headers: { "content-type": "application/json" },
      });
    });
    const lane = verdicts();
    await runCommitmentsLane({
      COMMITMENTS_STORE: fakeStore(),
      LANE_HEALTH_STORE: lane.LANE_HEALTH_STORE,
    } as unknown as Env);
    const [name, verdict, , detail] = lane.rows[0];
    assert.equal(name, "commitments");
    assert.equal(verdict, "ok");
    assert.equal(detail, "0 commitments, 0 ranges changed");
  });

  test("no store, and a malformed one, are stale verdicts, never a throw", async () => {
    const unbound = verdicts();
    await runCommitmentsLane({
      LANE_HEALTH_STORE: unbound.LANE_HEALTH_STORE,
    } as unknown as Env);
    assert.deepEqual(
      [unbound.rows[0][1], unbound.rows[0][3]],
      ["stale", "no_store_binding"],
    );
    const malformed = verdicts();
    await runCommitmentsLane({
      COMMITMENTS_STORE: {},
      LANE_HEALTH_STORE: malformed.LANE_HEALTH_STORE,
    } as unknown as Env);
    assert.match(
      String(malformed.rows[0][3]),
      /^store_unavailable: TypeError: Invalid native commitments store/,
    );
  });

  test("the burn tick runs it on the hour's first tick only", async () => {
    const lanesAt = async (minute: number) => {
      const lane = verdicts();
      const waited: Promise<unknown>[] = [];
      await handleScheduled(
        {
          cron: SUBNET_BURN_CAPTURE_CRON,
          scheduledTime: Date.UTC(2026, 10, 28, 9, minute),
        } as unknown as ScheduledController,
        { LANE_HEALTH_STORE: lane.LANE_HEALTH_STORE } as unknown as Env,
        {
          waitUntil(promise: Promise<unknown>) {
            waited.push(promise);
          },
        } as unknown as ExecutionContext,
      );
      await Promise.allSettled(waited);
      return lane.rows.map((r) => r[0]);
    };
    assert.ok((await lanesAt(1)).includes("commitments"));
    assert.ok(!(await lanesAt(16)).includes("commitments"));
  });
});

describe("the MCP tools", () => {
  const tool = (name: string) => {
    const found = MCP_TOOLS.find((t) => t.name === name);
    assert.ok(found, `${name} must be registered`);
    return found as { handler: (a: Row, c: unknown) => Promise<unknown> };
  };

  test("no store is the decline, as on the routes", async () => {
    const list = (await tool("get_subnet_commitments").handler(
      { netuid: 3 },
      { env: {} },
    )) as Row;
    assert.deepEqual([list.total, list.limit, list.offset], [null, 100, 0]);
    const one = (await tool("get_subnet_hotkey_commitment").handler(
      { netuid: 3, hotkey: ALICE },
      { env: {} },
    )) as Row;
    assert.equal(one.exists, null);
  });

  test("a bound store serves both, the page clamped to the route's bound", async () => {
    const asked: unknown[] = [];
    const env = {
      COMMITMENTS_STORE: fakeStore({
        subnet: async (_netuid: number, page: unknown) => {
          asked.push(page);
          return { observation, total: 1, rows: [row()] };
        },
      }),
    };
    const list = (await tool("get_subnet_commitments").handler(
      { netuid: 3, limit: 999, offset: 4 },
      { env },
    )) as Row;
    assert.deepEqual(asked, [{ limit: 256, offset: 4 }]);
    SubnetCommitmentsArtifactSchema.parse(list);
    const one = (await tool("get_subnet_hotkey_commitment").handler(
      { netuid: 3, hotkey: ALICE },
      { env },
    )) as Row;
    HotkeyCommitmentArtifactSchema.parse(one);
    assert.equal(one.exists, true);
  });

  test("a mistyped hotkey is refused, never read", async () => {
    await assert.rejects(
      tool("get_subnet_hotkey_commitment").handler(
        { netuid: 3, hotkey: MISTYPED },
        { env: { COMMITMENTS_STORE: fakeStore() } },
      ),
      /finney SS58/,
    );
  });
});

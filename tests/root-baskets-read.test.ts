import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { loadRootBaskets } from "../src/root-baskets-read.ts";
import { RootBasketsArtifactSchema } from "../schemas-src/routes/root-baskets.ts";
import { BASKET_RUNTIME_API_ID } from "../src/root-basket-runtime.ts";
import {
  basketRuntimeFixture,
  BASKET_FIXTURE_BLOCK,
  BASKET_FIXTURE_HOTKEY,
} from "./fixtures/root-basket-runtime.ts";
import { CONCRETE_PATH_SS58 } from "./concrete-path.ts";
import { handleRequest } from "../workers/api.ts";
import { MCP_TOOLS } from "../src/mcp-server.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";

afterEach(() => vi.restoreAllMocks());

test("the shared reader returns bounded directory, fund and native account views", async () => {
  for (const [params, ss58, kind] of [
    [{}, undefined, "directory"],
    [{ hotkey: BASKET_FIXTURE_HOTKEY }, undefined, "fund"],
    [{ limit: 1 }, CONCRETE_PATH_SS58, "account"],
  ] as const) {
    const fixture = basketRuntimeFixture();
    const result = await loadRootBaskets(params, "mainnet", ss58, fixture.rpc);
    assert.equal(result.status, "available");
    assert.equal(result.data?.kind, kind);
    assert.equal(RootBasketsArtifactSchema.safeParse(result).success, true);
    assert.equal(result.source?.finalized_block_hash, BASKET_FIXTURE_BLOCK);
  }
  const empty = await loadRootBaskets(
    {},
    "testnet",
    undefined,
    basketRuntimeFixture({ get_all_beta_pricing: "0x0000" }).rpc,
  );
  assert.equal(empty.status, "available");
  assert.equal(empty.data?.kind, "directory");
  if (empty.data?.kind === "directory")
    assert.deepEqual(empty.data.pricing, []);
});

test("input failures and unsafe page resumes are rejected before RPC", async () => {
  const fixture = basketRuntimeFixture();
  for (const [params, ss58] of [
    [{ cursor: BASKET_FIXTURE_HOTKEY }, undefined],
    [{ hotkey: BASKET_FIXTURE_HOTKEY, limit: 1 }, undefined],
    [
      {
        hotkey: BASKET_FIXTURE_HOTKEY,
        cursor: BASKET_FIXTURE_HOTKEY,
        as_of: BASKET_FIXTURE_BLOCK,
      },
      undefined,
    ],
    [{ offset: 1 }, CONCRETE_PATH_SS58],
    [{ limit: 0 }, undefined],
    [{}, "invalid"],
  ] as const)
    await assert.rejects(loadRootBaskets(params, "mainnet", ss58, fixture.rpc));
  assert.equal(fixture.calls.length, 0);
  assert.equal(
    (
      await loadRootBaskets(
        { cursor: BASKET_FIXTURE_HOTKEY, as_of: BASKET_FIXTURE_BLOCK },
        "testnet",
        undefined,
        fixture.rpc,
      )
    ).status,
    "available",
  );
  assert.equal(
    (
      await loadRootBaskets(
        { offset: 1, as_of: BASKET_FIXTURE_BLOCK },
        "testnet",
        CONCRETE_PATH_SS58,
        fixture.rpc,
      )
    ).status,
    "available",
  );
});

test("unsupported layouts and failed reads remain distinct from confirmed empty", async () => {
  const old = basketRuntimeFixture({
    state_getRuntimeVersion: {
      specName: "node-subtensor",
      specVersion: 454,
      apis: [[BASKET_RUNTIME_API_ID, 3]],
    },
  });
  assert.deepEqual(await loadRootBaskets({}, "mainnet", undefined, old.rpc), {
    schema_version: 1,
    network: "finney",
    status: "unsupported",
    source: null,
    data: null,
  });
  const failed = basketRuntimeFixture({ get_all_beta_pricing: undefined });
  assert.deepEqual(
    await loadRootBaskets({}, "testnet", undefined, failed.rpc),
    {
      schema_version: 1,
      network: "test",
      status: "unavailable",
      source: null,
      data: null,
    },
  );
});

function stubNetwork() {
  const fixture = basketRuntimeFixture();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    const answer = async (row: {
      id: number;
      method: string;
      params: unknown[];
    }) => ({ id: row.id, result: await fixture.rpc(row.method, row.params) });
    return Response.json(
      Array.isArray(request)
        ? await Promise.all(request.map(answer))
        : await answer(request),
    );
  });
  return fixture;
}

test("admitted REST reads use the selected network's existing rate-limit bucket", async () => {
  stubNetwork();
  const keys: string[] = [];
  const env = {
    ...createLocalArtifactEnv(),
    RPC_RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: true };
      },
    },
  };
  for (const path of ["/api/v1/root-baskets", "/api/v1/testnet/root-baskets"]) {
    const response = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env as Env,
      {},
    );
    assert.equal(response.status, 200);
    const result = RootBasketsArtifactSchema.parse(
      (await response.json()).data,
    );
    assert.equal(result.status, "available");
    assert.equal(result.network, path.includes("testnet") ? "test" : "finney");
  }
  assert.match(keys[0]!, /^root-baskets:/);
  assert.match(keys[1]!, /^testnet:root-baskets:/);
});

test("REST and MCP share exact data, limits and network selection", async () => {
  const fixture = stubNetwork();
  const env = createLocalArtifactEnv();
  for (const [path, tool, args] of [
    ["/api/v1/root-baskets", "get_root_baskets", {}],
    [
      `/api/v1/root-baskets?hotkey=${BASKET_FIXTURE_HOTKEY}`,
      "get_root_baskets",
      { hotkey: BASKET_FIXTURE_HOTKEY },
    ],
    [
      `/api/v1/accounts/${CONCRETE_PATH_SS58}/root-baskets`,
      "get_account_root_baskets",
      { ss58: CONCRETE_PATH_SS58 },
    ],
  ] as const) {
    const response = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      env,
      {},
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    const result = await MCP_TOOLS.find((item) => item.name === tool)!.handler(
      args,
      { env },
    );
    assert.deepEqual(result, body.data);
    assert.equal(RootBasketsArtifactSchema.safeParse(result).success, true);
  }
  assert.ok(fixture.calls.length > 0);
  const result = await MCP_TOOLS.find(
    (item) => item.name === "get_root_baskets",
  )!.handler({ network: "test" }, { env });
  assert.equal(RootBasketsArtifactSchema.parse(result).network, "test");
});

test("REST and MCP reject malformed input and throttling without chain work", async () => {
  const fixture = stubNetwork();
  const env = createLocalArtifactEnv();
  for (const path of [
    "/api/v1/root-baskets?cursor=invalid",
    `/api/v1/root-baskets?cursor=${BASKET_FIXTURE_HOTKEY}`,
    `/api/v1/root-baskets?hotkey=${BASKET_FIXTURE_HOTKEY}&limit=1`,
    "/api/v1/accounts/invalid/root-baskets",
  ]) {
    assert.equal(
      (
        await handleRequest(
          new Request(`https://api.metagraph.sh${path}`),
          env,
          {},
        )
      ).status,
      400,
    );
  }
  const keys: string[] = [];
  const limited = {
    ...env,
    RPC_RATE_LIMITER: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      },
    },
  };
  for (const path of [
    "/api/v1/root-baskets",
    `/api/v1/accounts/${CONCRETE_PATH_SS58}/root-baskets`,
  ]) {
    const response = await handleRequest(
      new Request(`https://api.metagraph.sh${path}`),
      limited as Env,
      {},
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
  }
  for (const [tool, args] of [
    ["get_root_baskets", {}],
    ["get_account_root_baskets", { ss58: CONCRETE_PATH_SS58 }],
  ] as const) {
    const handler = MCP_TOOLS.find((item) => item.name === tool)!.handler;
    await assert.rejects(handler(args, { env: limited as Env }), /slow down/);
    await assert.rejects(handler({ ...args, limit: 0 }, { env }), /limit/);
    await assert.rejects(
      handler(
        {
          ...args,
          ...(tool === "get_root_baskets"
            ? { cursor: BASKET_FIXTURE_HOTKEY }
            : { offset: 1 }),
        },
        { env },
      ),
      /as_of/,
    );
  }
  await assert.rejects(
    MCP_TOOLS.find((item) => item.name === "get_account_root_baskets")!.handler(
      { ss58: "1".repeat(48) },
      { env },
    ),
    /finney/,
  );
  assert.ok(keys.every((key) => key.startsWith("root-baskets:")));
  assert.equal(fixture.calls.length, 0);
});

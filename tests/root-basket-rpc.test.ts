import assert from "node:assert/strict";
import { test } from "vitest";
import { rootBasketRpc } from "../src/root-basket-rpc.ts";
import { chainRpc, chainRpcBatch } from "../src/chain-rpc.ts";
import { loadRootBaskets } from "../src/root-baskets-read.ts";
import {
  basketRuntimeFixture,
  BASKET_FIXTURE_POSITION,
  BASKET_FIXTURE_CLAIM,
} from "./fixtures/root-basket-runtime.ts";
import { CONCRETE_PATH_SS58 } from "./concrete-path.ts";
import type { BasketRpc } from "../src/root-basket-runtime.ts";

function fixtureFetch(rpc: BasketRpc) {
  let requests = 0;
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests++;
    urls.push(String(input));
    assert.ok(init?.signal);
    const body = JSON.parse(String(init?.body));
    const answer = async (row: {
      id: number;
      method: string;
      params: unknown[];
    }) => ({
      jsonrpc: "2.0",
      id: row.id,
      result: await rpc(row.method, row.params),
    });
    // Deliberately reorder the batch: id correlation is mandatory.
    return Response.json(
      Array.isArray(body)
        ? (await Promise.all(body.map(answer))).reverse()
        : await answer(body),
    );
  };
  return { fetchImpl, requests: () => requests, urls };
}

test("bounded correlated batches preserve response bytes while removing transport requests", async () => {
  const hotkeys = Array.from({ length: 16 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const fixture = basketRuntimeFixture({
    state_getStorage: `0x40${hotkeys.join("")}`,
    get_beta_position: (params: unknown[]) =>
      `0x01${String(params[1]).slice(2, 66)}${BASKET_FIXTURE_POSITION.slice(64)}`,
    get_basket_claim_preview: (params: unknown[]) =>
      `0x01${String(params[1]).slice(2, 66)}${BASKET_FIXTURE_CLAIM.slice(64)}`,
  });
  const one = fixtureFetch(fixture.rpc);
  const singleTransport = rootBasketRpc("testnet", one.fetchImpl);
  const single: BasketRpc = (method, params) => singleTransport(method, params);
  const many = fixtureFetch(fixture.rpc);
  const batched = rootBasketRpc("testnet", many.fetchImpl);
  const oldResult = await loadRootBaskets(
    {},
    "testnet",
    CONCRETE_PATH_SS58,
    single,
  );
  const newResult = await loadRootBaskets(
    {},
    "testnet",
    CONCRETE_PATH_SS58,
    batched,
  );
  assert.equal(newResult.status, "available");
  assert.equal(JSON.stringify(newResult), JSON.stringify(oldResult));
  assert.equal(one.requests(), 38);
  assert.equal(many.requests(), 5);
  assert.ok(
    many.urls.every((url) => url === "https://test.finney.opentensor.ai:443"),
  );
  console.log(
    "ROOT_BASKET_FIXTURE_TRANSPORT",
    JSON.stringify({
      relationships: 16,
      http_requests_per_method: one.requests(),
      http_requests_batched: many.requests(),
      removed_requests: 33,
      response_bytes: Buffer.byteLength(JSON.stringify(newResult)),
      response_bytes_equal: true,
      production_observation: false,
    }),
  );
});

test("batch work budgets and read-only method admission apply before any fetch", async () => {
  const fixture = fixtureFetch(basketRuntimeFixture().rpc);
  const rpc = rootBasketRpc("mainnet", fixture.fetchImpl);
  assert.deepEqual(await rpc.batch!([]), []);
  await assert.rejects(rpc("author_submitExtrinsic", []), /read-only/);
  await assert.rejects(
    rpc.batch!([{ method: "author_submitExtrinsic", params: [] }]),
    /read-only/,
  );
  await assert.rejects(
    rpc.batch!(
      Array.from({ length: 33 }, () => ({
        method: "state_getStorage",
        params: [],
      })),
    ),
    /budget/,
  );
  assert.equal(fixture.requests(), 0);
  assert.deepEqual(
    await rpc.batch!([{ method: "state_getStorage", params: [] }]),
    [null],
  );
});

test("RPC and partial batch failures do not become zero or partial data", async () => {
  const responses = [
    new Response("failed", { status: 503 }),
    Response.json([{ id: 0, error: { message: "failed" } }]),
    Response.json([]),
    Response.json([
      { id: 0, result: null },
      { id: 0, result: null },
    ]),
    Response.json({ id: 0, result: null }),
    new Response("not JSON"),
  ];
  for (const response of responses) {
    const rpc = rootBasketRpc("mainnet", async () => response.clone());
    await assert.rejects(
      rpc.batch!([{ method: "state_getStorage", params: [] }]),
    );
  }
});

test("opt-in response limits count streamed bytes for singles and batches", async () => {
  for (const batch of [false, true]) {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(" ".repeat(100)));
      },
      cancel() {
        canceled = true;
      },
    });
    const options = {
      maxResponseBytes: 10,
      fetchImpl: async () => new Response(body),
    };
    await assert.rejects(
      batch
        ? chainRpcBatch(
            "https://fixture.invalid",
            [{ method: "state_getStorage", params: [] }],
            options,
          )
        : chainRpc("https://fixture.invalid", "state_getStorage", [], options),
      /not JSON/,
    );
    assert.equal(canceled, true);
  }
});

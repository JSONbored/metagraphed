// Pure-logic tests for the WSS LB upstream selection. Zero deps — run with:
//   node --test deploy/wss-lb/test/
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isWssUpstream,
  selectWssUpstreams,
  wssPoolFor,
} from "../src/select.mjs";

// A pool endpoint (the /api/v1/rpc/pools endpoints[] shape).
const ep = (over = {}) => ({
  id: "endpoint-x",
  url: "wss://node.example:443",
  kind: "subtensor-wss",
  pool_eligible: true,
  score: 100,
  status: "ok",
  latest_block: 1000,
  ...over,
});

// The pools artifact: a finney-wss pool plus noise pools the selector must skip.
const artifact = (wssEndpoints, extra = []) => ({
  pools: [
    { id: "finney-rpc", kind: "subtensor-rpc", endpoints: [ep()] },
    { id: "finney-wss", kind: "subtensor-wss", endpoints: wssEndpoints },
    ...extra,
  ],
});

test("isWssUpstream gates on pool_eligible + a wss:// url", () => {
  assert.equal(isWssUpstream(ep()), true);
  assert.equal(isWssUpstream(ep({ pool_eligible: false })), false);
  assert.equal(isWssUpstream(ep({ url: "https://node.example" })), false);
  assert.equal(isWssUpstream(null), false);
});

test("wssPoolFor selects the <network>-wss pool, not rpc/other", () => {
  const a = artifact([ep()]);
  assert.equal(wssPoolFor(a, "finney")?.id, "finney-wss");
  assert.equal(wssPoolFor(a, "test"), null);
});

test("orders by score desc and returns urls", () => {
  const urls = selectWssUpstreams(
    artifact([
      ep({ id: "a", url: "wss://a:443", score: 10 }),
      ep({ id: "b", url: "wss://b:443", score: 90 }),
      ep({ id: "c", url: "wss://c:443", score: 50 }),
    ]),
    "finney",
  );
  assert.deepEqual(urls, ["wss://b:443", "wss://c:443", "wss://a:443"]);
});

test("drops stale nodes lagging the tip beyond maxBlockLag", () => {
  const urls = selectWssUpstreams(
    artifact([
      ep({ id: "fresh", url: "wss://fresh:443", latest_block: 1000 }),
      ep({ id: "stale", url: "wss://stale:443", latest_block: 800 }),
    ]),
    "finney",
    { maxBlockLag: 50 },
  );
  assert.deepEqual(urls, ["wss://fresh:443"]);
});

test("keeps an endpoint with no reported block (benefit of the doubt)", () => {
  const urls = selectWssUpstreams(
    artifact([
      ep({ id: "fresh", url: "wss://fresh:443", latest_block: 1000 }),
      ep({ id: "noblock", url: "wss://noblock:443", latest_block: null }),
    ]),
    "finney",
  );
  assert.deepEqual(urls.sort(), ["wss://fresh:443", "wss://noblock:443"]);
});

test("static testnet wss (pool_eligible, status unknown, no block) is kept", () => {
  // Regression: gating on status==='ok' would wrongly drop the unmonitored
  // testnet pool, whose members are pool_eligible with status 'unknown'.
  const urls = selectWssUpstreams(
    {
      pools: [
        {
          id: "test-wss",
          kind: "subtensor-wss",
          endpoints: [
            ep({
              id: "t",
              url: "wss://test:443",
              status: "unknown",
              latest_block: null,
            }),
          ],
        },
      ],
    },
    "test",
  );
  assert.deepEqual(urls, ["wss://test:443"]);
});

test("empty when the pool is absent or has no eligible members", () => {
  assert.deepEqual(selectWssUpstreams({ pools: [] }, "finney"), []);
  assert.deepEqual(selectWssUpstreams({}, "finney"), []);
  assert.deepEqual(
    selectWssUpstreams(artifact([ep({ pool_eligible: false })]), "finney"),
    [],
  );
});

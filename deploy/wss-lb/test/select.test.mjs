// Pure-logic tests for the WSS LB upstream selection. Zero deps — run with:
//   node --test deploy/wss-lb/test/
import assert from "node:assert/strict";
import { test } from "node:test";

import { isHealthyWss, selectWssUpstreams } from "../src/select.mjs";

const ep = (over = {}) => ({
  id: "x",
  url: "wss://node.example:443",
  kind: "subtensor-wss",
  network: "finney",
  pool_eligible: true,
  score: 100,
  status: "ok",
  latest_block: 1000,
  ...over,
});

test("isHealthyWss rejects wrong kind/network/status/url/eligibility", () => {
  const ok = isHealthyWss("finney");
  assert.equal(ok(ep()), true);
  assert.equal(ok(ep({ kind: "subtensor-rpc" })), false);
  assert.equal(ok(ep({ network: "test" })), false);
  assert.equal(ok(ep({ status: "down" })), false);
  assert.equal(ok(ep({ pool_eligible: false })), false);
  assert.equal(ok(ep({ url: "https://node.example" })), false);
  assert.equal(ok(null), false);
});

test("orders by score desc and returns urls", () => {
  const urls = selectWssUpstreams(
    [
      ep({ id: "a", url: "wss://a:443", score: 10 }),
      ep({ id: "b", url: "wss://b:443", score: 90 }),
      ep({ id: "c", url: "wss://c:443", score: 50 }),
    ],
    "finney",
  );
  assert.deepEqual(urls, ["wss://b:443", "wss://c:443", "wss://a:443"]);
});

test("drops stale nodes lagging the tip beyond maxBlockLag", () => {
  const urls = selectWssUpstreams(
    [
      ep({ id: "fresh", url: "wss://fresh:443", latest_block: 1000 }),
      ep({ id: "stale", url: "wss://stale:443", latest_block: 800 }),
    ],
    "finney",
    { maxBlockLag: 50 },
  );
  assert.deepEqual(urls, ["wss://fresh:443"]);
});

test("keeps an endpoint with no reported block (benefit of the doubt)", () => {
  const urls = selectWssUpstreams(
    [
      ep({ id: "fresh", url: "wss://fresh:443", latest_block: 1000 }),
      ep({ id: "noblock", url: "wss://noblock:443", latest_block: null }),
    ],
    "finney",
  );
  assert.deepEqual(urls.sort(), ["wss://fresh:443", "wss://noblock:443"]);
});

test("only the requested network is selected", () => {
  const urls = selectWssUpstreams(
    [
      ep({ id: "f", url: "wss://f:443", network: "finney" }),
      ep({ id: "t", url: "wss://t:443", network: "test" }),
    ],
    "test",
  );
  assert.deepEqual(urls, ["wss://t:443"]);
});

test("empty when nothing is healthy", () => {
  assert.deepEqual(selectWssUpstreams([], "finney"), []);
  assert.deepEqual(selectWssUpstreams([ep({ status: "down" })], "finney"), []);
});

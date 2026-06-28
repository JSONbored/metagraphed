// Drift guard: the wss-lb ships a SELF-CONTAINED copy of the RPC safety policy
// (deploy/wss-lb/src/rpc-policy.mjs) because its standalone container can't import
// workers/config.mjs. This test fails CI if that copy drifts from the source of
// truth, so the public WSS proxy never enforces a stale allowlist.
import assert from "node:assert/strict";

import { test } from "vitest";

import * as worker from "../workers/config.mjs";
import * as wsslb from "../deploy/wss-lb/src/rpc-policy.mjs";

test("wss-lb RPC policy matches workers/config.mjs (no drift)", () => {
  assert.equal(wsslb.MAX_RPC_BODY_BYTES, worker.MAX_RPC_BODY_BYTES);
  assert.deepEqual(wsslb.DENIED_RPC_PREFIXES, worker.DENIED_RPC_PREFIXES);
  assert.deepEqual(
    [...wsslb.SAFE_RPC_METHODS].sort(),
    [...worker.SAFE_RPC_METHODS].sort(),
  );
  assert.deepEqual(
    [...wsslb.SAFE_RPC_SUBSCRIPTIONS].sort(),
    [...worker.SAFE_RPC_SUBSCRIPTIONS].sort(),
  );
});

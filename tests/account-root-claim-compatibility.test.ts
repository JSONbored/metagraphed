import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { loadAccountRootClaim } from "../src/account-root-claim.ts";
import { AccountRootClaimArtifactSchema } from "../schemas-src/routes/account-root-claim.ts";
import { handleRequest } from "../workers/api.ts";
import { mockEnv } from "./row-type.ts";

const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const HASH = `0x${"12".repeat(32)}`;
const VERSION = { specName: "node-subtensor", specVersion: 440 };

afterEach(() => vi.unstubAllGlobals());

function fixture(version: unknown = VERSION, storage: unknown[] = []) {
  const calls: { method: string; params: unknown[]; url: string }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const rpc = JSON.parse(String(init.body));
    calls.push({ ...rpc, url });
    if (rpc.method === "chain_getFinalizedHead")
      return Response.json({ result: HASH });
    assert.equal(rpc.params.at(-1), HASH);
    const result =
      rpc.method === "state_getRuntimeVersion"
        ? version
        : (storage.shift() ?? null);
    return Response.json({ result });
  });
  return calls;
}

// Source-derived runtime fixtures: v440 e4ffa2e, v441 8b9d55c, v450
// 9540b3a, v453 823bdcb, v454 14cde64. Full source links and the
// retired-storage/default declarations are in docs/root-claim-compatibility.md.
test.each([441, 450, 453, 454, 455])(
  "runtime %i cannot read legacy balances",
  async (specVersion) => {
    const calls = fixture({ ...VERSION, specVersion });
    const result = await loadAccountRootClaim(mockEnv(), SS58);
    assert.equal(result.compatibility.status, "unsupported");
    assert.equal(result.compatibility.reason, "root_reborn");
    assert.equal(result.compatibility.spec_version, specVersion);
    assert.equal(result.compatibility.block_hash, HASH);
    assert.equal(result.compatibility.claim_type_source, null);
    assert.equal(result.claim_type, null);
    assert.equal(result.hotkeys, null);
    assert.deepEqual(
      calls.map((c) => c.method),
      ["chain_getFinalizedHead", "state_getRuntimeVersion"],
    );
    AccountRootClaimArtifactSchema.parse(result);
  },
);

test("audited v440 applies explicit defaults and distinguishes an empty real position", async () => {
  const calls = fixture();
  const result = await loadAccountRootClaim(mockEnv(), SS58);
  assert.equal(result.compatibility.status, "legacy_supported");
  assert.equal(result.compatibility.claim_type_source, "runtime_default");
  assert.deepEqual(result.claim_type, { kind: "Swap" });
  assert.deepEqual(result.hotkeys, []);
  assert.equal(calls.length, 5);
  AccountRootClaimArtifactSchema.parse(result);
});

test.each([
  { specName: "different-runtime", specVersion: 440 },
  { ...VERSION, specVersion: 439 },
])("unverified runtime %j remains unavailable", async (version) => {
  const calls = fixture(version);
  const result = await loadAccountRootClaim(mockEnv(), SS58);
  assert.equal(result.compatibility.status, "unavailable");
  assert.equal(result.compatibility.reason, "unverified_runtime");
  assert.equal(result.claim_type, null);
  assert.equal(result.hotkeys, null);
  assert.equal(calls.length, 2);
});

test.each([
  null,
  "v440",
  {},
  { specName: 5, specVersion: 440 },
  { ...VERSION, specVersion: -1 },
  { ...VERSION, specVersion: "440" },
  { ...VERSION, specVersion: 440.5 },
  { ...VERSION, specVersion: Number.MAX_SAFE_INTEGER + 1 },
])("malformed runtime %j does not imply support", async (version) => {
  const calls = fixture(version);
  const result = await loadAccountRootClaim(mockEnv(), SS58);
  assert.equal(result.compatibility.status, "unavailable");
  assert.equal(result.compatibility.reason, "rpc_or_decode_failure");
  assert.equal(result.claim_type, null);
  assert.equal(result.hotkeys, null);
  assert.equal(calls.length, 2);
});

test.each([null, 42, "0x12", "0xzz", undefined])(
  "invalid finalized hash %j stops before runtime/storage",
  async (result) => {
    const fetchSpy = vi.fn(async () => Response.json({ result }));
    vi.stubGlobal("fetch", fetchSpy);
    const payload = await loadAccountRootClaim(mockEnv(), SS58);
    assert.equal(payload.compatibility.status, "unavailable");
    assert.equal(payload.compatibility.block_hash, null);
    assert.equal(fetchSpy.mock.calls.length, 1);
  },
);

test("runtime RPC failure cannot reuse a successful cached legacy position", async () => {
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const { method } = JSON.parse(String(init.body));
    return Response.json(
      method === "chain_getFinalizedHead"
        ? { result: HASH }
        : { error: { code: -1 } },
    );
  });
  const result = await loadAccountRootClaim(
    mockEnv({
      METAGRAPH_CONTROL: {
        async get() {
          return {
            schema_version: 1,
            ss58: SS58,
            claim_type: { kind: "Swap" },
            hotkeys: [],
            compatibility: { spec_name: "node-subtensor", spec_version: 440 },
          };
        },
      },
    }),
    SS58,
  );
  assert.equal(result.compatibility.status, "unavailable");
  assert.equal(result.claim_type, null);
});

test("upgrade invalidates cached legacy defaults and uses the v2 network namespace", async () => {
  let value: unknown = null;
  const keys: string[] = [];
  const env = mockEnv({
    METAGRAPH_CONTROL: {
      async get(key: string) {
        keys.push(key);
        return value;
      },
      async put(key: string, body: string) {
        keys.push(key);
        value = JSON.parse(body);
      },
    },
  });
  fixture();
  assert.equal(
    (await loadAccountRootClaim(env, SS58, "testnet")).compatibility.status,
    "legacy_supported",
  );
  const calls = fixture({ ...VERSION, specVersion: 454 });
  const upgraded = await loadAccountRootClaim(env, SS58, "testnet");
  assert.equal(upgraded.compatibility.status, "unsupported");
  assert.equal(upgraded.claim_type, null);
  assert.equal(upgraded.hotkeys, null);
  assert.ok(
    keys.every((key) =>
      [
        `testnet:root-claim:v2:${SS58}`,
        `testnet:root-claim:v2:${SS58}:failure:v1`,
      ].includes(key),
    ),
  );
  assert.ok(calls.every((call) => call.url.includes("test.finney")));
});

test("old cache bodies without compatibility cannot bypass the guard", async () => {
  const calls = fixture({ ...VERSION, specVersion: 454 });
  const result = await loadAccountRootClaim(
    mockEnv({
      METAGRAPH_CONTROL: {
        async get() {
          return {
            schema_version: 1,
            ss58: SS58,
            claim_type: { kind: "Swap" },
            hotkeys: [],
          };
        },
      },
    }),
    SS58,
  );
  assert.equal(result.compatibility.status, "unsupported");
  assert.equal(result.claim_type, null);
  assert.equal(calls.length, 2);
});

test("legacy absent threshold uses the proven 500000 default while explicit zero stays zero", async () => {
  const hotkeys = `0x04${"01".repeat(32)}`;
  const claimable = `0x040100${"00".repeat(16)}`;
  for (const [threshold, expected] of [
    [null, 500_000],
    [`0x${"00".repeat(16)}`, 0],
  ] as const) {
    fixture(VERSION, ["0x01", hotkeys, null, claimable, null, threshold]);
    const result = await loadAccountRootClaim(mockEnv(), SS58);
    assert.equal(result.hotkeys?.[0].entries[0].threshold, expected);
    assert.equal(result.hotkeys?.[0].entries[0].claimed, "0");
    assert.equal(result.compatibility.claim_type_source, "storage");
  }
});

test("legacy oversized positions are unavailable rather than silently truncated", async () => {
  fixture(VERSION, [null, `0x0501${"01".repeat(32 * 65)}`]);
  const result = await loadAccountRootClaim(mockEnv(), SS58);
  assert.equal(result.compatibility.reason, "legacy_limit_exceeded");
  assert.equal(result.hotkeys, null);
});

test("non-string storage and missing JSON-RPC envelopes never become defaults", async () => {
  for (const value of [42, {}, false]) {
    fixture(VERSION, [value]);
    const result = await loadAccountRootClaim(mockEnv(), SS58);
    assert.equal(result.compatibility.status, "unavailable");
    assert.equal(result.claim_type, null);
  }
  vi.stubGlobal("fetch", async () => Response.json(null));
  assert.equal(
    (await loadAccountRootClaim(mockEnv(), SS58)).compatibility.status,
    "unavailable",
  );
});

test("REST returns coherent unsupported metadata without legacy storage reads", async () => {
  const calls = fixture({ ...VERSION, specVersion: 454 });
  const response = await handleRequest(
    new Request(`https://api.metagraph.sh/api/v1/accounts/${SS58}/root-claim`),
    mockEnv(),
    {},
  );
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.compatibility.status, "unsupported");
  assert.equal(body.data.hotkeys, null);
  assert.equal(calls.length, 2);
  AccountRootClaimArtifactSchema.parse(body.data);
});

test("legacy missing claimable map is an explicitly supported empty map", async () => {
  fixture(VERSION, ["0x01", `0x04${"01".repeat(32)}`, null, null]);
  const result = await loadAccountRootClaim(mockEnv(), SS58);
  assert.equal(result.compatibility.status, "legacy_supported");
  assert.deepEqual(result.hotkeys?.[0].entries, []);
});

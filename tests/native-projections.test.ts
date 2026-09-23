import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, test, vi } from "vitest";
import {
  computeNativeProjections,
  nativeProjectionProtocol,
  parseProtocolLine,
  MAX_PROTOCOL_BYTES,
} from "../scripts/compute-native-projections.ts";
import {
  projectionComputeEnv,
  projectionNow,
  projectionQuery,
} from "../src/projection-compute-context.ts";
import { PROJECTION_LANES } from "../src/projection-lanes.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import type { R2SqlReader } from "../src/r2-sql.ts";
import type { ChainNetworkId } from "../src/chain-network.ts";

const fixture = JSON.parse(
  gunzipSync(
    readFileSync(
      new URL("./fixtures/native-projections/native.json.gz", import.meta.url),
    ),
  ).toString(),
) as {
  now: number;
  queries: Record<string, Record<string, unknown>[]>;
  artifacts: Record<string, { key: string; body: Record<string, unknown> }[]>;
};
afterEach(() => vi.restoreAllMocks());

const native: R2SqlReader = async (_env, sql) => {
  assert.ok(Object.hasOwn(fixture.queries, sql), sql);
  return structuredClone(fixture.queries[sql]);
};

test("all canonical lanes reproduce native SQL artifacts on both networks", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Native computation must never contact R2 SQL");
  });
  const results = await Promise.all(
    (["mainnet", "testnet"] as const).map(async (network) => {
      const artifacts = await computeNativeProjections(
        network,
        fixture.now,
        native,
      );
      assert.deepEqual(artifacts, fixture.artifacts[network]);
      assert.equal(artifacts.length, PROJECTION_LANES.length + 2);
      assert.ok(
        artifacts.every(
          ({ body }) =>
            body.generated_at === new Date(fixture.now).toISOString(),
        ),
      );
      return artifacts;
    }),
  );
  assert.notDeepEqual(results[0], results[1]);
  const fees = results[0].find(({ key }) =>
    key.endsWith("/chain-fees.json"),
  )!.body;
  assert.ok(JSON.stringify(fees).includes("median_fee_tao"));
  assert.equal(vi.mocked(fetch).mock.calls.length, 0);
});

test("native invocation context is isolated and cannot leak into normal Worker calls", () => {
  const env = {} as Env;
  const first = projectionComputeEnv(env, { query: native, now: 7 });
  const second = projectionComputeEnv(env, { query: native, now: 9 });
  assert.notEqual(first, env);
  assert.equal(projectionNow(first), 7);
  assert.equal(projectionNow(second), 9);
  assert.equal(projectionQuery(first), native);
  assert.equal(projectionQuery(env), undefined);
  vi.spyOn(Date, "now").mockReturnValue(11);
  assert.equal(projectionNow(env), 11);
  for (const now of [-1, 0.5, NaN, Infinity])
    assert.throws(
      () => projectionComputeEnv(env, { query: native, now }),
      /capture time/,
    );
  resetModuleState();
  assert.equal(projectionQuery(first), undefined);
});

test("a missing native result declines without publishing a successful prefix", async () => {
  await assert.rejects(
    computeNativeProjections("mainnet", fixture.now, async () => null),
    /blocks-summary/,
  );
  await assert.rejects(
    computeNativeProjections("other" as ChainNetworkId, fixture.now, native),
    /network/,
  );
});

test("the subprocess protocol reproduces every native result and publishes once", async () => {
  let next: unknown = { network: "testnet", now: fixture.now };
  const sent: { type: string; [key: string]: unknown }[] = [];
  await nativeProjectionProtocol(
    async () => next,
    (value) => {
      const message = value as (typeof sent)[number];
      sent.push(message);
      if (message.type === "query") {
        const sql = message.sql as string;
        assert.ok(Object.hasOwn(fixture.queries, sql));
        next = { id: message.id, rows: structuredClone(fixture.queries[sql]) };
      }
    },
  );
  assert.equal(sent.filter(({ type }) => type === "complete").length, 1);
  assert.deepEqual(sent.at(-1)!.artifacts, fixture.artifacts.testnet);
  assert.equal(sent.at(-1)!.now, fixture.now);
});

test("protocol rejects mispaired or malformed rows and oversized frames", async () => {
  for (const response of [
    null,
    {},
    { id: 2, rows: [] },
    { id: 1, rows: [null] },
    { id: 1, rows: [[]] },
    { id: 1, rows: [1] },
  ]) {
    let calls = 0;
    const sent: unknown[] = [];
    await assert.rejects(
      nativeProjectionProtocol(
        async () =>
          calls++ === 0 ? { network: "mainnet", now: fixture.now } : response,
        (value) => sent.push(value),
      ),
      /Invalid native query response/,
    );
    assert.equal(sent.length, 1);
  }
  assert.deepEqual(parseProtocolLine('{"ok":true}'), { ok: true });
  assert.throws(() => parseProtocolLine("{"));
  assert.throws(
    () => parseProtocolLine("x".repeat(MAX_PROTOCOL_BYTES + 1)),
    /budget/,
  );
});

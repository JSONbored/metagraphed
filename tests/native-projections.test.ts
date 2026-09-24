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
  projectionModulePredicate,
} from "../src/projection-compute-context.ts";
import { PROJECTION_LANES } from "../src/projection-lanes.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import type { HistoricalQueryReader } from "../src/history-readers.ts";
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

const native: HistoricalQueryReader = async (_env, sql) => {
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
  assert.equal(projectionModulePredicate(env), "");
  assert.equal(projectionModulePredicate(first), "");
  const scoped = projectionComputeEnv(env, {
    query: native,
    now: 7,
    callModule: "Quote'Module",
  });
  assert.equal(
    projectionModulePredicate(scoped),
    " AND call_module = 'Quote''Module'",
  );
  resetModuleState();
  assert.equal(projectionModulePredicate(scoped), "");
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

test("module-specific readers preserve exact canonical windows, limits and absent-module answers", async () => {
  const { loadChainCallsFromArtifact } =
    await import("../src/chain-calls-artifact.ts");
  const { loadChainFeesFromArtifact } =
    await import("../src/chain-fees-artifact.ts");
  const { loadChainSignersFromArtifact } =
    await import("../src/chain-signers-artifact.ts");
  const readers = [
    {
      file: "chain-calls.json",
      load: loadChainCallsFromArtifact,
      variants: [{ groupBy: "module" }, { groupBy: "module_function" }],
    },
    {
      file: "chain-fees.json",
      load: loadChainFeesFromArtifact,
      variants: [{}],
    },
    {
      file: "chain-signers.json",
      load: loadChainSignersFromArtifact,
      variants: [{ sort: "tx_count" }, { sort: "total_fee_tao" }],
    },
  ];
  const bucketEnv = (body: Record<string, unknown>) =>
    ({
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            async json() {
              return body;
            },
          };
        },
      },
    }) as unknown as Env;
  for (const network of ["mainnet", "testnet"] as const) {
    for (const reader of readers) {
      const body = fixture.artifacts[network].find((item) =>
        item.key.endsWith("/" + reader.file),
      )!.body;
      const moduleWindows = Object.fromEntries(
        (
          body.module_windows as {
            module: string;
            windows: Record<string, unknown>;
          }[]
        ).map((entry) => [entry.module, entry.windows]),
      );
      const empty = body.empty_module_windows as Record<string, unknown>;
      assert.ok(Object.hasOwn(moduleWindows, "Quote'Module"));
      assert.ok(Object.hasOwn(moduleWindows, "__proto__"));
      for (const callModule of [
        ...Object.keys(moduleWindows),
        "constructor",
        "never-seen",
      ]) {
        const windows = Object.hasOwn(moduleWindows, callModule)
          ? moduleWindows[callModule]
          : empty;
        for (const window of Object.keys(windows))
          for (const variant of reader.variants)
            for (const limit of [1, 100]) {
              const query = { window, limit, ...variant };
              const expected = await reader.load(
                bucketEnv({ ...body, windows }),
                query,
                network,
              );
              assert.ok(expected);
              assert.deepEqual(
                await reader.load(
                  bucketEnv(body),
                  { ...query, callModule },
                  network,
                ),
                expected,
              );
            }
      }
      const window = Object.keys(body.windows as object)[0];
      for (const change of [
        { module_windows: undefined },
        { empty_module_windows: undefined },
        { module_windows: [{ module: "Balances", windows: {} }] },
        {
          module_windows: [{ module: "Balances", windows: { [window]: null } }],
        },
      ])
        assert.equal(
          await reader.load(
            bucketEnv({ ...body, ...change }),
            { callModule: "Balances", window },
            network,
          ),
          null,
        );
    }
  }
});

test("native module census and each canonical computation must complete before publication", async () => {
  for (const census of [
    null,
    Array.from({ length: 1025 }, () => ({ call_module: "x" })),
    [{ call_module: 7 }],
    [{ call_module: "x".repeat(1025) }],
  ]) {
    await assert.rejects(
      computeNativeProjections("mainnet", fixture.now, async (env, sql) =>
        sql.startsWith("SELECT DISTINCT call_module")
          ? census
          : native(env, sql),
      ),
      /module census/,
    );
  }
  const lane = PROJECTION_LANES.find((item) => item.name === "chain-calls")!;
  const original = lane.compute;
  const failModule = vi
    .spyOn(lane, "compute")
    .mockImplementationOnce(original)
    .mockResolvedValueOnce(null);
  await assert.rejects(
    computeNativeProjections("mainnet", fixture.now, native),
    /Module projection declined/,
  );
  failModule.mockRestore();
  const failEmpty = vi
    .spyOn(lane, "compute")
    .mockImplementation(async (env, network) =>
      projectionQuery(env) === native ? original(env, network) : null,
    );
  await assert.rejects(
    computeNativeProjections("mainnet", fixture.now, native),
    /Empty module projection declined/,
  );
  failEmpty.mockRestore();
});

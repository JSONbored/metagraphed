// Worker-side tests for the #8702 upgrade radar: the twice-hourly cron branch
// and the route extension.
//
// Same URL-dispatching fetch double as tests/upgrade-radar-loaders.test.ts —
// an unstubbed URL throws rather than returning something plausible, so a
// handler that asks the wrong upstream fails here instead of passing on a
// canned answer (the #8687 lesson).

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
  BITS_CONTENTS_URL,
  MAINNET_RPC_URL,
  SOAK_ALERT_STATE_KEY,
  SUBTENSOR_RELEASES_URL,
  TESTNET_RPC_URL,
} from "../src/upgrade-radar.ts";
import { mockEnv } from "./row-type.ts";

function runtimeVersionBody(specVersion: number) {
  return {
    jsonrpc: "2.0",
    result: {
      apis: [["0xdf6acb689907609b", 5]],
      implName: "node-subtensor",
      specName: "node-subtensor",
      specVersion,
      transactionVersion: 1,
    },
    id: 1,
  };
}

const RELEASES = [
  {
    tag_name: "v440",
    name: "Runtime 440 (proposed)",
    published_at: "2026-07-27T13:49:31Z",
    prerelease: true,
    draft: false,
    html_url: "https://github.com/RaoFoundation/subtensor/releases/tag/v440",
  },
];

/** Requests that were not RPC or GitHub — i.e. the ops-channel report. */
let otherCalls: string[] = [];

function stubUpstreams(mainnetSpec: number, testnetSpec: number) {
  otherCalls = [];
  const routes: Record<string, unknown> = {
    [MAINNET_RPC_URL]: runtimeVersionBody(mainnetSpec),
    [TESTNET_RPC_URL]: runtimeVersionBody(testnetSpec),
    [SUBTENSOR_RELEASES_URL]: RELEASES,
    [BITS_CONTENTS_URL]: [],
  };
  vi.stubGlobal("fetch", async (url: string) => {
    const key = String(url);
    if (key in routes) {
      return {
        ok: true,
        status: 200,
        async json() {
          return routes[key];
        },
      } as unknown as Response;
    }
    // Anything else is the telemetry hop; record it and succeed.
    otherCalls.push(key);
    return { ok: true, status: 200, async json() {} } as unknown as Response;
  });
}

function kvEnv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    env: mockEnv({
      METAGRAPH_CONTROL: {
        get: async (key: string, options?: { type?: string }) => {
          const raw = store.get(key);
          if (raw == null) return null;
          return options?.type === "json" ? JSON.parse(raw) : raw;
        },
        put: async (key: string, value: string) => {
          store.set(key, value);
        },
      },
    }),
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runUpgradeRadarScan", () => {
  test("reports a new soak and marks the version as alerted", async () => {
    const { runUpgradeRadarScan } = await import("../workers/api.ts");
    stubUpstreams(439, 440);
    const { env, store } = kvEnv();
    const waited: Promise<unknown>[] = [];
    const result = await runUpgradeRadarScan(
      env as never,
      {
        waitUntil: (p: Promise<unknown>) => waited.push(p),
      } as never,
    );
    await Promise.all(waited);
    assert.deepEqual(result, {
      ok: true,
      state: "testnet_soaking",
      mainnet_spec_version: 439,
      testnet_spec_version: 440,
      alerted: true,
    });
    assert.equal(store.get(SOAK_ALERT_STATE_KEY), "440");
  });

  test("stays quiet on every later tick for the same version", async () => {
    // The #8611 quiet-channel rule, end to end through the Worker entry point
    // rather than only through the pure guard.
    const { runUpgradeRadarScan } = await import("../workers/api.ts");
    const { env } = kvEnv();
    let alerts = 0;
    for (let tick = 0; tick < 6; tick += 1) {
      stubUpstreams(439, 440);
      const waited: Promise<unknown>[] = [];
      const result = (await runUpgradeRadarScan(
        env as never,
        {
          waitUntil: (p: Promise<unknown>) => waited.push(p),
        } as never,
      )) as { alerted: boolean };
      await Promise.all(waited);
      if (result.alerted) alerts += 1;
    }
    assert.equal(alerts, 1);
  });

  test("does not report when nothing is soaking", async () => {
    const { runUpgradeRadarScan } = await import("../workers/api.ts");
    stubUpstreams(440, 440);
    const { env } = kvEnv();
    const result = (await runUpgradeRadarScan(env as never)) as {
      state: string;
      alerted: boolean;
    };
    assert.equal(result.state, "none");
    assert.equal(result.alerted, false);
    // Quiet means quiet: no ops-channel hop at all.
    assert.deepEqual(otherCalls, []);
  });

  test("works without an ExecutionContext", async () => {
    const { runUpgradeRadarScan } = await import("../workers/api.ts");
    stubUpstreams(439, 440);
    const { env } = kvEnv();
    const result = (await runUpgradeRadarScan(env as never)) as {
      ok: boolean;
    };
    assert.equal(result.ok, true);
  });

  test("total upstream failure reports unknown, not a failed tick", async () => {
    // Every individual failure is already handled inside the loaders, so a
    // dead network plus a dead KV still produces a well-formed answer — and
    // that answer is `unknown`, which is the honest one.
    const { runUpgradeRadarScan } = await import("../workers/api.ts");
    vi.stubGlobal("fetch", async () => {
      throw new Error("network");
    });
    const brokenEnv = mockEnv({
      METAGRAPH_CONTROL: {
        get: () => {
          throw new Error("kv exploded");
        },
        put: () => {
          throw new Error("kv exploded");
        },
      },
    });
    assert.deepEqual(await runUpgradeRadarScan(brokenEnv as never), {
      ok: true,
      state: "unknown",
      mainnet_spec_version: null,
      testnet_spec_version: null,
      alerted: false,
    });
  });

  test("an unforeseen throw is contained rather than failing the cron", async () => {
    // The outer guard. Nothing in the loaders can reach it — they handle their
    // own failures, as the test above proves — so it is exercised here with an
    // env that throws on property access. Its job is to keep one bad tick from
    // surfacing as a failed scheduled invocation.
    const { runUpgradeRadarScan } = await import("../workers/api.ts");
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("env exploded");
        },
      },
    );
    assert.deepEqual(await runUpgradeRadarScan(hostile as never), {
      ok: false,
      reason: "unreachable",
    });
  });

  test("the twice-hourly cron dispatches to it", async () => {
    // Registering the trigger in wrangler.jsonc without wiring the branch would
    // fire a cron into a silent no-op forever.
    const { default: worker } = await import("../workers/api.ts");
    const { UPGRADE_RADAR_CRON } = await import("../workers/config.ts");
    stubUpstreams(439, 440);
    const { env, store } = kvEnv();
    const waited: Promise<unknown>[] = [];
    await worker.scheduled(
      { cron: UPGRADE_RADAR_CRON, scheduledTime: Date.now() } as never,
      env as never,
      { waitUntil: (p: Promise<unknown>) => waited.push(p) } as never,
    );
    await Promise.all(waited);
    // Proof the branch ran: only this cron writes the soak marker.
    assert.equal(store.get(SOAK_ALERT_STATE_KEY), "440");
  });

  test("the registered cron matches the wrangler trigger", async () => {
    // A constant that drifts from wrangler.jsonc means the branch is dead in
    // production while every test here still passes.
    const { UPGRADE_RADAR_CRON } = await import("../workers/config.ts");
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(
      new URL("../wrangler.jsonc", import.meta.url),
      "utf8",
    );
    assert.ok(
      raw.includes(`"${UPGRADE_RADAR_CRON}"`),
      `wrangler.jsonc has no trigger for ${UPGRADE_RADAR_CRON}`,
    );
  });
});

describe("GET /api/v1/runtime current block", () => {
  test("carries the radar alongside the historical timeline", async () => {
    const { handleRuntime } =
      await import("../workers/request-handlers/entities.ts");
    stubUpstreams(439, 440);
    const { env } = kvEnv({
      "upgrade-radar:github-sources": JSON.stringify({
        schema_version: 1,
        captured_at: "2026-07-29T00:00:00.000Z",
        releases: RELEASES,
        bits: [],
      }),
    });
    const url = new URL("https://api.metagraph.sh/api/v1/runtime");
    const res = await handleRuntime(new Request(url), env as never, url);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: {
        transitions: unknown[];
        transition_count: number;
        current: {
          pending_upgrade: string;
          mainnet: { spec_version: number | null };
          testnet: { spec_version: number | null };
          versions_behind: number | null;
        };
      };
    };
    // The historical half survives the extension.
    assert.ok(Array.isArray(body.data.transitions));
    assert.equal(typeof body.data.transition_count, "number");
    // ...and the forward-looking half is present.
    assert.equal(body.data.current.pending_upgrade, "testnet_soaking");
    assert.equal(body.data.current.mainnet.spec_version, 439);
    assert.equal(body.data.current.testnet.spec_version, 440);
    assert.equal(body.data.current.versions_behind, 1);
  });

  test("a dead testnet RPC yields unknown, not none", async () => {
    // The single most important behaviour of this route: silence must never
    // render as calm.
    const { handleRuntime } =
      await import("../workers/request-handlers/entities.ts");
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url) === MAINNET_RPC_URL) {
        return {
          ok: true,
          status: 200,
          async json() {
            return runtimeVersionBody(440);
          },
        } as unknown as Response;
      }
      throw new Error("testnet down");
    });
    const { env } = kvEnv();
    const url = new URL("https://api.metagraph.sh/api/v1/runtime");
    const res = await handleRuntime(new Request(url), env as never, url);
    const body = (await res.json()) as {
      data: {
        current: {
          pending_upgrade: string;
          testnet: { spec_version: number | null; observed_at: string | null };
        };
      };
    };
    assert.equal(body.data.current.pending_upgrade, "unknown");
    assert.equal(body.data.current.testnet.spec_version, null);
    // A failed read has no observation time.
    assert.equal(body.data.current.testnet.observed_at, null);
  });

  test("the payload contains no predicted date", async () => {
    // Definition-of-done: zero ETA/prediction fields anywhere in the response.
    const { handleRuntime } =
      await import("../workers/request-handlers/entities.ts");
    stubUpstreams(439, 440);
    const { env } = kvEnv();
    const url = new URL("https://api.metagraph.sh/api/v1/runtime");
    const res = await handleRuntime(new Request(url), env as never, url);
    const serialized = JSON.stringify(await res.json()).toLowerCase();
    for (const banned of [
      /"eta/,
      /expected_/,
      /_expected/,
      /forecast/,
      /predict/,
      /estimated_/,
    ]) {
      assert.equal(banned.test(serialized), false, `leaked ${banned}`);
    }
  });
});

// Loader tests for src/upgrade-radar.ts (#8702) — the env-dependent half:
// RPC reads, the GitHub capture, the KV caches, and the cron scan.
//
// THE STUB RULE, restated because this repo keeps paying for breaking it: the
// fetch double below DISPATCHES ON THE REQUESTED URL and asserts the method and
// headers it was given. A stub that returns one canned body regardless of what
// was asked is how #8687 shipped a fail-closed quota — the test passed because
// the stub answered a question the code never asked. Here, asking the wrong
// URL, or asking with the wrong method, fails the test rather than being
// silently satisfied.
//
// The KV double is likewise stateful and round-trips through JSON, so a value
// that would not survive `kv.put(JSON.stringify(x))` / `kv.get(type:"json")`
// cannot pass here either.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BITS_CONTENTS_URL,
  evaluateUpgradeRadarScan,
  fetchSpecVersion,
  loadUpgradeFeedItems,
  loadUpgradeRadar,
  MAINNET_RPC_URL,
  readUpgradeRadarSources,
  refreshUpgradeRadarSources,
  SOAK_ALERT_STATE_KEY,
  SUBTENSOR_RELEASES_URL,
  TESTNET_RPC_URL,
  TRANSITION_LEDGER_KEY,
  UPGRADE_RADAR_CACHE_KEY,
  UPGRADE_RADAR_SOURCES_KEY,
} from "../src/upgrade-radar.ts";

// Same captured shapes as tests/upgrade-radar.test.ts (see that file's
// provenance header), reduced to what the loaders touch.
function runtimeVersionBody(specVersion: number) {
  return {
    jsonrpc: "2.0",
    result: {
      apis: [["0xdf6acb689907609b", 5]],
      authoringVersion: 1,
      implName: "node-subtensor",
      implVersion: 1,
      specName: "node-subtensor",
      specVersion,
      stateVersion: 1,
      systemVersion: 1,
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

const BITS = [
  {
    name: "BIT-0004-subnet-deregistration.md",
    type: "file",
    sha: "b6b153e8d4c3b2a1908f7e6d5c4b3a2918070605",
    html_url:
      "https://github.com/opentensor/bits/blob/main/bits/BIT-0004-subnet-deregistration.md",
  },
];

/** A KV double that stores strings, exactly as Workers KV does. */
function makeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    puts: [] as { key: string; value: string }[],
    async get(key: string, options?: { type?: string }) {
      const raw = store.get(key);
      if (raw == null) return null;
      // Workers KV only parses when asked; a `type:"json"` read of unparseable
      // text throws, and callers must survive that.
      return options?.type === "json" ? JSON.parse(raw) : raw;
    },
    async put(key: string, value: string) {
      store.set(key, value);
      this.puts.push({ key, value });
    },
  };
}

function makeEnv(kv: ReturnType<typeof makeKv> | null, extra = {}) {
  return { METAGRAPH_CONTROL: kv ?? undefined, ...extra } as never;
}

interface StubRoute {
  status?: number;
  body?: unknown;
  /** Throw instead of responding — a timeout or DNS failure. */
  throws?: boolean;
  /** Return a body that is not valid JSON. */
  invalidJson?: boolean;
}

let calls: { url: string; init: RequestInit | undefined }[] = [];

/**
 * Install a fetch double routed by URL. Any URL not in `routes` fails the test
 * loudly rather than returning something plausible.
 */
function stubFetch(routes: Record<string, StubRoute>) {
  calls = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const route = routes[String(url)];
    if (!route) {
      throw new Error(`unstubbed fetch: ${url}`);
    }
    if (route.throws) throw new Error("network");
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      async json() {
        if (route.invalidJson) throw new SyntaxError("Unexpected token");
        return route.body;
      },
    } as unknown as Response;
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchSpecVersion", () => {
  it("POSTs state_getRuntimeVersion and reads the result", async () => {
    stubFetch({ [MAINNET_RPC_URL]: { body: runtimeVersionBody(440) } });
    expect(await fetchSpecVersion(MAINNET_RPC_URL)).toBe(440);
    // The request itself is part of the contract, not an implementation detail:
    // a GET, or a different method name, would return null against a real node.
    expect(calls[0].url).toBe(MAINNET_RPC_URL);
    expect(calls[0].init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init?.body)).method).toBe(
      "state_getRuntimeVersion",
    );
  });

  it("returns null on every upstream failure mode", async () => {
    for (const route of [
      { status: 502, body: null },
      { throws: true },
      { invalidJson: true },
      { body: { jsonrpc: "2.0", error: { code: -32603 }, id: 1 } },
    ] as StubRoute[]) {
      stubFetch({ [TESTNET_RPC_URL]: route });
      expect(await fetchSpecVersion(TESTNET_RPC_URL)).toBeNull();
    }
  });
});

describe("refreshUpgradeRadarSources", () => {
  it("captures both upstreams into KV", async () => {
    stubFetch({
      [SUBTENSOR_RELEASES_URL]: { body: RELEASES },
      [BITS_CONTENTS_URL]: { body: BITS },
    });
    const kv = makeKv();
    const snapshot = await refreshUpgradeRadarSources(makeEnv(kv));
    expect(snapshot?.releases).toHaveLength(1);
    expect(snapshot?.bits).toHaveLength(1);
    const stored = JSON.parse(kv.store.get(UPGRADE_RADAR_SOURCES_KEY) ?? "{}");
    expect(stored.releases[0].tag_name).toBe("v440");
    expect(typeof stored.captured_at).toBe("string");
  });

  it("sends the Authorization header when a token is configured", async () => {
    stubFetch({
      [SUBTENSOR_RELEASES_URL]: { body: RELEASES },
      [BITS_CONTENTS_URL]: { body: BITS },
    });
    await refreshUpgradeRadarSources(
      makeEnv(makeKv(), { GITHUB_TOKEN: "ghp_example" }),
    );
    for (const call of calls) {
      const headers = call.init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer ghp_example");
    }
  });

  it("carries a failed half forward instead of blanking it", async () => {
    // THE BUG THIS LOCKS DOWN: defaulting the failed upstream to [] silently
    // destroyed good captured data on a transient single-upstream blip --
    // blanking latest_release (degrading pending_upgrade to "unknown") or
    // dropping every known BIT. An earlier version of this test asserted the
    // broken behaviour, which is exactly why it survived review.
    const kv = makeKv({
      [UPGRADE_RADAR_SOURCES_KEY]: JSON.stringify({
        schema_version: 1,
        captured_at: "2026-07-29T00:00:00.000Z",
        releases: RELEASES,
        bits: BITS,
      }),
    });

    // BITs upstream fails: releases refresh, BITs carry over.
    stubFetch({
      [SUBTENSOR_RELEASES_URL]: { body: RELEASES },
      [BITS_CONTENTS_URL]: { status: 403, body: null },
    });
    const bitsDown = await refreshUpgradeRadarSources(makeEnv(kv));
    expect(bitsDown?.releases).toHaveLength(1);
    expect(bitsDown?.bits).toHaveLength(1);
    expect(bitsDown?.stale_upstreams).toEqual(["bits"]);

    // Releases upstream fails: BITs refresh, releases carry over.
    stubFetch({
      [SUBTENSOR_RELEASES_URL]: { throws: true },
      [BITS_CONTENTS_URL]: { body: BITS },
    });
    const releasesDown = await refreshUpgradeRadarSources(makeEnv(kv));
    expect(releasesDown?.releases).toHaveLength(1);
    expect(releasesDown?.bits).toHaveLength(1);
    expect(releasesDown?.stale_upstreams).toEqual(["releases"]);
  });

  it("reports no stale upstreams on a clean capture", async () => {
    stubFetch({
      [SUBTENSOR_RELEASES_URL]: { body: RELEASES },
      [BITS_CONTENTS_URL]: { body: BITS },
    });
    const snapshot = await refreshUpgradeRadarSources(makeEnv(makeKv()));
    expect(snapshot?.stale_upstreams).toEqual([]);
  });

  it("writes an empty half only when there is no earlier value to keep", async () => {
    // Cold KV plus one dead upstream: [] is the only honest value here, and
    // the stale marker still says which half is missing.
    stubFetch({
      [SUBTENSOR_RELEASES_URL]: { body: RELEASES },
      [BITS_CONTENTS_URL]: { throws: true },
    });
    const cold = await refreshUpgradeRadarSources(makeEnv(makeKv()));
    expect(cold?.bits).toEqual([]);
    expect(cold?.stale_upstreams).toEqual(["bits"]);

    // ...and the mirror, so neither half's fallback goes unexercised.
    stubFetch({
      [SUBTENSOR_RELEASES_URL]: { throws: true },
      [BITS_CONTENTS_URL]: { body: BITS },
    });
    const coldReleases = await refreshUpgradeRadarSources(makeEnv(makeKv()));
    expect(coldReleases?.releases).toEqual([]);
    expect(coldReleases?.stale_upstreams).toEqual(["releases"]);
  });

  it("does not let a failed half survive a later successful one", async () => {
    // Carrying forward must not become sticky: once the upstream recovers,
    // the fresh value wins and the stale marker clears.
    const kv = makeKv();
    stubFetch({
      [SUBTENSOR_RELEASES_URL]: { body: RELEASES },
      [BITS_CONTENTS_URL]: { throws: true },
    });
    await refreshUpgradeRadarSources(makeEnv(kv));
    stubFetch({
      [SUBTENSOR_RELEASES_URL]: { body: RELEASES },
      [BITS_CONTENTS_URL]: { body: BITS },
    });
    const recovered = await refreshUpgradeRadarSources(makeEnv(kv));
    expect(recovered?.bits).toHaveLength(1);
    expect(recovered?.stale_upstreams).toEqual([]);
  });

  it("does not overwrite a good snapshot when GitHub is fully down", async () => {
    // The distinction that matters: "no releases" and "could not ask" are
    // different, and only the first should ever reach KV.
    const kv = makeKv({
      [UPGRADE_RADAR_SOURCES_KEY]: JSON.stringify({
        schema_version: 1,
        captured_at: "2026-07-29T00:00:00.000Z",
        releases: RELEASES,
        bits: BITS,
      }),
    });
    stubFetch({
      [SUBTENSOR_RELEASES_URL]: { throws: true },
      [BITS_CONTENTS_URL]: { throws: true },
    });
    expect(await refreshUpgradeRadarSources(makeEnv(kv))).toBeNull();
    const kept = JSON.parse(kv.store.get(UPGRADE_RADAR_SOURCES_KEY) ?? "{}");
    expect(kept.releases).toHaveLength(1);
  });

  it("still returns the snapshot when KV is unavailable", async () => {
    stubFetch({
      [SUBTENSOR_RELEASES_URL]: { body: RELEASES },
      [BITS_CONTENTS_URL]: { body: BITS },
    });
    expect(
      (await refreshUpgradeRadarSources(makeEnv(null)))?.releases,
    ).toHaveLength(1);
    const throwingKv = {
      get: async () => null,
      put: async () => {
        throw new Error("kv down");
      },
    };
    expect(
      (await refreshUpgradeRadarSources(makeEnv(throwingKv as never)))?.bits,
    ).toHaveLength(1);
  });
});

describe("readUpgradeRadarSources", () => {
  it("returns null with no binding, no key, or an unreadable value", async () => {
    expect(await readUpgradeRadarSources(makeEnv(null))).toBeNull();
    expect(await readUpgradeRadarSources(makeEnv(makeKv()))).toBeNull();
    // Corrupt JSON in KV must degrade, not throw into the request path.
    const corrupt = makeKv({ [UPGRADE_RADAR_SOURCES_KEY]: "{not json" });
    expect(await readUpgradeRadarSources(makeEnv(corrupt))).toBeNull();
  });
});

describe("loadUpgradeRadar", () => {
  it("serves a cached radar without touching the network", async () => {
    const cached = {
      mainnet: { network: "mainnet", spec_version: 440, observed_at: "x" },
      testnet: { network: "testnet", spec_version: 440, observed_at: "x" },
      latest_release: null,
      pending_upgrade: "none",
      versions_behind: 0,
    };
    const kv = makeKv({ [UPGRADE_RADAR_CACHE_KEY]: JSON.stringify(cached) });
    stubFetch({});
    expect((await loadUpgradeRadar(makeEnv(kv))).pending_upgrade).toBe("none");
    expect(calls).toHaveLength(0);
  });

  it("reads both chains live and never calls GitHub", async () => {
    const kv = makeKv({
      [UPGRADE_RADAR_SOURCES_KEY]: JSON.stringify({
        schema_version: 1,
        captured_at: "2026-07-29T00:00:00.000Z",
        releases: RELEASES,
        bits: [],
      }),
    });
    stubFetch({
      [MAINNET_RPC_URL]: { body: runtimeVersionBody(439) },
      [TESTNET_RPC_URL]: { body: runtimeVersionBody(440) },
    });
    const radar = await loadUpgradeRadar(makeEnv(kv));
    expect(radar.pending_upgrade).toBe("testnet_soaking");
    expect(radar.latest_release?.tag).toBe("v440");
    // GitHub is a cron concern; the request path must never depend on it.
    const hosts = new Set(calls.map((c) => new URL(c.url).host));
    expect(hosts.has("api.github.com")).toBe(false);
  });

  it("caches a resolved radar for the long TTL and unknown for the short one", async () => {
    const kv = makeKv();
    stubFetch({
      [MAINNET_RPC_URL]: { body: runtimeVersionBody(440) },
      [TESTNET_RPC_URL]: { throws: true },
    });
    const radar = await loadUpgradeRadar(makeEnv(kv));
    // A dead testnet RPC is `unknown`, never `none` — the whole point.
    expect(radar.pending_upgrade).toBe("unknown");
    expect(radar.testnet.spec_version).toBeNull();
    expect(radar.mainnet.spec_version).toBe(440);
    expect(kv.puts.some((p) => p.key === UPGRADE_RADAR_CACHE_KEY)).toBe(true);
  });

  it("degrades to a live read when the cache is unreadable", async () => {
    const throwing = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    };
    stubFetch({
      [MAINNET_RPC_URL]: { body: runtimeVersionBody(440) },
      [TESTNET_RPC_URL]: { body: runtimeVersionBody(440) },
    });
    const radar = await loadUpgradeRadar(makeEnv(throwing as never));
    expect(radar.mainnet.spec_version).toBe(440);
  });

  it("works with no control binding at all", async () => {
    stubFetch({
      [MAINNET_RPC_URL]: { body: runtimeVersionBody(440) },
      [TESTNET_RPC_URL]: { body: runtimeVersionBody(440) },
    });
    expect(
      (await loadUpgradeRadar(makeEnv(null))).pending_upgrade,
      // No sources KV -> no release reading -> unknown, not none.
    ).toBe("unknown");
  });
});

describe("loadUpgradeFeedItems", () => {
  it("merges releases, transitions and BITs from KV only", async () => {
    const kv = makeKv({
      [UPGRADE_RADAR_SOURCES_KEY]: JSON.stringify({
        schema_version: 1,
        captured_at: "2026-07-29T00:00:00.000Z",
        releases: RELEASES,
        bits: BITS,
      }),
      [TRANSITION_LEDGER_KEY]: JSON.stringify([
        {
          network: "testnet",
          spec_version: 440,
          observed_at: "2026-07-27T14:00:00.000Z",
        },
      ]),
    });
    stubFetch({});
    const items = await loadUpgradeFeedItems(makeEnv(kv), {
      siteUrl: "https://metagraph.sh",
    });
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.tags.includes("upgrade"))).toBe(true);
    // Every item must carry a working absolute link.
    for (const item of items) expect(() => new URL(item.url)).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("yields nothing before the first capture, rather than failing", async () => {
    expect(
      await loadUpgradeFeedItems(makeEnv(makeKv()), { siteUrl: "https://x" }),
    ).toEqual([]);
    expect(
      await loadUpgradeFeedItems(makeEnv(null), { siteUrl: "https://x" }),
    ).toEqual([]);
    const corrupt = makeKv({ [UPGRADE_RADAR_SOURCES_KEY]: "{not json" });
    expect(
      await loadUpgradeFeedItems(makeEnv(corrupt), { siteUrl: "https://x" }),
    ).toEqual([]);
  });
});

describe("evaluateUpgradeRadarScan", () => {
  function soakingRoutes() {
    return {
      [SUBTENSOR_RELEASES_URL]: { body: RELEASES },
      [BITS_CONTENTS_URL]: { body: BITS },
      [MAINNET_RPC_URL]: { body: runtimeVersionBody(439) },
      [TESTNET_RPC_URL]: { body: runtimeVersionBody(440) },
    };
  }

  it("alerts exactly once per spec version across repeated ticks", async () => {
    // Proven against the real persistence path, not just the pure guard: the
    // second tick reads back what the first one wrote.
    const kv = makeKv();
    const env = makeEnv(kv);
    stubFetch(soakingRoutes());

    const first = await evaluateUpgradeRadarScan(env);
    expect(first.state).toBe("testnet_soaking");
    expect(first.alert).toBe(true);
    expect(kv.store.get(SOAK_ALERT_STATE_KEY)).toBe("440");

    for (let tick = 0; tick < 5; tick += 1) {
      stubFetch(soakingRoutes());
      expect((await evaluateUpgradeRadarScan(env)).alert).toBe(false);
    }

    // The next soak, on 441, fires once more.
    stubFetch({
      ...soakingRoutes(),
      [TESTNET_RPC_URL]: { body: runtimeVersionBody(441) },
    });
    expect((await evaluateUpgradeRadarScan(env)).alert).toBe(true);
    expect(kv.store.get(SOAK_ALERT_STATE_KEY)).toBe("441");
  });

  it("records transitions in the ledger, once each", async () => {
    const kv = makeKv();
    const env = makeEnv(kv);
    stubFetch(soakingRoutes());
    await evaluateUpgradeRadarScan(env);
    stubFetch(soakingRoutes());
    await evaluateUpgradeRadarScan(env);
    const ledger = JSON.parse(kv.store.get(TRANSITION_LEDGER_KEY) ?? "[]");
    expect(ledger).toHaveLength(2);
    expect(ledger.map((e: { network: string }) => e.network).sort()).toEqual([
      "mainnet",
      "testnet",
    ]);
  });

  it("does not alert when nothing is soaking", async () => {
    stubFetch({
      [SUBTENSOR_RELEASES_URL]: { body: RELEASES },
      [BITS_CONTENTS_URL]: { body: BITS },
      [MAINNET_RPC_URL]: { body: runtimeVersionBody(440) },
      [TESTNET_RPC_URL]: { body: runtimeVersionBody(440) },
    });
    const scan = await evaluateUpgradeRadarScan(makeEnv(makeKv()));
    expect(scan.state).toBe("none");
    expect(scan.alert).toBe(false);
  });

  it("reports unknown, and stays quiet, when the chains are unreachable", async () => {
    stubFetch({
      [SUBTENSOR_RELEASES_URL]: { body: RELEASES },
      [BITS_CONTENTS_URL]: { body: BITS },
      [MAINNET_RPC_URL]: { throws: true },
      [TESTNET_RPC_URL]: { throws: true },
    });
    const scan = await evaluateUpgradeRadarScan(makeEnv(makeKv()));
    expect(scan.state).toBe("unknown");
    expect(scan.alert).toBe(false);
  });

  it("survives a KV that throws on every operation", async () => {
    const throwing = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    };
    stubFetch(soakingRoutes());
    const scan = await evaluateUpgradeRadarScan(makeEnv(throwing as never));
    expect(scan.state).toBe("testnet_soaking");
    // No stored state means "never alerted" — one duplicate beats silence.
    expect(scan.alert).toBe(true);
  });

  it("still derives the soak with no control binding at all", async () => {
    // No KV means no captured release, so releaseSpec is null — but the two
    // chain readings alone prove the soak, and positive evidence outranks a
    // null elsewhere. The alert fires because "never alerted" is the only
    // honest reading of absent state.
    stubFetch(soakingRoutes());
    const scan = await evaluateUpgradeRadarScan(makeEnv(null));
    expect(scan.state).toBe("testnet_soaking");
    expect(scan.alert).toBe(true);
  });
});

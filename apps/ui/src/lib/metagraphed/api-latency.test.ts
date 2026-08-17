// The footer health dot's measurement, after it stopped issuing its own probe.
//
// `useEndpointHealth` used to fetch `/api/v1/coverage` every 30 seconds, on
// every page, for as long as the tab stayed open. Measured 2026-08-16, one
// account page load issued that URL TWICE -- once for the data it renders and
// once purely to time it -- and over a ten-minute session the probe alone was
// ~20 requests that render nothing.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiLatencySnapshot,
  recordApiLatency,
  resetApiLatency,
  subscribeApiLatency,
} from "./api-latency";

afterEach(() => {
  resetApiLatency();
  vi.unstubAllGlobals();
});

describe("the api latency store", () => {
  it("has no sample before the page has called anything", () => {
    // SSR and the first client pass both land here, and they must agree --
    // returning a number would hydrate a dot the client then changes.
    expect(apiLatencySnapshot()).toBeNull();
  });

  it("keeps the NEWEST sample, not the first", () => {
    recordApiLatency(120);
    recordApiLatency(35);
    expect(apiLatencySnapshot()?.ms).toBe(35);
  });

  it("A FAILURE IS A SAMPLE, not an absence", () => {
    // `ms: null` is what the dot renders as "down". Dropping it would leave
    // the last successful number on screen while nothing works, which is the
    // failure a health dot exists to prevent.
    recordApiLatency(40);
    recordApiLatency(null);
    expect(apiLatencySnapshot()?.ms).toBeNull();
  });

  it("stamps each sample, so a stale one can be told from a fresh one", () => {
    vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ["Date"] });
    try {
      recordApiLatency(10);
      expect(apiLatencySnapshot()?.at).toBe(1_700_000_000_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("notifies every subscriber, and stops on unsubscribe", () => {
    let a = 0;
    let b = 0;
    const offA = subscribeApiLatency(() => (a += 1));
    subscribeApiLatency(() => (b += 1));
    recordApiLatency(1);
    expect([a, b]).toEqual([1, 1]);
    offA();
    recordApiLatency(2);
    expect([a, b]).toEqual([1, 2]);
  });
});

describe("apiFetch feeds the store", () => {
  /** A fresh module graph, so the store's module state cannot leak between
   * cases -- and so `buildUrl` re-reads the network from the stubbed window. */
  async function freshClient(host = "metagraph.sh", stored = {}) {
    vi.resetModules();
    vi.stubGlobal("window", {
      location: { hostname: host, host, origin: `https://${host}` },
      localStorage: {
        getItem: (k: string) => (stored as Record<string, string>)[k] ?? null,
        setItem: () => undefined,
      },
    });
    return {
      client: await import("./client"),
      store: await import("./api-latency"),
    };
  }

  it("records the round trip of a real call", async () => {
    const { client, store } = await freshClient();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ ok: true, data: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await client.apiFetch("/api/v1/coverage");
    const sample = store.apiLatencySnapshot();
    expect(sample).not.toBeNull();
    expect(typeof sample?.ms).toBe("number");
  });

  it("records a NETWORK FAILURE as down", async () => {
    const { client, store } = await freshClient();
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    await expect(client.apiFetch("/api/v1/coverage")).rejects.toThrow();
    expect(store.apiLatencySnapshot()?.ms).toBeNull();
  });

  it("AN ABORT IS NOT A MEASUREMENT", async () => {
    // React Query cancels in-flight requests on unmount and on every keystroke
    // behind a debounce. Reporting those as "down" would paint the dot red on
    // ordinary navigation.
    const { client, store } = await freshClient();
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", async () => {
      throw new Error("The operation was aborted");
    });
    await expect(
      client.apiFetch("/api/v1/coverage", { signal: controller.signal }),
    ).rejects.toThrow();
    expect(store.apiLatencySnapshot()).toBeNull();
  });

  it("THE SAMPLES ARE THE SELECTED NETWORK'S, without the dot knowing networks exist", async () => {
    // #8700's property, at its new home. The old probe built its own URL by
    // hand and got this wrong: on testnet.metagraph.sh it measured MAINNET's
    // artifact, and the failure was silent because an unprefixed probe still
    // returns 200 and still paints green. Now every sample comes from
    // `apiFetch`, which resolves the network at call time -- so the scoping is
    // structural rather than remembered.
    const { client } = await freshClient("testnet.metagraph.sh");
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    await client.apiFetch("/api/v1/coverage");
    expect(seen[0]).toContain("/api/v1/testnet/coverage");
  });
});

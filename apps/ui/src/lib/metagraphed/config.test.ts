import { describe, it, expect, vi, afterEach } from "vitest";
import { sanitizeApiBase } from "./config";
import { makeWindow } from "./test-window";

// sanitizeApiBase is the XSS taint barrier: a persisted / user-supplied API base
// must never reach an href as an executable URL. Only http(s) origins pass.
describe("sanitizeApiBase", () => {
  it("rejects nullish / empty input", () => {
    expect(sanitizeApiBase(undefined)).toBeNull();
    expect(sanitizeApiBase(null)).toBeNull();
    expect(sanitizeApiBase("")).toBeNull();
    expect(sanitizeApiBase("   ")).toBeNull();
  });

  it("rejects dangerous / non-http schemes", () => {
    expect(sanitizeApiBase("javascript:alert(1)")).toBeNull();
    expect(sanitizeApiBase("JavaScript:alert(1)")).toBeNull();
    expect(sanitizeApiBase("data:text/html,<script>alert(1)</script>")).toBeNull();
    expect(sanitizeApiBase("vbscript:msgbox(1)")).toBeNull();
    expect(sanitizeApiBase("file:///etc/passwd")).toBeNull();
    expect(sanitizeApiBase("ws://example.com")).toBeNull();
    expect(sanitizeApiBase("ftp://example.com")).toBeNull();
    // A leading-space trick must not smuggle javascript: past the trim+regex.
    expect(sanitizeApiBase("  javascript:alert(1)")).toBeNull();
  });

  it("rejects an http scheme with no host", () => {
    expect(sanitizeApiBase("https:")).toBeNull();
    expect(sanitizeApiBase("http://")).toBeNull();
  });

  it("accepts valid http(s) origins, trimming whitespace + trailing slash", () => {
    expect(sanitizeApiBase("https://api.metagraph.sh")).toBe("https://api.metagraph.sh");
    expect(sanitizeApiBase("http://localhost:8787")).toBe("http://localhost:8787");
    expect(sanitizeApiBase("  https://api.metagraph.sh/  ")).toBe("https://api.metagraph.sh");
    expect(sanitizeApiBase("https://example.com/api/v1")).toBe("https://example.com/api/v1");
  });

  it("accepts HTTPS regardless of scheme casing", () => {
    expect(sanitizeApiBase("HTTPS://api.metagraph.sh")).toBe("HTTPS://api.metagraph.sh");
  });
});

// A fresh module instance per case: config.ts caches the base/network at module scope (and reads
// `window` at import time via `API_BASE = getApiBase()`), so resetModules + a re-import is the only
// way to observe first-read behavior deterministically. Stub `window` BEFORE importing so import-time
// reads see it (or leave it unset for the SSR paths).
async function freshConfig(win?: ReturnType<typeof makeWindow>) {
  vi.resetModules();
  if (win) vi.stubGlobal("window", win);
  return import("./config");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getApiBase / setApiBase (CSR: caching, persistence, broadcast)", () => {
  it("reads a persisted base on first call, then serves it from cache", async () => {
    const win = makeWindow({ "metagraphed:api-base": "https://stored.example" });
    const cfg = await freshConfig(win);
    expect(cfg.getApiBase()).toBe("https://stored.example");
    // Mutating storage after the first (caching) read must NOT change the served value.
    win.store.set("metagraphed:api-base", "https://changed.example");
    expect(cfg.getApiBase()).toBe("https://stored.example");
  });

  it("ignores a persisted value that fails the sanitizer, falling back to the default", async () => {
    const cfg = await freshConfig(makeWindow({ "metagraphed:api-base": "javascript:alert(1)" }));
    expect(cfg.getApiBase()).toBe(cfg.DEFAULT_API_BASE);
  });

  it("setApiBase persists a valid base, updates the cache, and broadcasts it", async () => {
    const win = makeWindow();
    const cfg = await freshConfig(win);
    const seen: string[] = [];
    const off = cfg.onApiBaseChange((next) => seen.push(next));
    cfg.setApiBase("https://custom.example/");
    expect(cfg.getApiBase()).toBe("https://custom.example"); // trailing slash trimmed
    expect(win.store.get("metagraphed:api-base")).toBe("https://custom.example");
    expect(seen).toEqual(["https://custom.example"]);
    // After unsubscribing, further changes are not delivered.
    off();
    cfg.setApiBase("https://other.example");
    expect(seen).toEqual(["https://custom.example"]);
  });

  it("setApiBase to the default clears the persisted override", async () => {
    const win = makeWindow({ "metagraphed:api-base": "https://custom.example" });
    const cfg = await freshConfig(win);
    cfg.setApiBase(cfg.DEFAULT_API_BASE);
    expect(win.store.has("metagraphed:api-base")).toBe(false);
    expect(cfg.getApiBase()).toBe(cfg.DEFAULT_API_BASE);
  });

  it("setApiBase with an invalid value falls back to the default", async () => {
    const cfg = await freshConfig(makeWindow());
    cfg.setApiBase("not-a-url");
    expect(cfg.getApiBase()).toBe(cfg.DEFAULT_API_BASE);
  });
});

describe("getNetwork / setNetwork (CSR: caching, persistence, broadcast)", () => {
  it("reads a persisted network on first call, then serves it from cache", async () => {
    const win = makeWindow({ "metagraphed:network": "testnet" });
    const cfg = await freshConfig(win);
    expect(cfg.getNetwork().id).toBe("testnet");
    expect(cfg.getNetworkPrefix()).toBe("testnet");
    win.store.set("metagraphed:network", "mainnet");
    expect(cfg.getNetwork().id).toBe("testnet"); // cached
  });

  it("falls back to the default network for an unknown persisted id", async () => {
    const cfg = await freshConfig(makeWindow({ "metagraphed:network": "bogus" }));
    expect(cfg.getNetwork().id).toBe(cfg.DEFAULT_NETWORK.id);
    expect(cfg.getNetworkPrefix()).toBe("");
  });

  it("setNetwork persists a non-default id, updates the cache, and broadcasts the resolved network", async () => {
    const win = makeWindow();
    const cfg = await freshConfig(win);
    const seen: string[] = [];
    const off = cfg.onNetworkChange((next) => seen.push(next.id));
    cfg.setNetwork("testnet");
    expect(cfg.getNetwork().id).toBe("testnet");
    expect(win.store.get("metagraphed:network")).toBe("testnet");
    expect(seen).toEqual(["testnet"]);
    off();
    cfg.setNetwork("mainnet");
    expect(seen).toEqual(["testnet"]);
  });

  it("setNetwork to the default clears the persisted override; an unknown id resolves to the default", async () => {
    const win = makeWindow({ "metagraphed:network": "testnet" });
    const cfg = await freshConfig(win);
    cfg.setNetwork("mainnet");
    expect(win.store.has("metagraphed:network")).toBe(false);
    cfg.setNetwork("nope");
    expect(cfg.getNetwork().id).toBe(cfg.DEFAULT_NETWORK.id);
  });
});

// #8229: testnet.metagraph.sh is a per-network custom domain on the same
// Worker, so the hostname -- not localStorage -- is the source of truth.
describe("per-network hostname (#8229)", () => {
  it("resolves the network from the hostname label", async () => {
    const cfg = await freshConfig(makeWindow({}, "testnet.metagraph.sh"));
    expect(cfg.getNetwork().id).toBe("testnet");
    expect(cfg.getNetworkPrefix()).toBe("testnet");
  });

  it("hostname beats a conflicting stored preference in both directions", async () => {
    // Stale "mainnet" preference must not win on the testnet host...
    const onTestnet = await freshConfig(
      makeWindow({ "metagraphed:network": "mainnet" }, "testnet.metagraph.sh"),
    );
    expect(onTestnet.getNetwork().id).toBe("testnet");

    // ...and a "testnet" preference must not follow you back to the apex.
    const onApex = await freshConfig(
      makeWindow({ "metagraphed:network": "testnet" }, "metagraph.sh"),
    );
    expect(onApex.getNetwork().id).toBe("mainnet");
  });

  it("falls back to the stored preference on a host with no network label", async () => {
    const cfg = await freshConfig(
      makeWindow({ "metagraphed:network": "testnet" }, "metagraphed-ui.zeronode.workers.dev"),
    );
    expect(cfg.getNetwork().id).toBe("testnet");
  });

  it("setNetwork navigates to the sibling host, preserving path + query", async () => {
    const win = makeWindow({}, "metagraph.sh");
    const cfg = await freshConfig(win);
    cfg.setNetwork("testnet");
    expect(win.assigned).toEqual(["https://testnet.metagraph.sh/subnets?view=table"]);
  });

  it("setNetwork back to mainnet strips the network label rather than stacking it", async () => {
    const win = makeWindow({}, "testnet.metagraph.sh");
    const cfg = await freshConfig(win);
    cfg.setNetwork("mainnet");
    expect(win.assigned).toEqual(["https://metagraph.sh/subnets?view=table"]);
  });

  it("stays in-page (no navigation) where no sibling host exists", async () => {
    for (const host of ["localhost", "127.0.0.1", "app.localhost"]) {
      const win = makeWindow({}, host);
      const cfg = await freshConfig(win);
      const seen: string[] = [];
      cfg.onNetworkChange((next) => seen.push(next.id));
      cfg.setNetwork("testnet");
      expect(win.assigned, `${host} must not navigate`).toEqual([]);
      // The in-page broadcast still fires so subscribers reconnect.
      expect(seen).toEqual(["testnet"]);
      vi.unstubAllGlobals();
    }
  });

  it("networkHostname maps both directions and declines hostless targets", async () => {
    const cfg = await freshConfig(makeWindow({}, "metagraph.sh"));
    const testnet = cfg.CHAIN_NETWORKS.find((n) => n.id === "testnet")!;
    expect(cfg.networkHostname(testnet, "metagraph.sh")).toBe("testnet.metagraph.sh");
    expect(cfg.networkHostname(testnet, "testnet.metagraph.sh")).toBe("testnet.metagraph.sh");
    expect(cfg.networkHostname(cfg.DEFAULT_NETWORK, "testnet.metagraph.sh")).toBe("metagraph.sh");
    expect(cfg.networkHostname(testnet, "localhost")).toBeNull();
    expect(cfg.networkHostname(testnet, "192.168.1.10")).toBeNull();
  });
});

describe("SSR safety (no window)", () => {
  it("defaults everything and returns no-op unsubscribers when window is undefined", async () => {
    const cfg = await freshConfig(); // no window stubbed
    expect(cfg.getApiBase()).toBe(cfg.DEFAULT_API_BASE);
    expect(cfg.getNetwork().id).toBe(cfg.DEFAULT_NETWORK.id);
    expect(cfg.getNetworkPrefix()).toBe("");
    expect(typeof cfg.onApiBaseChange(() => {})).toBe("function");
    expect(typeof cfg.onNetworkChange(() => {})).toBe("function");
    // setters must not throw without a window.
    expect(() => cfg.setApiBase("https://x.example")).not.toThrow();
    expect(() => cfg.setNetwork("testnet")).not.toThrow();
  });
});

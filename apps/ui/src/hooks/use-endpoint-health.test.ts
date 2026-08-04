import { afterEach, describe, expect, it, vi } from "vitest";

import { makeWindow } from "@/lib/metagraphed/test-window";

import { classifyEndpointLatency } from "./use-endpoint-health";

describe("classifyEndpointLatency", () => {
  it("returns down when latency is unavailable", () => {
    expect(classifyEndpointLatency(null)).toBe("down");
  });

  it("returns ok at or below the slow threshold", () => {
    expect(classifyEndpointLatency(0)).toBe("ok");
    expect(classifyEndpointLatency(300)).toBe("ok");
  });

  it("returns slow above the slow threshold through the bad threshold", () => {
    expect(classifyEndpointLatency(301)).toBe("slow");
    expect(classifyEndpointLatency(800)).toBe("slow");
  });

  it("returns bad above the bad threshold", () => {
    expect(classifyEndpointLatency(801)).toBe("bad");
    expect(classifyEndpointLatency(5000)).toBe("bad");
  });
});

// #8700: the footer health dot must probe the network the user is actually
// reading. This hook predates multi-network addressing and built its URL by
// hand, so on testnet.metagraph.sh it measured mainnet's /api/v1/coverage.
// The failure is silent — an unprefixed probe still returns 200 and still
// paints green — so it needs an explicit assertion rather than a smoke test.
describe("buildEndpointHealthUrl network scoping", () => {
  async function freshHook(win: ReturnType<typeof makeWindow>) {
    vi.resetModules();
    vi.stubGlobal("window", win);
    return import("./use-endpoint-health");
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("probes the un-prefixed path on the mainnet apex", async () => {
    const mod = await freshHook(makeWindow({}, "metagraph.sh"));
    expect(mod.buildEndpointHealthUrl("https://api.metagraph.sh")).toBe(
      "https://api.metagraph.sh/api/v1/coverage",
    );
  });

  it("probes the testnet partition on the testnet host", async () => {
    const mod = await freshHook(makeWindow({}, "testnet.metagraph.sh"));
    expect(mod.buildEndpointHealthUrl("https://api.metagraph.sh")).toBe(
      "https://api.metagraph.sh/api/v1/testnet/coverage",
    );
  });

  it("follows a stored preference on a host with no network label", async () => {
    const mod = await freshHook(makeWindow({ "metagraphed:network": "testnet" }, "localhost"));
    expect(mod.buildEndpointHealthUrl("http://localhost:8787")).toBe(
      "http://localhost:8787/api/v1/testnet/coverage",
    );
  });

  it("tolerates a base with a trailing slash without doubling it", async () => {
    const mod = await freshHook(makeWindow({}, "testnet.metagraph.sh"));
    expect(mod.buildEndpointHealthUrl("https://api.metagraph.sh/")).toBe(
      "https://api.metagraph.sh/api/v1/testnet/coverage",
    );
  });
});

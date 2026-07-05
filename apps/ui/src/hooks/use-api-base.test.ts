import { describe, expect, it } from "vitest";

import { DEFAULT_API_BASE, DEFAULT_NETWORK } from "@/lib/metagraphed/config";

import {
  isDefaultApiBase,
  isDefaultChainNetwork,
  metagraphedQueryInvalidationTarget,
} from "./use-api-base";

describe("metagraphedQueryInvalidationTarget", () => {
  it("invalidates the metagraphed query root used by both runtime hooks", () => {
    expect(metagraphedQueryInvalidationTarget()).toEqual({ queryKey: ["metagraphed"] });
  });
});

describe("isDefaultApiBase", () => {
  it("detects the configured default API base", () => {
    expect(isDefaultApiBase(DEFAULT_API_BASE)).toBe(true);
    expect(isDefaultApiBase("https://custom.example")).toBe(false);
  });
});

describe("isDefaultChainNetwork", () => {
  it("detects the configured default chain network", () => {
    expect(isDefaultChainNetwork(DEFAULT_NETWORK)).toBe(true);
    expect(isDefaultChainNetwork({ ...DEFAULT_NETWORK, id: "testnet" })).toBe(false);
  });
});

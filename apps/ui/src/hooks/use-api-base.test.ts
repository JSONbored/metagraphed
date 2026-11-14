import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as configuration from "@/lib/metagraphed/config";

import { DEFAULT_API_BASE, DEFAULT_NETWORK } from "@/lib/metagraphed/config";

import {
  isDefaultApiBase,
  isDefaultChainNetwork,
  metagraphedQueryInvalidationTarget,
  useApiBase,
} from "./use-api-base";

describe("useApiBase", () => {
  it("renders the SSR default without consulting browser preferences or requiring query context", () => {
    const getter = vi
      .spyOn(configuration, "getApiBase")
      .mockReturnValue("https://browser-selected.example/path");
    function Source() {
      return createElement("span", null, useApiBase());
    }
    try {
      expect(renderToStaticMarkup(createElement(Source))).toBe(
        renderToStaticMarkup(createElement("span", null, DEFAULT_API_BASE)),
      );
      expect(getter).not.toHaveBeenCalled();
    } finally {
      getter.mockRestore();
    }
  });
});

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

import { describe, expect, it } from "vitest";

import {
  extrinsicCall,
  extrinsicHashPathSegment,
  isDecodedCall,
  isValidExtrinsicHash,
  proxyRealAccount,
} from "./extrinsics";

const VALID_HASH = "0xabc123def456";

describe("isValidExtrinsicHash", () => {
  it("accepts 0x-prefixed hex extrinsic hashes", () => {
    expect(isValidExtrinsicHash(VALID_HASH)).toBe(true);
    expect(isValidExtrinsicHash("0xDEADBEEF")).toBe(true);
    expect(isValidExtrinsicHash(`0x${"a".repeat(128)}`)).toBe(true);
  });

  it("rejects malformed hash refs", () => {
    expect(isValidExtrinsicHash("")).toBe(false);
    expect(isValidExtrinsicHash("abc123")).toBe(false);
    expect(isValidExtrinsicHash("0x")).toBe(false);
    expect(isValidExtrinsicHash("0xghij")).toBe(false);
    expect(isValidExtrinsicHash(`0x${"a".repeat(129)}`)).toBe(false);
  });
});

describe("extrinsicHashPathSegment", () => {
  it("returns an encoded path segment for valid hashes", () => {
    expect(extrinsicHashPathSegment(VALID_HASH)).toBe(encodeURIComponent(VALID_HASH));
  });

  it("throws before encoding invalid hash refs", () => {
    expect(() => extrinsicHashPathSegment("not-a-hash")).toThrow("Invalid extrinsic hash");
  });
});

describe("extrinsicCall", () => {
  it("joins module and function when both are present", () => {
    expect(extrinsicCall("Balances", "transfer")).toBe("Balances.transfer");
  });

  it("falls back to whichever side is present", () => {
    expect(extrinsicCall("Balances", null)).toBe("Balances");
    expect(extrinsicCall(undefined, "transfer")).toBe("transfer");
  });

  it("returns an em dash when both sides are absent", () => {
    expect(extrinsicCall()).toBe("—");
    expect(extrinsicCall(null, null)).toBe("—");
  });
});

describe("isDecodedCall", () => {
  it("accepts an object carrying string call_module and call_function", () => {
    expect(isDecodedCall({ call_module: "Utility", call_function: "batch" })).toBe(true);
  });

  it("rejects arrays, scalars, and objects missing either field", () => {
    expect(isDecodedCall([{ call_module: "Utility", call_function: "batch" }])).toBe(false);
    expect(isDecodedCall("Utility.batch")).toBe(false);
    expect(isDecodedCall(null)).toBe(false);
    expect(isDecodedCall({ call_module: "Utility" })).toBe(false);
    expect(isDecodedCall({ call_function: "batch" })).toBe(false);
  });
});

describe("proxyRealAccount", () => {
  const REAL = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  it("extracts the real arg from a Proxy.proxy call", () => {
    expect(
      proxyRealAccount("Proxy", "proxy", [
        { name: "real", value: REAL },
        { name: "call", value: { call_module: "Balances", call_function: "transfer" } },
      ]),
    ).toBe(REAL);
  });

  it("returns null for non-proxy calls", () => {
    expect(proxyRealAccount("Balances", "transfer", [{ name: "dest", value: REAL }])).toBeNull();
    expect(proxyRealAccount("Proxy", "add_proxy", [{ name: "real", value: REAL }])).toBeNull();
  });

  it("returns null when call_args isn't an array or the real arg is malformed", () => {
    expect(proxyRealAccount("Proxy", "proxy", { real: REAL })).toBeNull();
    expect(proxyRealAccount("Proxy", "proxy", [{ name: "real", value: 123 }])).toBeNull();
    expect(
      proxyRealAccount("Proxy", "proxy", [{ name: "force_proxy_type", value: "Any" }]),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import {
  asDecodedCall,
  extrinsicCall,
  extrinsicHashPathSegment,
  isCompositeExtrinsicRef,
  isDecodedCall,
  isValidExtrinsicHash,
  multisigCallHash,
  normalizeIndexerRsCall,
  proxyRealAccount,
} from "./extrinsics";

const VALID_HASH = "0xabc123def456";

describe("isCompositeExtrinsicRef", () => {
  it("accepts block_number-extrinsic_index composite labels", () => {
    expect(isCompositeExtrinsicRef("123456-2")).toBe(true);
    expect(isCompositeExtrinsicRef("1-0")).toBe(true);
  });

  it("rejects malformed near-misses and leading-zero block numbers", () => {
    expect(isCompositeExtrinsicRef("123-")).toBe(false);
    expect(isCompositeExtrinsicRef("-2")).toBe(false);
    expect(isCompositeExtrinsicRef("123456-2-3")).toBe(false);
    expect(isCompositeExtrinsicRef("0-2")).toBe(false);
    expect(isCompositeExtrinsicRef("0123-2")).toBe(false);
    expect(isCompositeExtrinsicRef(VALID_HASH)).toBe(false);
  });
});

describe("isValidExtrinsicHash", () => {
  it("accepts 0x-prefixed hex extrinsic hashes", () => {
    expect(isValidExtrinsicHash(VALID_HASH)).toBe(true);
    expect(isValidExtrinsicHash("0xDEADBEEF")).toBe(true);
    expect(isValidExtrinsicHash(`0x${"a".repeat(128)}`)).toBe(true);
  });

  it("accepts block#index composite refs", () => {
    expect(isValidExtrinsicHash("123456-2")).toBe(true);
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
  it("returns an encoded path segment for valid hashes and composite refs", () => {
    expect(extrinsicHashPathSegment(VALID_HASH)).toBe(encodeURIComponent(VALID_HASH));
    expect(extrinsicHashPathSegment("123456-2")).toBe("123456-2");
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

describe("normalizeIndexerRsCall", () => {
  it("reconstructs call_module/call_function from indexer-rs's {name,values} enum wrapper (#4669)", () => {
    expect(
      normalizeIndexerRsCall({
        name: "Balances",
        values: [{ name: "transfer_keep_alive", values: { dest: "5X", value: 100 } }],
      }),
    ).toEqual({
      call_module: "Balances",
      call_function: "transfer_keep_alive",
      call_args: { dest: "5X", value: 100 },
    });
  });

  it("real production shape: Utility.batch_all's inner AdminUtils call (block #8584692)", () => {
    expect(
      normalizeIndexerRsCall({
        name: "AdminUtils",
        values: [
          {
            name: "sudo_set_subnet_emission_enabled",
            values: { netuid: 78, enabled: true },
          },
        ],
      }),
    ).toEqual({
      call_module: "AdminUtils",
      call_function: "sudo_set_subnet_emission_enabled",
      call_args: { netuid: 78, enabled: true },
    });
  });

  it("rejects shapes that aren't a single-variant enum wrapper", () => {
    expect(
      normalizeIndexerRsCall({ call_module: "Balances", call_function: "transfer" }),
    ).toBeNull();
    expect(normalizeIndexerRsCall({ name: "Balances", values: [] })).toBeNull();
    expect(
      normalizeIndexerRsCall({ name: "Balances", values: [{ name: "a" }, { name: "b" }] }),
    ).toBeNull();
    expect(normalizeIndexerRsCall({ name: "Balances", values: ["not-an-object"] })).toBeNull();
    expect(normalizeIndexerRsCall({ name: "Balances", values: [{ values: {} }] })).toBeNull();
    expect(normalizeIndexerRsCall([{ name: "Balances", values: [] }])).toBeNull();
    expect(normalizeIndexerRsCall("Balances")).toBeNull();
    expect(normalizeIndexerRsCall(null)).toBeNull();
  });
});

describe("asDecodedCall", () => {
  it("recognizes the D1 shape directly", () => {
    expect(asDecodedCall({ call_module: "Utility", call_function: "batch" })).toEqual({
      call_module: "Utility",
      call_function: "batch",
    });
  });

  it("recognizes and normalizes the indexer-rs enum-wrapper shape", () => {
    expect(asDecodedCall({ name: "Utility", values: [{ name: "batch", values: {} }] })).toEqual({
      call_module: "Utility",
      call_function: "batch",
      call_args: {},
    });
  });

  it("returns null for neither shape", () => {
    expect(asDecodedCall("Utility.batch")).toBeNull();
    expect(asDecodedCall([{ call_module: "Utility", call_function: "batch" }])).toBeNull();
    expect(asDecodedCall(null)).toBeNull();
  });
});

describe("proxyRealAccount", () => {
  const REAL = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  it("extracts the real arg from a Proxy.proxy call (D1 array shape)", () => {
    expect(
      proxyRealAccount("Proxy", "proxy", [
        { name: "real", value: REAL },
        { name: "call", value: { call_module: "Balances", call_function: "transfer" } },
      ]),
    ).toBe(REAL);
  });

  it("extracts the real arg from the Postgres flat-object shape (#4669)", () => {
    expect(
      proxyRealAccount("Proxy", "proxy", {
        real: REAL,
        call: { call_module: "Balances", call_function: "transfer" },
      }),
    ).toBe(REAL);
  });

  it("returns null for non-proxy calls", () => {
    expect(proxyRealAccount("Balances", "transfer", [{ name: "dest", value: REAL }])).toBeNull();
    expect(proxyRealAccount("Proxy", "add_proxy", [{ name: "real", value: REAL }])).toBeNull();
  });

  it("returns null when the real arg is missing or malformed, in either shape", () => {
    expect(proxyRealAccount("Proxy", "proxy", [{ name: "real", value: 123 }])).toBeNull();
    expect(
      proxyRealAccount("Proxy", "proxy", [{ name: "force_proxy_type", value: "Any" }]),
    ).toBeNull();
    expect(proxyRealAccount("Proxy", "proxy", { real: 123 })).toBeNull();
    expect(proxyRealAccount("Proxy", "proxy", { force_proxy_type: "Any" })).toBeNull();
    expect(proxyRealAccount("Proxy", "proxy", "not-an-args-shape")).toBeNull();
    expect(proxyRealAccount("Proxy", "proxy", null)).toBeNull();
  });
});

describe("multisigCallHash", () => {
  const HASH = `0x${"a".repeat(64)}`;

  it("extracts a top-level call_hash arg (approve_as_multi/cancel_as_multi shape)", () => {
    expect(
      multisigCallHash("Multisig", [
        { name: "threshold", value: 2 },
        { name: "call_hash", value: HASH },
      ]),
    ).toBe(HASH);
  });

  it("extracts the nested call's own call_hash (as_multi shape)", () => {
    expect(
      multisigCallHash("Multisig", [
        { name: "threshold", value: 2 },
        {
          name: "call",
          value: {
            call_module: "Balances",
            call_function: "transfer",
            call_hash: HASH,
          },
        },
      ]),
    ).toBe(HASH);
  });

  it("prefers a direct call_hash arg over a nested one when both are present", () => {
    const OTHER = `0x${"b".repeat(64)}`;
    expect(
      multisigCallHash("Multisig", [
        { name: "call_hash", value: HASH },
        {
          name: "call",
          value: { call_module: "Balances", call_function: "transfer", call_hash: OTHER },
        },
      ]),
    ).toBe(HASH);
  });

  it("extracts a top-level call_hash from the Postgres flat-object shape (#4669)", () => {
    expect(multisigCallHash("Multisig", { threshold: 2, call_hash: HASH })).toBe(HASH);
  });

  it("extracts the nested call's own call_hash from the flat-object shape (#4669)", () => {
    expect(
      multisigCallHash("Multisig", {
        threshold: 2,
        call: { call_module: "Balances", call_function: "transfer", call_hash: HASH },
      }),
    ).toBe(HASH);
  });

  it("prefers a direct call_hash over a nested one in the flat-object shape too", () => {
    const OTHER = `0x${"b".repeat(64)}`;
    expect(
      multisigCallHash("Multisig", {
        call_hash: HASH,
        call: { call_module: "Balances", call_function: "transfer", call_hash: OTHER },
      }),
    ).toBe(HASH);
  });

  it("hex-encodes a raw 32-byte call_hash array (indexer-rs's approve_as_multi shape, #4669)", () => {
    // Real production data (block #8583926, extrinsic #20): indexer-rs's
    // dynamic-SCALE-value dump for a [u8; 32] field, verified byte-for-byte
    // against the same extrinsic's D1-decoded call_hash.
    const rawBytes = [
      55, 179, 165, 105, 21, 65, 52, 28, 2, 97, 174, 39, 138, 188, 216, 92, 59, 81, 41, 113, 95,
      144, 196, 30, 171, 229, 58, 253, 236, 43, 238, 118,
    ];
    expect(multisigCallHash("Multisig", { threshold: 2, call_hash: rawBytes })).toBe(
      "0x37b3a5691541341c0261ae278abcd85c3b5129715f90c41eabe53afdec2bee76",
    );
  });

  it("does not mistake an arbitrary byte array for a call_hash (wrong length)", () => {
    expect(multisigCallHash("Multisig", { call_hash: [1, 2, 3] })).toBeNull();
    expect(
      multisigCallHash("Multisig", { call_hash: Array(32).fill(256) }), // out of byte range
    ).toBeNull();
  });

  it("degrades cleanly (null, not a wrong hash) for indexer-rs's nested as_multi shape, which encodes the wrapped call as a generic {name,values} enum tree rather than {call_module,call_function,call_hash} -- the remaining part of #4669, not fixable without the Rust indexer's decode source", () => {
    expect(
      multisigCallHash("Multisig", {
        threshold: 2,
        call: { name: "Balances", values: [{ name: "transfer_keep_alive", values: {} }] },
      }),
    ).toBeNull();
  });

  it("returns null for non-Multisig calls, missing hashes, or malformed shapes", () => {
    expect(multisigCallHash("Balances", [{ name: "call_hash", value: HASH }])).toBeNull();
    expect(multisigCallHash("Multisig", [{ name: "threshold", value: 2 }])).toBeNull();
    expect(multisigCallHash("Multisig", [{ name: "call_hash", value: "not-a-hash" }])).toBeNull();
    expect(
      multisigCallHash("Multisig", [
        { name: "call", value: { call_module: "Balances", call_function: "transfer" } },
      ]),
    ).toBeNull();
    expect(multisigCallHash("Multisig", { threshold: 2 })).toBeNull();
    expect(multisigCallHash("Multisig", { call_hash: "not-a-hash" })).toBeNull();
    expect(
      multisigCallHash("Multisig", {
        call: { call_module: "Balances", call_function: "transfer" },
      }),
    ).toBeNull();
    expect(multisigCallHash("Multisig", "not-an-args-shape")).toBeNull();
    expect(multisigCallHash("Multisig", null)).toBeNull();
  });
});

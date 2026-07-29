import { describe, expect, it } from "vitest";

import { asDecodedCall, callArgValue, isDecodedCall, normalizeIndexerRsCall } from "./extrinsics";

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
      normalizeIndexerRsCall({
        call_module: "Balances",
        call_function: "transfer",
      }),
    ).toBeNull();
    expect(normalizeIndexerRsCall({ name: "Balances", values: [] })).toBeNull();
    expect(
      normalizeIndexerRsCall({
        name: "Balances",
        values: [{ name: "a" }, { name: "b" }],
      }),
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
    expect(
      asDecodedCall({
        name: "Utility",
        values: [{ name: "batch", values: {} }],
      }),
    ).toEqual({
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

describe("callArgValue", () => {
  it("looks up a named arg in the D1 array-of-descriptors shape", () => {
    expect(
      callArgValue(
        [
          { name: "dest", value: "5X" },
          { name: "value", value: 100 },
        ],
        "dest",
      ),
    ).toBe("5X");
  });

  it("looks up a named arg in the Postgres/indexer-rs flat-object shape", () => {
    expect(callArgValue({ dest: "5X", value: 100 }, "value")).toBe(100);
  });

  it("returns undefined when the name isn't found or callArgs is neither shape", () => {
    expect(callArgValue([{ name: "dest", value: "5X" }], "value")).toBeUndefined();
    expect(callArgValue({ dest: "5X" }, "value")).toBeUndefined();
    expect(callArgValue("not-args", "value")).toBeUndefined();
    expect(callArgValue(null, "value")).toBeUndefined();
  });
});

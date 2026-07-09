import { describe, it, expect } from "vitest";
import { decodeChainEventArgs, formatChainEventArgs } from "./chain-event-args";

const bytes = (h: string) => [
  ...Uint8Array.from(
    h
      .replace(/^0x/, "")
      .match(/../g)!
      .map((b) => parseInt(b, 16)),
  ),
];
const ALICE = bytes("0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d");
const ALICE_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("decodeChainEventArgs", () => {
  it("decodes an account-id byte array under an account key to SS58", () => {
    expect(decodeChainEventArgs({ who: ALICE, amount: 1000 })).toEqual({
      who: ALICE_SS58,
      amount: 1000,
    });
  });

  it("decodes account bytes nested inside an array (who: [<bytes>])", () => {
    expect(decodeChainEventArgs({ who: [ALICE] })).toEqual({ who: [ALICE_SS58] });
  });

  it("renders a 32-byte array under a non-account key as 0x-hex, not a mislabelled address", () => {
    const out = decodeChainEventArgs({ commit: ALICE }) as { commit: string };
    expect(out.commit).toBe("0x" + ALICE.map((b) => b.toString(16).padStart(2, "0")).join(""));
  });

  it("leaves non-account values untouched", () => {
    expect(decodeChainEventArgs({ netuid: 7, flag: true, note: "x", list: [1, 2, 3] })).toEqual({
      netuid: 7,
      flag: true,
      note: "x",
      list: [1, 2, 3],
    });
  });
});

describe("formatChainEventArgs", () => {
  it("returns a dash for nullish args", () => {
    expect(formatChainEventArgs(null)).toBe("—");
    expect(formatChainEventArgs(undefined)).toBe("—");
  });

  it("produces a readable one-liner with the account decoded and no raw byte spew", () => {
    const s = formatChainEventArgs({ who: ALICE, amount: 1000 });
    expect(s).toContain(ALICE_SS58);
    expect(s).not.toContain("212"); // first raw byte of Alice's key — must not leak
  });
});

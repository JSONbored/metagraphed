import { describe, expect, it } from "vitest";
import type { InjectedAccountWithMeta } from "@/lib/metagraphed/wallet-injected";

import { resolveConnectOutcome, toConnectedWallet, isStaleWallet } from "./use-wallet";

const ADDR_A = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ADDR_B = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

function account(address: string, source = "polkadot-js"): InjectedAccountWithMeta {
  return { address, meta: { name: "Alice", source } };
}

describe("resolveConnectOutcome", () => {
  it("resolves to no-accounts for an empty list", () => {
    expect(resolveConnectOutcome([])).toEqual({ status: "no-accounts" });
  });

  it("auto-picks the single account when exactly one is available", () => {
    const acc = account(ADDR_A);
    expect(resolveConnectOutcome([acc])).toEqual({ status: "connected", account: acc });
  });

  it("resolves to picking when more than one account is available", () => {
    expect(resolveConnectOutcome([account(ADDR_A), account(ADDR_B)])).toEqual({
      status: "picking",
    });
  });
});

describe("toConnectedWallet", () => {
  it("keeps only the address and source", () => {
    expect(toConnectedWallet(account(ADDR_A, "talisman"))).toEqual({
      address: ADDR_A,
      source: "talisman",
    });
  });

  it("falls back to 'unknown' when the extension doesn't report a source", () => {
    const acc: InjectedAccountWithMeta = { address: ADDR_A, meta: { name: "Alice", source: "" } };
    expect(toConnectedWallet(acc)).toEqual({ address: ADDR_A, source: "unknown" });
  });
});

describe("isStaleWallet", () => {
  it("is false when the persisted address is still exposed", () => {
    const wallet = { address: ADDR_A, source: "polkadot-js" };
    expect(isStaleWallet(wallet, [account(ADDR_A), account(ADDR_B)])).toBe(false);
  });

  it("is true when the persisted address is no longer exposed", () => {
    const wallet = { address: ADDR_A, source: "polkadot-js" };
    expect(isStaleWallet(wallet, [account(ADDR_B)])).toBe(true);
  });

  it("is true when the fresh account list is empty", () => {
    const wallet = { address: ADDR_A, source: "polkadot-js" };
    expect(isStaleWallet(wallet, [])).toBe(true);
  });
});

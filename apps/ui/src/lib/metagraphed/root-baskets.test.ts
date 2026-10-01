import { afterEach, describe, it, expect } from "vitest";
import {
  basketTao,
  basketIndex,
  basketReadState,
  rootBasketsQuery,
  accountRootBasketsQuery,
} from "./root-baskets";
import { setApiBase, setNetwork, DEFAULT_API_BASE } from "./config";

afterEach(() => {
  setApiBase(DEFAULT_API_BASE);
  setNetwork("mainnet");
});

it("isolates basket caches by network, API origin, account and pinned page", () => {
  const main = rootBasketsQuery().queryKey;
  setNetwork("testnet");
  const test = rootBasketsQuery().queryKey;
  expect(test).not.toEqual(main);
  setApiBase("https://reader.example");
  expect(rootBasketsQuery().queryKey).not.toEqual(test);
  const hash = `0x${"11".repeat(32)}`;
  const first = accountRootBasketsQuery("account-a").queryKey;
  expect(accountRootBasketsQuery("account-b").queryKey).not.toEqual(first);
  expect(accountRootBasketsQuery("account-a", { offset: 16, as_of: hash }).queryKey).not.toEqual(
    first,
  );
  expect(rootBasketsQuery({ cursor: hash, as_of: hash }).retry).toBe(0);
});

describe("native basket display units", () => {
  it("keeps TAO exact beyond the JavaScript integer range", () => {
    expect(basketTao("9007199254740993")).toBe("9007199.254740993 TAO");
    expect(basketTao("18446744073709551615")).toBe("18446744073.709551615 TAO");
    expect(basketTao("1")).toBe("0.000000001 TAO");
    expect(basketTao("1000000000")).toBe("1 TAO");
    expect(basketTao("0")).toBe("0 TAO");
    expect(basketTao(null)).toBe("—");
    expect(basketIndex("18446744073709551616")).toBe("1.0000");
    expect(basketIndex("18446744073709551615")).toBe("0.9999");
  });
  it("never renders missing or unsupported state as a zero balance", () => {
    expect(basketReadState(undefined, false)).toMatch(/Loading/);
    expect(basketReadState(undefined, true)).toMatch(/unavailable/);
    expect(
      basketReadState(
        { schema_version: 1, status: "unsupported", network: "test", source: null, data: null },
        false,
      ),
    ).toMatch(/not supported/);
  });
});

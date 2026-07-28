import { describe, expect, it } from "vitest";
import { resolveAddress, truncateSs58 } from "./resolve-address";

// Mirrors tests/entity-labels.test.ts's resolveAddress/truncateSs58 suite
// (the backend copy) -- see resolve-address.ts's own header for why this is
// a mirror, not a shared import, and why both suites exist independently.
const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

describe("truncateSs58", () => {
  it("keeps `keep` chars at each end around an ellipsis", () => {
    expect(truncateSs58(SS58)).toBe("5Grwva…GKutQY");
    expect(truncateSs58(SS58, 4)).toBe("5Grw…utQY");
  });

  it("returns a short value unchanged rather than producing a longer string", () => {
    expect(truncateSs58("5Grw", 6)).toBe("5Grw");
  });
});

describe("resolveAddress", () => {
  it("falls back to the truncated address when nothing is known", () => {
    expect(resolveAddress(SS58)).toEqual({
      display: "5Grwva…GKutQY",
      source: "truncated",
      category: null,
      ss58: SS58,
    });
  });

  it("private label outranks identity and nametag", () => {
    const resolved = resolveAddress(SS58, {
      localLabel: "Ledger cold",
      identityName: "tao.bot",
      nametag: { name: "Binance", category: "exchange" },
    });
    expect(resolved).toEqual({
      display: "Ledger cold",
      source: "private",
      category: null,
      ss58: SS58,
    });
  });

  it("identity outranks nametag", () => {
    const resolved = resolveAddress(SS58, {
      identityName: "tao.bot",
      nametag: { name: "Binance", category: "exchange" },
    });
    expect(resolved.source).toBe("identity");
    expect(resolved.category).toBeNull();
  });

  it("nametag resolves with its category when nothing outranks it", () => {
    const resolved = resolveAddress(SS58, {
      nametag: { name: "Binance", category: "exchange" },
    });
    expect(resolved).toEqual({
      display: "Binance",
      source: "nametag",
      category: "exchange",
      ss58: SS58,
    });
  });

  it("whitespace-only or non-string values are ignored, not rendered blank", () => {
    expect(resolveAddress(SS58, { localLabel: "  ", identityName: "tao.bot" }).source).toBe(
      "identity",
    );
    expect(resolveAddress(SS58, { identityName: "  ", nametag: { name: "Binance" } }).source).toBe(
      "nametag",
    );
    expect(resolveAddress(SS58, { nametag: { name: "  " } }).source).toBe("truncated");
  });

  it("honours a custom keep on the truncated fallback", () => {
    expect(resolveAddress(SS58, { keep: 4 }).display).toBe("5Grw…utQY");
  });
});

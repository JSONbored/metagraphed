import { describe, expect, it } from "vitest";
import type { AccountHolderDirectoryEntry, ChainSignerEntry } from "@/lib/metagraphed/types";
import {
  HOLDER_SORT,
  activeRows,
  fmtTaoCompact,
  holderCards,
  lookupVerdict,
  plural,
  shortAddress,
} from "./accounts-index-logic";

const account = (over: Partial<AccountHolderDirectoryEntry>): AccountHolderDirectoryEntry =>
  ({
    hotkey: "5H",
    coldkey: "5CCCCCCCCCCCCCCC",
    subnet_count: 1,
    uid_count: 1,
    ...over,
  }) as AccountHolderDirectoryEntry;

const isSs58 = (v: string) => v.startsWith("5") && v.length > 40;
const isH160 = (v: string) => /^0x[0-9a-fA-F]{40}$/.test(v);
const normalize = (v: string) => v.toLowerCase();

describe("HOLDER_SORT", () => {
  it("offers only independent reach and emission sorts", () => {
    expect(HOLDER_SORT).toEqual({ reach: "subnet_count", emission: "total_emission" });
  });
});

describe("shortAddress / fmtTaoCompact", () => {
  it("truncates only what is long enough to need it", () => {
    expect(shortAddress("5GsbTgfvgCH4xdqSkiPb7EaBBFLHjWH5vfEALhJaewSFpZX9")).toBe(
      "5Gsbadf…pZX9".replace("adf", "Tg"),
    );
    expect(shortAddress("5Gsb")).toBe("5Gsb");
  });

  it("compacts at each magnitude and refuses a non-number", () => {
    expect(fmtTaoCompact(1_914_956)).toBe("1.91Mτ");
    expect(fmtTaoCompact(1_500)).toBe("1.5kτ");
    expect(fmtTaoCompact(1.5)).toBe("1.50τ");
    expect(fmtTaoCompact(null)).toBe("—");
  });
});

describe("holderCards", () => {
  const accounts = [
    account({
      hotkey: "5HotA",
      coldkey: "5AAAAAAAAAAAAAAAAAAA",
      total_stake_tao: 100,
      total_emission_tao: 3,
      subnet_count: 7,
    }),
    account({
      hotkey: "5HotB",
      coldkey: "5BBBBBBBBBBBBBBBBBBB",
      total_stake_tao: 50,
      total_emission_tao: 9,
      subnet_count: 2,
    }),
  ];

  it("preserves each independent ranking's supplied order and values", () => {
    expect(holderCards(accounts, "emission")[0]?.value).toBe("3.00τ");
    expect(holderCards(accounts, "reach")[0]?.value).toBe("7 subnets");
    expect(holderCards(accounts, "reach")[1]?.value).toBe("2 subnets");
    expect(holderCards([...accounts].reverse(), "emission")[0]?.key).toBe("5HotB");
  });

  it("keeps hotkey identities distinct even when a coldkey is shared", () => {
    const cards = holderCards(
      accounts.map((row) => ({ ...row, coldkey: "5SharedOwner" })),
      "reach",
    );
    expect(cards.map(({ key, name, href }) => ({ key, name, href }))).toEqual([
      { key: "5HotA", name: "5HotA", href: "/accounts/5HotA" },
      { key: "5HotB", name: "5HotB", href: "/accounts/5HotB" },
    ]);
  });

  it.each([0, 250, 1_000_000])("ignores legacy cached capital %s", (stake) => {
    const rows = accounts.map((row) => ({ ...row, total_stake_tao: stake, stake_dominance: 0.75 }));
    for (const metric of ["reach", "emission"] as const) {
      const cards = holderCards(rows, metric);
      expect(cards[0]?.sub).toBe("7 subnets · 1 UID");
      expect(JSON.stringify(cards)).not.toMatch(/%|stake|holdings/);
    }
    expect(holderCards(rows, "stake" as never)).toEqual([]);
  });

  it("drops a row with no address rather than linking nowhere", () => {
    expect(
      holderCards(
        [{ coldkey: "5OwnerOnly", subnet_count: 1, uid_count: 1 } as AccountHolderDirectoryEntry],
        "reach",
      ),
    ).toEqual([]);
  });

  it("honours the limit", () => {
    expect(holderCards(accounts, "reach", 1)).toHaveLength(1);
  });

  it("keeps absent membership and emission readings unavailable", () => {
    const rows = [account({ subnet_count: null, uid_count: null, total_emission_tao: null })];
    expect(holderCards(rows, "reach")[0]?.value).toBe("— subnets");
    expect(holderCards(rows, "emission")[0]).toMatchObject({
      sub: "— subnets · — UIDs",
      value: "—",
    });
  });
});
describe("plural", () => {
  it('does not say "1 subnets"', () => {
    expect(plural(1, "subnet")).toBe("1 subnet");
    expect(plural(0, "subnet")).toBe("0 subnets");
    expect(plural(7, "subnet")).toBe("7 subnets");
  });
});

describe("activeRows", () => {
  it("ranks by transactions and drops a signer with none", () => {
    const rows = activeRows([
      { signer: "5A", tx_count: 5, last_tx_block: 1 },
      { signer: "5B", tx_count: 50, last_tx_block: 2 },
      { signer: "5C", tx_count: 0, last_tx_block: 3 },
    ] as ChainSignerEntry[]);
    expect(rows.map((r) => r.signer)).toEqual(["5B", "5A"]);
  });
});

describe("lookupVerdict", () => {
  it("does nothing with an empty field", () => {
    expect(lookupVerdict("   ", isSs58, isH160, normalize)).toEqual({ kind: "empty" });
  });

  it("routes an ss58 to the account page", () => {
    const address = `5${"G".repeat(47)}`;
    expect(lookupVerdict(` ${address} `, isSs58, isH160, normalize)).toEqual({
      kind: "ss58",
      path: address,
    });
  });

  it("routes an EVM address to the hub's own h160 lookup, normalised", () => {
    expect(lookupVerdict(`0x${"AB".repeat(20)}`, isSs58, isH160, normalize)).toEqual({
      kind: "h160",
      search: { h160: `0x${"ab".repeat(20)}` },
    });
  });

  it("names WHICH shape failed, so the reader knows what to fix", () => {
    expect(lookupVerdict("0xnope", isSs58, isH160, normalize)).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("EVM"),
    });
    expect(lookupVerdict("hello", isSs58, isH160, normalize)).toMatchObject({
      kind: "invalid",
      message: expect.stringContaining("ss58"),
    });
  });
});

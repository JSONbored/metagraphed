import { describe, expect, it } from "vitest";
import type { AccountHolderDirectoryEntry, ChainSignerEntry } from "@/lib/metagraphed/types";
import {
  HOLDER_SORT,
  activeRows,
  concentrationSegments,
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
  it("maps every metric onto a sort the endpoint accepts", () => {
    // Anything else is a 400 (measured live 2026-08-23).
    expect(Object.values(HOLDER_SORT)).toEqual(["total_stake", "total_emission", "subnet_count"]);
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
    expect(fmtTaoCompact(1_914_956)).toBe("1.91M τ");
    expect(fmtTaoCompact(1_500)).toBe("1.5k τ");
    expect(fmtTaoCompact(1.5)).toBe("1.50 τ");
    expect(fmtTaoCompact(null)).toBe("—");
  });
});

describe("holderCards", () => {
  const accounts = [
    account({
      coldkey: "5AAAAAAAAAAAAAAAAAAA",
      total_stake_tao: 100,
      total_emission_tao: 3,
      subnet_count: 7,
    }),
    account({
      coldkey: "5BBBBBBBBBBBBBBBBBBB",
      total_stake_tao: 50,
      total_emission_tao: 9,
      subnet_count: 2,
    }),
  ];

  it("shows the reading it was ranked by, not always stake", () => {
    expect(holderCards(accounts, "stake")[0]?.value).toBe("100.00 τ");
    expect(holderCards(accounts, "emission")[0]?.value).toBe("3.00 τ");
    expect(holderCards(accounts, "reach")[0]?.value).toBe("7 subnets");
    expect(holderCards(accounts, "reach")[1]?.value).toBe("2 subnets");
  });

  it("links the coldkey, which is the account a reader can open", () => {
    expect(holderCards(accounts, "stake")[0]?.href).toBe("/accounts/5AAAAAAAAAAAAAAAAAAA");
  });

  it("shows a share of complete priced registered stake", () => {
    expect(holderCards(accounts, "stake", 18, 1_000)[0]?.sub).toBe(
      "10.0% of priced stake · 7 subnets",
    );
  });

  it("drops a row with no address rather than linking nowhere", () => {
    expect(
      holderCards([{ subnet_count: 1, uid_count: 1 } as AccountHolderDirectoryEntry], "stake"),
    ).toEqual([]);
  });

  it("honours the limit", () => {
    expect(holderCards(accounts, "stake", 1)).toHaveLength(1);
  });
});

describe("plural", () => {
  it('does not say "1 subnets"', () => {
    expect(plural(1, "subnet")).toBe("1 subnet");
    expect(plural(0, "subnet")).toBe("0 subnets");
    expect(plural(7, "subnet")).toBe("7 subnets");
  });
});

describe("concentrationSegments", () => {
  const accounts = [1, 2, 3, 4].map((n) =>
    account({ coldkey: `5${"X".repeat(19)}${n}`, total_stake_tao: n * 10 }),
  );

  it("collapses everything past the head into one residual segment", () => {
    const { segments } = concentrationSegments(accounts, 2);
    expect(segments.map((s) => s.key.slice(-1))).toEqual(["4", "3", "t"]);
    expect(segments[2]).toMatchObject({ label: "2 more listed", value: 30 });
  });

  it("totals the LISTED stake, which is not the network's", () => {
    // The endpoint serves a top-N slice, so a share computed against "all
    // stake" would overstate every segment by the untabulated tail.
    const { listedTotal } = concentrationSegments(accounts, 2);
    expect(listedTotal).toBe(100);
  });

  it("emits no residual when the head is everything", () => {
    const { segments } = concentrationSegments(accounts, 10);
    expect(segments.some((s) => s.key === "rest")).toBe(false);
  });

  it("drops an account holding nothing and survives an empty read", () => {
    expect(concentrationSegments([account({ total_stake_tao: 0 })]).segments).toEqual([]);
    expect(concentrationSegments([])).toEqual({ segments: [], listedTotal: 0 });
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

describe("holderCards carries each account's share of priced registered stake", () => {
  const accounts = [
    { coldkey: "5A", total_stake_tao: 250, subnet_count: 3, uid_count: 3 },
    { coldkey: "5B", total_stake_tao: 750, subnet_count: 1, uid_count: 1 },
  ] as never;

  it("states each account's network-wide share, share first", () => {
    const [a, b] = holderCards(accounts, "stake", 18, 1000);
    expect(a!.sub).toBe("25.0% of priced stake · 3 subnets");
    expect(b!.sub).toBe("75.0% of priced stake · 1 subnet");
  });

  it("falls back to reach when there is no total to divide by", () => {
    // A zero denominator is not "0%", it is "we cannot say" -- the card shows
    // what it does know instead of a share of nothing.
    const [a] = holderCards(accounts, "stake", 18, 0);
    expect(a!.sub).toBe("3 subnets · 3 UIDs");
  });

  it("falls back when the stake itself is missing", () => {
    const [a] = holderCards(
      [{ coldkey: "5A", subnet_count: 2, uid_count: 2 }] as never,
      "stake",
      18,
      1000,
    );
    expect(a!.sub).toBe("2 subnets · 2 UIDs");
  });

  it("uses one percent formatter, so two rows can never disagree", () => {
    // The defect this replaced: the same account rendered "9%" in one section
    // and "9.0%" in the other, 600px apart.
    const [a] = holderCards(
      [{ coldkey: "5A", total_stake_tao: 90, subnet_count: 1 }] as never,
      "stake",
      18,
      1000,
    );
    expect(a!.sub.startsWith("9.0% of priced stake")).toBe(true);
  });
});

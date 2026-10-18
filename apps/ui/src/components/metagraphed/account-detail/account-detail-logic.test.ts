import { describe, expect, it } from "vitest";
import type {
  AccountCounterparty,
  AccountDelegationEdge,
  AccountPosition,
  AccountStakeFlowSubnet,
} from "@/lib/metagraphed/types";
import {
  counterpartyRail,
  eventKindOptions,
  eventSubnetOptions,
  flowRails,
  fmtCompactTao,
  fmtSignedTao,
  fmtTao,
  positionsBySubnet,
  relatedKeys,
} from "./account-detail-logic";

const nameOf = (netuid: number) => `SN${netuid}`;

/** A minimal snapshot position; every test spreads over what it cares about. */
const position = (): AccountPosition =>
  ({ hotkey: "5A", netuid: 1, stake_tao: 1, share_fraction: 0 }) as AccountPosition;

describe("formatters", () => {
  it("renders TAO at the requested precision and a dash for nothing", () => {
    expect(fmtTao(1.23456, 4)).toBe("1.2346τ");
    expect(fmtTao(null)).toBe("—");
    expect(fmtTao(Number.NaN)).toBe("—");
  });

  it("compacts at each magnitude", () => {
    expect(fmtCompactTao(2_691_628)).toBe("2.69Mτ");
    expect(fmtCompactTao(2_500)).toBe("2.5kτ");
    expect(fmtCompactTao(2.5)).toBe("2.50τ");
  });

  it("keeps the sign on a net figure, where the sign is the point", () => {
    expect(fmtSignedTao(5)).toBe("+5.00τ");
    expect(fmtSignedTao(-5)).toBe("−5.00τ");
    expect(fmtSignedTao(null)).toBe("—");
  });
});

describe("positionsBySubnet", () => {
  const positions = [
    { ...position(), hotkey: "5A", netuid: 1, stake_tao: 10 },
    { ...position(), hotkey: "5B", netuid: 1, stake_tao: 30 },
    { ...position(), hotkey: "5A", netuid: 2, stake_tao: 60 },
  ] as AccountPosition[];

  it("collapses several hotkeys in one subnet into a single row", () => {
    const rows = positionsBySubnet(positions, nameOf);
    expect(rows.map((r) => r.netuid)).toEqual([1, 2]);
    expect(rows.find((r) => r.netuid === 1)).toMatchObject({ hotkeys: 2 });
  });

  it("does not infer quantities or ownership from old dehydrated numeric fields", () => {
    const rows = positionsBySubnet(positions, nameOf);
    expect(rows.map((row) => [row.netuid, row.hotkeys])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    for (const row of rows) {
      expect(row).not.toHaveProperty("value");
      expect(row).not.toHaveProperty("share");
    }
  });

  it("preserves relationships when legacy quantities are zero, null or invalid", () => {
    const rows = positionsBySubnet(
      [
        { ...position(), netuid: 1, stake_tao: 0 },
        { ...position(), netuid: 2, stake_tao: 60 },
        { ...position(), hotkey: "5B", netuid: 2, stake_tao: null },
      ],
      nameOf,
    );
    expect(rows[0]?.hotkeys).toBe(1);
    expect(rows[1]?.hotkeys).toBe(2);
  });

  it("ignores amounts even when a positive numeric value resembles a token quantity", () => {
    for (const stake_tao of [NaN, Infinity, -1, Number.MAX_VALUE, 12.5]) {
      const rows = positionsBySubnet([{ ...position(), stake_tao }], nameOf);
      expect(rows[0]?.hotkeys).toBe(1);
      expect(rows[0]).not.toHaveProperty("value");
    }
  });

  it("is empty for an empty read", () => {
    expect(positionsBySubnet([], nameOf)).toEqual([]);
  });
});

describe("flowRails", () => {
  const subnets = [
    { netuid: 0, staked_tao: 0, unstaked_tao: 5.2 },
    { netuid: 1, staked_tao: 3, unstaked_tao: 1 },
    { netuid: 2, staked_tao: 0, unstaked_tao: 0 },
  ] as AccountStakeFlowSubnet[];
  const fmt = (value: number | null | undefined) => `${value ?? 0} t`;

  it("orders by the leading value and keeps both directions on every row", () => {
    // Ordered by inflow, not by gross: a ranked rail whose first column is not
    // monotonic reads as broken. The exits-only subnet still shows its track.
    const rails = flowRails(subnets, nameOf, fmt);
    expect(rails.map((rail) => rail.key)).toEqual(["sn-1", "sn-0"]);
    expect(rails[1]).toMatchObject({ value: 0, secondary: 5.2 });
  });

  it("names and links the row rather than leaving it to an axis label", () => {
    expect(flowRails(subnets, nameOf, fmt)[0]).toMatchObject({
      label: nameOf(1),
      href: "/subnets/1",
    });
  });

  it("carries in, out and net for the tooltip", () => {
    expect(flowRails(subnets, nameOf, fmt)[0]?.detail).toEqual([
      { key: "in", label: "Staked in", value: "3 t" },
      { key: "out", label: "Unstaked out", value: "1 t" },
      { key: "net", label: "Net", value: "2 t" },
    ]);
  });

  it("drops a subnet nothing moved on, rather than drawing an empty row", () => {
    expect(flowRails(subnets, nameOf, fmt).some((rail) => rail.key === "sn-2")).toBe(false);
  });

  it("does not leak the sort key into the rail", () => {
    expect(flowRails(subnets, nameOf, fmt)[0]).not.toHaveProperty("total");
  });
});

describe("counterpartyRail", () => {
  const parties = [
    { address: "5AAAAAAAAA", sent_tao: 1000, received_tao: 1000, net_tao: 0, transfer_count: 8 },
    { address: "5BBBBBBBBB", sent_tao: 0, received_tao: 300, net_tao: 300, transfer_count: 1 },
    { address: "5CCCCCCCCC", sent_tao: 0, received_tao: 0, net_tao: 0, transfer_count: 0 },
  ] as AccountCounterparty[];

  it("ranks by GROSS movement, so a round-trip partner is not sorted last", () => {
    // 1,000 out and 1,000 back nets to zero and is the most significant
    // partner this account has.
    expect(counterpartyRail(parties).map((r) => r.key)).toEqual(["5AAAAAAAAA", "5BBBBBBBBB"]);
  });

  it("drops a partner nothing moved with", () => {
    expect(counterpartyRail(parties).some((r) => r.key === "5CCCCCCCCC")).toBe(false);
  });

  it("carries both directions and the net into the tooltip", () => {
    expect(counterpartyRail(parties)[0]?.detail).toEqual([
      { key: "sent", label: "Sent", value: "1.0kτ" },
      { key: "received", label: "Received", value: "1.0kτ" },
      { key: "net", label: "Net", value: "0.0000τ" },
      { key: "transfers", label: "Transfers", value: "8" },
    ]);
  });

  it("honours the limit", () => {
    expect(counterpartyRail(parties, 1)).toHaveLength(1);
  });
});

describe("event filter options", () => {
  it("orders kinds by frequency and shows the count", () => {
    expect(
      eventKindOptions([
        { kind: "Transfer", count: 5 },
        { kind: "Withdraw", count: 50 },
        { kind: "Never", count: 0 },
      ]),
    ).toEqual([
      { value: "Withdraw", label: "Withdraw (50)" },
      { value: "Transfer", label: "Transfer (5)" },
    ]);
  });

  it("lists each subnet an event stream touches once, in netuid order", () => {
    expect(
      eventSubnetOptions(
        [{ netuid: 3 }, { netuid: 1 }, { netuid: 3 }, { netuid: null }] as never,
        nameOf,
      ),
    ).toEqual([
      { value: "1", label: "SN1" },
      { value: "3", label: "SN3" },
    ]);
  });
});

describe("relatedKeys", () => {
  const edge = (counterpart: string, fraction: number | null): AccountDelegationEdge => ({
    counterpart,
    proportion: null,
    proportion_fraction: fraction,
  });

  it("names the tie on every row without ranking unlike subnet tokens by quantity", () => {
    const rows = relatedKeys(
      [
        { ...position(), hotkey: "5AAAAAAAAA", netuid: 1, stake_tao: 5 },
        { ...position(), hotkey: "5BBBBBBBBB", netuid: 2, stake_tao: 50 },
      ] as AccountPosition[],
      [edge("5CCCCCCCCC", 0.25)],
      [edge("5DDDDDDDDD", null)],
    );
    expect(rows.map((r) => [r.key, r.role])).toEqual([
      ["5AAAAAAAAA", "recorded through"],
      ["5BBBBBBBBB", "recorded through"],
      ["5CCCCCCCCC", "delegates to"],
      ["5DDDDDDDDD", "delegated by"],
    ]);
    expect(rows[2]?.value).toBeUndefined();
    expect(rows[3]?.value).toBeUndefined();
  });

  it("counts distinct subnet ties rather than summing their alpha as TAO", () => {
    const rows = relatedKeys(
      [
        { ...position(), hotkey: "5AAAAAAAAA", netuid: 1, stake_tao: 5 },
        { ...position(), hotkey: "5AAAAAAAAA", netuid: 2, stake_tao: 50 },
        { ...position(), hotkey: "5AAAAAAAAA", netuid: 2, stake_tao: null },
      ],
      [],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe("2 subnets");
  });

  it("does not assign an unscoped delegation percentage to a cross-subnet key", () => {
    const rows = relatedKeys([], [edge("5AAAAAAAAA", 0.25), edge("5AAAAAAAAA", 0.5)], []);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBeUndefined();
  });

  it("does not list a key twice when it has both a recorded position and a child tie", () => {
    const rows = relatedKeys(
      [{ ...position(), hotkey: "5AAAAAAAAA", stake_tao: 1 }] as AccountPosition[],
      [edge("5AAAAAAAAA", 0.5)],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("recorded through");
  });

  it("is empty for an account with no ties", () => {
    expect(relatedKeys([], [], [])).toEqual([]);
  });
});

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
  flowColumns,
  fmtCompactTao,
  fmtSignedTao,
  fmtTao,
  positionsBySubnet,
  relatedKeys,
} from "./account-detail-logic";

const nameOf = (netuid: number) => `SN${netuid}`;

/** A minimal live position; every test spreads over what it cares about. */
const position = (): AccountPosition =>
  ({ hotkey: "5A", netuid: 1, stake_tao: 1, share_fraction: 0 }) as AccountPosition;

describe("formatters", () => {
  it("renders TAO at the requested precision and a dash for nothing", () => {
    expect(fmtTao(1.23456, 4)).toBe("1.2346 τ");
    expect(fmtTao(null)).toBe("—");
    expect(fmtTao(Number.NaN)).toBe("—");
  });

  it("compacts at each magnitude", () => {
    expect(fmtCompactTao(2_691_628)).toBe("2.69M τ");
    expect(fmtCompactTao(2_500)).toBe("2.5k τ");
    expect(fmtCompactTao(2.5)).toBe("2.50 τ");
  });

  it("keeps the sign on a net figure, where the sign is the point", () => {
    expect(fmtSignedTao(5)).toBe("+5.00 τ");
    expect(fmtSignedTao(-5)).toBe("−5.00 τ");
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
    expect(rows.map((r) => r.netuid)).toEqual([2, 1]);
    expect(rows.find((r) => r.netuid === 1)).toMatchObject({ value: 40, hotkeys: 2 });
  });

  it("shares each subnet against the account's own total", () => {
    const rows = positionsBySubnet(positions, nameOf);
    expect(rows.find((r) => r.netuid === 2)?.share).toBeCloseTo(0.6);
    expect(rows.reduce((acc, r) => acc + r.share, 0)).toBeCloseTo(1);
  });

  it("shares nothing rather than dividing by zero", () => {
    const rows = positionsBySubnet(
      [{ ...position(), netuid: 1, stake_tao: 0 }] as AccountPosition[],
      nameOf,
    );
    expect(rows[0]?.share).toBe(0);
  });

  it("is empty for an empty read", () => {
    expect(positionsBySubnet([], nameOf)).toEqual([]);
  });
});

describe("flowColumns", () => {
  const subnets = [
    { netuid: 0, staked_tao: 0, unstaked_tao: 5.2 },
    { netuid: 1, staked_tao: 3, unstaked_tao: 1 },
    { netuid: 2, staked_tao: 0, unstaked_tao: 0 },
  ] as AccountStakeFlowSubnet[];

  it("orders by how much moved and keeps both directions on every column", () => {
    const columns = flowColumns(subnets, nameOf);
    expect(columns.map((c) => c.key)).toEqual(["sn-0", "sn-1"]);
    expect(columns[0]?.segments).toEqual([
      { key: "staked", label: "Staked in", value: 0 },
      { key: "unstaked", label: "Unstaked out", value: 5.2 },
    ]);
  });

  it("drops a subnet nothing moved on, rather than drawing an empty column", () => {
    expect(flowColumns(subnets, nameOf).some((c) => c.key === "sn-2")).toBe(false);
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
      { key: "sent", label: "Sent", value: "1.0k τ" },
      { key: "received", label: "Received", value: "1.0k τ" },
      { key: "net", label: "Net", value: "0.0000 τ" },
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

  it("names the tie on every row and ranks staked hotkeys by stake", () => {
    const rows = relatedKeys(
      [
        { ...position(), hotkey: "5AAAAAAAAA", netuid: 1, stake_tao: 5 },
        { ...position(), hotkey: "5BBBBBBBBB", netuid: 2, stake_tao: 50 },
      ] as AccountPosition[],
      [edge("5CCCCCCCCC", 0.25)],
      [edge("5DDDDDDDDD", null)],
    );
    expect(rows.map((r) => [r.key, r.role])).toEqual([
      ["5BBBBBBBBB", "stakes through"],
      ["5AAAAAAAAA", "stakes through"],
      ["5CCCCCCCCC", "delegates to"],
      ["5DDDDDDDDD", "delegated by"],
    ]);
    expect(rows[2]?.value).toBe("25.0%");
    expect(rows[3]?.value).toBeUndefined();
  });

  it("does not list a key twice when it is both staked through and delegated to", () => {
    const rows = relatedKeys(
      [{ ...position(), hotkey: "5AAAAAAAAA", stake_tao: 1 }] as AccountPosition[],
      [edge("5AAAAAAAAA", 0.5)],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("stakes through");
  });

  it("is empty for an account with no ties", () => {
    expect(relatedKeys([], [], [])).toEqual([]);
  });
});

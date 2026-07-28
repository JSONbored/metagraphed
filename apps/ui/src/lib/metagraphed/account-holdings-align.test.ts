import { describe, expect, it } from "vitest";
import { alignHoldingsSeries } from "@/components/metagraphed/account-holdings-history";
import type { AccountPositionHistory } from "./types";

function history(netuid: number, rows: Array<[string, number | null]>): AccountPositionHistory {
  return {
    ss58: "5Test",
    netuid,
    point_count: rows.length,
    points: rows.map(([snapshot_date, stake_tao]) => ({
      snapshot_date,
      uid: 1,
      coldkey: null,
      role: "miner",
      active: true,
      stake_tao,
      emission_tao: null,
      rank: null,
      trust: null,
      incentive: null,
      dividends: null,
      yield: null,
    })),
  };
}

describe("alignHoldingsSeries (#8370)", () => {
  it("aligns positions with different date ranges onto one sorted axis", () => {
    const { dates, series } = alignHoldingsSeries([
      {
        netuid: 1,
        history: history(1, [
          ["2026-07-01", 10],
          ["2026-07-02", 12],
          ["2026-07-03", 14],
        ]),
      },
      {
        netuid: 8,
        history: history(8, [
          ["2026-07-02", 5],
          ["2026-07-03", 5],
        ]),
      },
    ]);
    expect(dates).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(series[0]).toEqual({ netuid: 1, values: [10, 12, 14] });
    // SN8's history begins a day later — its band reads 0 that day, not a
    // left-shifted series.
    expect(series[1]).toEqual({ netuid: 8, values: [0, 5, 5] });
  });

  it("treats null stake as 0 rather than dropping the date", () => {
    const { series } = alignHoldingsSeries([
      {
        netuid: 1,
        history: history(1, [
          ["2026-07-01", null],
          ["2026-07-02", 3],
        ]),
      },
    ]);
    expect(series[0]!.values).toEqual([0, 3]);
  });

  it("returns empty axes for no histories", () => {
    const { dates, series } = alignHoldingsSeries([{ netuid: 1, history: undefined }]);
    expect(dates).toEqual([]);
    expect(series).toEqual([{ netuid: 1, values: [] }]);
  });
});

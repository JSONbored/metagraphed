import { describe, expect, it } from "vitest";
import { stakeTransfersTileModel } from "./stake-transfers-tile";
import type { SubnetStakeTransfers } from "./types";

function card(p: Partial<SubnetStakeTransfers>): SubnetStakeTransfers {
  return {
    schema_version: 1,
    netuid: 7,
    window: "30d",
    observed_at: null,
    distinct_senders: 0,
    transfers: 0,
    transfers_per_sender: null,
    ...p,
  };
}

describe("stakeTransfersTileModel", () => {
  it("splits transfers into unique senders + repeat transfers", () => {
    const m = stakeTransfersTileModel(
      card({ distinct_senders: 6, transfers: 18, transfers_per_sender: 3 }),
    );
    expect(m.transfers).toBe(18);
    expect(m.senders).toBe(6);
    expect(m.repeats).toBe(12);
    expect(m.perSender).toBe(3);
    expect(m.segments.map((s) => s.value)).toEqual([6, 12]);
    expect(m.summary).toBe("6 senders, 12 repeat transfers");
  });

  it("degrades an undefined / cold card to a zeroed, empty model", () => {
    for (const c of [undefined, card({})]) {
      const m = stakeTransfersTileModel(c);
      expect(m.transfers).toBe(0);
      expect(m.senders).toBe(0);
      expect(m.repeats).toBe(0);
      expect(m.perSender).toBeNull();
      expect(m.segments.every((s) => s.value === 0)).toBe(true);
      expect(m.summary).toBe("no transfers in this window");
    }
  });

  it("singularizes a lone sender and never yields a negative repeat count", () => {
    const one = stakeTransfersTileModel(
      card({ distinct_senders: 1, transfers: 1, transfers_per_sender: 1 }),
    );
    expect(one.repeats).toBe(0);
    expect(one.summary).toBe("1 sender");

    const junk = stakeTransfersTileModel(card({ distinct_senders: 9, transfers: 4 }));
    expect(junk.repeats).toBe(0);
  });
});

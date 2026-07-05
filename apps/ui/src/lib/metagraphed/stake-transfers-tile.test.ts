import { describe, expect, it } from "vitest";
import { stakeTransfersTileModel } from "./stake-transfers-tile";
import type { SubnetStakeTransfers } from "./types";

function card(partial: Partial<SubnetStakeTransfers>): SubnetStakeTransfers {
  return {
    schema_version: 1,
    netuid: 7,
    window: "30d",
    observed_at: null,
    distinct_senders: 0,
    transfers: 0,
    transfers_per_sender: null,
    ...partial,
  };
}

describe("stakeTransfersTileModel", () => {
  it("summarizes a populated card", () => {
    const m = stakeTransfersTileModel(
      card({ distinct_senders: 6, transfers: 28, transfers_per_sender: 4.67 }),
    );
    expect(m.eyebrow).toBe("Stake transfers");
    expect(m.value).toBe("28");
    expect(m.hint).toBe("6 senders · 4.7/sender");
    expect(m.tone).toBe("accent");
    expect(m.hasActivity).toBe(true);
  });

  it("shows an idle tile for a zeroed (cold-store) card", () => {
    const m = stakeTransfersTileModel(card({}));
    expect(m.value).toBe("0");
    expect(m.hint).toBe("no transfers");
    expect(m.tone).toBe("default");
    expect(m.hasActivity).toBe(false);
  });

  it("falls back safely when the card is missing", () => {
    const m = stakeTransfersTileModel(undefined);
    expect(m.value).toBe("0");
    expect(m.hint).toBe("no transfers");
    expect(m.hasActivity).toBe(false);
  });

  it("singularizes a lone sender and omits a null average", () => {
    const m = stakeTransfersTileModel(
      card({ distinct_senders: 1, transfers: 2, transfers_per_sender: null }),
    );
    expect(m.hint).toBe("1 sender");
    expect(m.hasActivity).toBe(true);
  });
});

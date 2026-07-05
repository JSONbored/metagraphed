import { describe, expect, it } from "vitest";
import { stakeMovesTileModel } from "./stake-moves-tile";
import type { SubnetStakeMoves } from "./types";

function card(p: Partial<SubnetStakeMoves>): SubnetStakeMoves {
  return {
    schema_version: 1,
    netuid: 7,
    window: "30d",
    observed_at: null,
    distinct_movers: 0,
    movements: 0,
    movements_per_mover: null,
    ...p,
  };
}

describe("stakeMovesTileModel", () => {
  it("splits movements into unique movers + repeat moves", () => {
    const m = stakeMovesTileModel(
      card({ distinct_movers: 6, movements: 18, movements_per_mover: 3 }),
    );
    expect(m.movements).toBe(18);
    expect(m.movers).toBe(6);
    expect(m.repeats).toBe(12);
    expect(m.perMover).toBe(3);
    expect(m.segments.map((s) => s.value)).toEqual([6, 12]);
    expect(m.summary).toBe("6 movers, 12 repeat moves");
  });

  it("degrades an undefined / cold card to a zeroed, empty model", () => {
    for (const c of [undefined, card({})]) {
      const m = stakeMovesTileModel(c);
      expect(m.movements).toBe(0);
      expect(m.movers).toBe(0);
      expect(m.repeats).toBe(0);
      expect(m.perMover).toBeNull();
      expect(m.segments.every((s) => s.value === 0)).toBe(true);
      expect(m.summary).toBe("no re-delegations in this window");
    }
  });

  it("singularizes a lone mover and never yields a negative repeat count", () => {
    const one = stakeMovesTileModel(
      card({ distinct_movers: 1, movements: 1, movements_per_mover: 1 }),
    );
    expect(one.repeats).toBe(0);
    expect(one.summary).toBe("1 mover");

    // junk store where movers > movements must still floor repeats at 0
    const junk = stakeMovesTileModel(card({ distinct_movers: 9, movements: 4 }));
    expect(junk.repeats).toBe(0);
  });
});

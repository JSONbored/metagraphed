import { describe, expect, it } from "vitest";
import {
  ECONOMIC_BOARD_KEYS,
  OPERATIONAL_BOARD_KEYS,
  REGISTRY_BOARD_SPECS,
} from "./registry-leaderboard-boards";
import { LEADERBOARD_BOARD_KEYS, normalizeLeaderboards } from "./queries";

describe("normalizeLeaderboards (#6995)", () => {
  it("keeps all ten registry board keys, including economic opportunity", () => {
    expect(LEADERBOARD_BOARD_KEYS).toEqual([
      "healthiest",
      "fastest-rpc",
      "most-complete",
      "most-enriched",
      "fastest-growing",
      "most-reliable",
      "open-slots",
      "cheapest-registration",
      "highest-emission",
      "validator-headroom",
    ]);
    expect([...ECONOMIC_BOARD_KEYS, ...OPERATIONAL_BOARD_KEYS].sort()).toEqual(
      [...LEADERBOARD_BOARD_KEYS].sort(),
    );
  });

  it("normalizes economic + reliability fields and defaults missing boards to []", () => {
    const boards = normalizeLeaderboards({
      "open-slots": [
        {
          netuid: 10,
          slug: "ten",
          name: "Ten",
          open_slots: 200,
          max_uids: 256,
          registration_cost_tao: 0.5,
          registration_allowed: true,
        },
      ],
      "most-reliable": [
        {
          netuid: 7,
          score: 98,
          grade: "A",
          uptime_ratio: 0.99,
          avg_latency_ms: 40,
          sample_count: 100,
          latency_sample_count: 80,
        },
      ],
      "highest-emission": "not-an-array",
    });

    expect(boards["open-slots"]).toHaveLength(1);
    expect(boards["open-slots"][0]).toMatchObject({
      netuid: 10,
      slug: "ten",
      name: "Ten",
      open_slots: 200,
      max_uids: 256,
      registration_cost_tao: 0.5,
      registration_allowed: true,
    });
    expect(boards["most-reliable"][0]).toMatchObject({
      netuid: 7,
      score: 98,
      grade: "A",
      uptime_ratio: 0.99,
      avg_latency_ms: 40,
      sample_count: 100,
      latency_sample_count: 80,
    });
    expect(boards["highest-emission"]).toEqual([]);
    expect(boards.healthiest).toEqual([]);
    expect(boards["validator-headroom"]).toEqual([]);
  });

  it("drops rows without a numeric netuid", () => {
    const boards = normalizeLeaderboards({
      "cheapest-registration": [{ slug: "bad" }, { netuid: 3, registration_cost_tao: 1 }],
    });
    expect(boards["cheapest-registration"]).toHaveLength(1);
    expect(boards["cheapest-registration"][0].netuid).toBe(3);
  });
});

describe("REGISTRY_BOARD_SPECS (#6995)", () => {
  it("defines labels and columns for every board key", () => {
    for (const key of LEADERBOARD_BOARD_KEYS) {
      const spec = REGISTRY_BOARD_SPECS[key];
      expect(spec.key).toBe(key);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.columns.length).toBeGreaterThan(0);
      expect(spec.primaryMetric({ netuid: 1 })).toBeNull();
    }
  });
});

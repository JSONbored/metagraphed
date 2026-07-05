import { describe, it, expect } from "vitest";
import { networkDecentralizationModel } from "./network-decentralization";
import type { ChainConcentration, ChainPerformance } from "./types";

function findTile(model: ReturnType<typeof networkDecentralizationModel>, key: string) {
  return [...model.concentrationTiles, ...model.scoreTiles].find((t) => t.key === key);
}

const CONCENTRATION: ChainConcentration = {
  schema_version: 1,
  subnet_count: 129,
  neuron_count: 30228,
  entity_count: 6375,
  uids_per_entity: 4.74,
  captured_at: "2026-07-05T08:22:10.382Z",
  stake: {
    holders: 8385,
    total: 337397066,
    gini: 0.95325,
    hhi: 0.003325,
    hhi_normalized: 0.003206,
    nakamoto_coefficient: 105,
    top_1pct_share: 0.440809,
    top_5pct_share: 0.856214,
    top_10pct_share: 0.970332,
    top_20pct_share: 0.999098,
    entropy: 8.986092,
    entropy_normalized: 0.689456,
  },
  emission: {
    holders: 6191,
    total: 38493.239,
    gini: 0.899375,
    hhi: 0.002802,
    hhi_normalized: 0.002641,
    nakamoto_coefficient: 118,
    top_1pct_share: 0.315999,
    top_5pct_share: 0.753536,
    top_10pct_share: 0.877576,
    top_20pct_share: 0.947895,
    entropy: 9.426869,
    entropy_normalized: 0.748404,
  },
  entity_stake: null,
  entity_emission: null,
  validator_stake: null,
};

const PERFORMANCE: ChainPerformance = {
  schema_version: 1,
  subnet_count: 129,
  neuron_count: 30228,
  validator_count: 1540,
  active_count: 1937,
  captured_at: "2026-07-05T08:22:10.382Z",
  incentive: null,
  dividends: null,
  trust: { count: 30228, mean: 0, min: 0, max: 0, p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 },
  consensus: {
    count: 30228,
    mean: 0.00425,
    min: 0,
    max: 1,
    p10: 0,
    p25: 0,
    p50: 0,
    p75: 0,
    p90: 0.001358,
  },
  validator_trust: {
    count: 1540,
    mean: 0.751977,
    min: 0,
    max: 1,
    p10: 0,
    p25: 0.659602,
    p50: 0.999985,
    p75: 1,
    p90: 1,
  },
};

describe("networkDecentralizationModel", () => {
  it("maps a populated snapshot to formatted tiles with the right tones", () => {
    const model = networkDecentralizationModel(CONCENTRATION, PERFORMANCE);

    expect(model.hasData).toBe(true);
    expect(model.capturedAt).toBe("2026-07-05T08:22:10.382Z");
    expect(model.concentrationTiles).toHaveLength(6);
    expect(model.scoreTiles).toHaveLength(3);

    // Stake Gini is high → "down" tone, emission Gini carried in the hint.
    const stakeGini = findTile(model, "stake-gini");
    expect(stakeGini?.value).toBe("0.953");
    expect(stakeGini?.hint).toBe("emission 0.899");
    expect(stakeGini?.tone).toBe("down");

    // Nakamoto is an integer; 105 entities → resilient → "ok".
    const nakamoto = findTile(model, "stake-nakamoto");
    expect(nakamoto?.value).toBe("105");
    expect(nakamoto?.tone).toBe("ok");

    // Shares render as percentages.
    const top1 = findTile(model, "stake-top1");
    expect(top1?.value).toBe("44.1%");
    expect(top1?.hint).toBe("top 10% 97.0%");

    // Normalized entropy ~0.69 → even-ish → "ok".
    const entropy = findTile(model, "stake-entropy");
    expect(entropy?.value).toBe("0.689");
    expect(entropy?.hint).toBe("8.99 nats");
    expect(entropy?.tone).toBe("ok");

    // Score spread reads a real zero, not a fallback.
    const trust = findTile(model, "trust-median");
    expect(trust?.value).toBe("0.000");
    expect(trust?.hint).toBe("mean 0.000");
    const valTrust = findTile(model, "validator-trust-median");
    expect(valTrust?.value).toBe("1.000");
  });

  it("returns hasData=false and all '—' values for an empty snapshot", () => {
    const model = networkDecentralizationModel(null, null);

    expect(model.hasData).toBe(false);
    expect(model.capturedAt).toBe(null);
    expect(model.concentrationTiles).toHaveLength(6);
    expect(model.scoreTiles).toHaveLength(3);
    // Every tile falls back to the "—" value and a neutral "default" tone.
    for (const tile of [...model.concentrationTiles, ...model.scoreTiles]) {
      expect(tile.value).toBe("—");
      expect(tile.tone).toBe("default");
    }
    expect(findTile(model, "stake-gini")?.value).toBe("—");
    expect(findTile(model, "stake-top1")?.value).toBe("—");
    expect(findTile(model, "trust-median")?.value).toBe("—");
    // Missing hints are dropped rather than rendered as "—".
    expect(findTile(model, "stake-gini")?.hint).toBeUndefined();
  });

  it("tolerates a missing metric block while other blocks still render", () => {
    const concentrationNoEmission: ChainConcentration = { ...CONCENTRATION, emission: null };
    const performanceNoTrust: ChainPerformance = { ...PERFORMANCE, trust: null };

    const model = networkDecentralizationModel(concentrationNoEmission, performanceNoTrust);

    // Stake still resolves → the card stays populated.
    expect(model.hasData).toBe(true);
    expect(findTile(model, "stake-gini")?.value).toBe("0.953");
    // Emission block gone → its Gini tile and the stake-gini emission hint fall back.
    expect(findTile(model, "emission-gini")?.value).toBe("—");
    expect(findTile(model, "emission-gini")?.tone).toBe("default");
    expect(findTile(model, "stake-gini")?.hint).toBeUndefined();
    // Missing trust block → "—", but consensus/val-trust still render.
    expect(findTile(model, "trust-median")?.value).toBe("—");
    expect(findTile(model, "trust-median")?.hint).toBeUndefined();
    expect(findTile(model, "validator-trust-median")?.value).toBe("1.000");
  });
});

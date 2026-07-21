import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { leaderboardsQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

// Boards shaped exactly as GET /api/v1/registry/leaderboards returns them
// (live-verified 2026-07-21): each board carries only its own metric columns.
function resolveWith(boards: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data: { boards },
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/registry/leaderboards",
  });
}

async function runQuery() {
  const opts = leaderboardsQuery();
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

beforeEach(() => {
  mockedApiFetch.mockReset();
});

describe("leaderboardsQuery normalizer — registry boards (#6995)", () => {
  it("exposes all ten operational + economic boards, defaulting missing ones to []", async () => {
    resolveWith({});
    const res = await runQuery();
    expect(Object.keys(res.data).sort()).toEqual(
      [
        "cheapest-registration",
        "fastest-growing",
        "fastest-rpc",
        "healthiest",
        "highest-emission",
        "most-complete",
        "most-enriched",
        "most-reliable",
        "open-slots",
        "validator-headroom",
      ].sort(),
    );
    expect(res.data["open-slots"]).toEqual([]);
  });

  it("extracts the economic-board metric columns", async () => {
    resolveWith({
      "open-slots": [
        {
          netuid: 122,
          slug: "sn-122",
          name: "Bitrecs",
          open_slots: 252,
          max_uids: 256,
          registration_cost_tao: 0.999999999,
          registration_allowed: true,
        },
      ],
      "highest-emission": [
        {
          netuid: 64,
          slug: "sn-64",
          name: "Chutes",
          emission_share: 0.054756,
          total_stake_tao: 3674872.73,
          validator_count: 18,
          miner_count: 238,
        },
      ],
      "validator-headroom": [
        {
          netuid: 1,
          slug: "sn-1",
          name: "Apex",
          validator_headroom: 119,
          validator_count: 9,
          max_validators: 128,
          emission_share: 0.00641,
        },
      ],
    });
    const res = await runQuery();
    expect(res.data["open-slots"][0]).toMatchObject({
      netuid: 122,
      name: "Bitrecs",
      open_slots: 252,
      max_uids: 256,
      registration_cost_tao: 0.999999999,
      registration_allowed: true,
    });
    expect(res.data["highest-emission"][0]).toMatchObject({
      emission_share: 0.054756,
      total_stake_tao: 3674872.73,
      validator_count: 18,
      miner_count: 238,
    });
    expect(res.data["validator-headroom"][0]).toMatchObject({
      validator_headroom: 119,
      max_validators: 128,
    });
  });

  it("extracts the most-reliable score + letter grade", async () => {
    resolveWith({
      "most-reliable": [
        {
          netuid: 5,
          slug: "sn-5",
          name: "Openkaito",
          score: 98,
          grade: "A",
          uptime_ratio: 0.99,
          avg_latency_ms: 120,
          sample_count: 288,
        },
      ],
    });
    const res = await runQuery();
    expect(res.data["most-reliable"][0]).toMatchObject({
      netuid: 5,
      score: 98,
      grade: "A",
    });
  });

  it("drops rows without a numeric netuid and ignores boards outside the surfaced set", async () => {
    resolveWith({
      "open-slots": [{ slug: "sn-x", open_slots: 5 }],
      "biggest-alpha-gain-1d": [{ netuid: 7, alpha_price_change_1d: 0.5 }],
    });
    const res = await runQuery();
    expect(res.data["open-slots"]).toEqual([]);
    expect(res.data).not.toHaveProperty("biggest-alpha-gain-1d");
  });
});

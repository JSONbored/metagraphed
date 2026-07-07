import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetTurnover, subnetTurnoverQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7/turnover",
  });
}

async function runQuery(netuid: number, window?: string) {
  const opts = subnetTurnoverQuery(netuid, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeSubnetTurnover", () => {
  it("passes a well-formed comparable card through", () => {
    expect(
      normalizeSubnetTurnover(7, {
        schema_version: 1,
        netuid: 7,
        window: "30d",
        start_date: "2026-06-01",
        end_date: "2026-07-01",
        comparable: true,
        validators_start: 10,
        validators_end: 9,
        validators_entered: 1,
        validators_exited: 2,
        validator_retention: 0.8,
        neurons_start: 256,
        neurons_end: 250,
        uids_deregistered: 6,
        neuron_retention: 0.97,
        stability_score: 88,
      }),
    ).toEqual({
      schema_version: 1,
      netuid: 7,
      window: "30d",
      start_date: "2026-06-01",
      end_date: "2026-07-01",
      comparable: true,
      validators_start: 10,
      validators_end: 9,
      validators_entered: 1,
      validators_exited: 2,
      validator_retention: 0.8,
      neurons_start: 256,
      neurons_end: 250,
      uids_deregistered: 6,
      neuron_retention: 0.97,
      stability_score: 88,
    });
  });

  it("degrades a cold / junk store to a schema-stable, non-comparable card", () => {
    for (const raw of [{}, null, "x", { validators_start: "nope" }]) {
      const card = normalizeSubnetTurnover(7, raw);
      expect(card.netuid).toBe(7);
      expect(card.comparable).toBe(false);
      expect(card.validators_start).toBe(0);
      expect(card.validators_end).toBe(0);
      expect(card.validator_retention).toBeNull();
      expect(card.neuron_retention).toBeNull();
      expect(card.stability_score).toBeNull();
      expect(card.start_date).toBeNull();
      expect(card.end_date).toBeNull();
    }
  });

  it("never treats a non-boolean comparable value as true", () => {
    const card = normalizeSubnetTurnover(7, { comparable: 1, validators_start: 4 });
    expect(card.comparable).toBe(false);
    expect(card.validators_start).toBe(4);
  });
});

describe("subnetTurnoverQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and normalizes the card", async () => {
    resolveWith({ netuid: 7, window: "7d", comparable: true, stability_score: 95 });
    const res = await runQuery(7, "7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/turnover",
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.stability_score).toBe(95);
    expect(res.data.comparable).toBe(true);
  });

  it("defaults to the 30d window", async () => {
    resolveWith({});
    await runQuery(7);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/turnover",
      expect.objectContaining({ params: { window: "30d" } }),
    );
  });
});

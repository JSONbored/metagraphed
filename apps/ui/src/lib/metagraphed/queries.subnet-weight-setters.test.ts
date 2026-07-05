import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { normalizeSubnetWeightSetter, subnetWeightSettersQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7/weights/setters",
  });
}

async function runQuery(netuid: number, window?: string) {
  const opts = subnetWeightSettersQuery(netuid, window);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("normalizeSubnetWeightSetter", () => {
  it("passes a well-formed setter row through", () => {
    const raw = {
      hotkey: "5Grw",
      uid: 3,
      weight_sets: 12,
      share: 0.4,
      first_set_at: "2026-07-01T00:00:00Z",
      last_set_at: "2026-07-02T00:00:00Z",
    };
    expect(normalizeSubnetWeightSetter(raw)).toEqual(raw);
  });

  it("keeps a uid-only row and coerces junk cells to null / 0", () => {
    const setter = normalizeSubnetWeightSetter({
      hotkey: 42,
      uid: 9,
      weight_sets: "nope",
      share: { x: 1 },
    });
    expect(setter).not.toBeNull();
    expect(setter?.hotkey).toBeNull();
    expect(setter?.uid).toBe(9);
    expect(setter?.weight_sets).toBe(0);
    expect(setter?.share).toBeNull();
  });

  it("drops a row with neither hotkey nor uid", () => {
    expect(normalizeSubnetWeightSetter({ weight_sets: 5 })).toBeNull();
    expect(normalizeSubnetWeightSetter(null)).toBeNull();
    expect(normalizeSubnetWeightSetter("x")).toBeNull();
  });
});

describe("subnetWeightSettersQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes the window param and filters junk setters", async () => {
    resolveWith({
      netuid: 7,
      window: "7d",
      distinct_setters: 1,
      setters: [
        { hotkey: "5Grw", uid: 1, weight_sets: 4 },
        { weight_sets: 9 }, // no hotkey/uid -> dropped
      ],
    });
    const res = await runQuery(7, "7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/weights/setters",
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.setters).toHaveLength(1);
    expect(res.data.setters[0]?.hotkey).toBe("5Grw");
  });

  it("defaults to 30d and degrades a cold store to a zeroed leaderboard", async () => {
    resolveWith({});
    const res = await runQuery(7);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/weights/setters",
      expect.objectContaining({ params: { window: "30d" } }),
    );
    expect(res.data.setters).toEqual([]);
    expect(res.data.setter_count).toBe(0);
    expect(res.data.netuid).toBe(7);
  });
});

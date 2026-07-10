import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { chainWeightSettersQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/chain/weights/setters",
  });
}

async function runQuery(window?: string) {
  const opts = chainWeightSettersQuery(window as "7d" | "30d" | undefined);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("chainWeightSettersQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("passes window/limit params and normalizes setters", async () => {
    resolveWith({
      window: "7d",
      distinct_setters: 2,
      weight_sets: 10,
      setters: [
        { hotkey: "5Grw", uid: 1, weight_sets: 6, share: 0.6, last_set_at: "2026-07-01T00:00:00Z" },
        { uid: 9, weight_sets: 4, share: 0.4 },
        { weight_sets: 1 },
      ],
    });
    const res = await runQuery("7d");
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/chain/weights/setters",
      expect.objectContaining({ params: { window: "7d", limit: 20 } }),
    );
    expect(res.data.distinct_setters).toBe(2);
    expect(res.data.setters).toHaveLength(2);
    expect(res.data.setters[0]?.hotkey).toBe("5Grw");
    expect(res.data.setters[1]?.hotkey).toBeNull();
    expect(res.data.setters[1]?.uid).toBe(9);
  });

  it("returns an empty card for junk payloads", async () => {
    resolveWith(null);
    const res = await runQuery();
    expect(res.data.setters).toEqual([]);
    expect(res.data.distinct_setters).toBe(0);
    expect(res.data.window).toBe("7d");
  });
});

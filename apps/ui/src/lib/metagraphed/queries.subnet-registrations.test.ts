import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import {
  normalizeSubnetDeregistrations,
  normalizeSubnetRegistrations,
  subnetDeregistrationsQuery,
  subnetRegistrationsQuery,
} from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "/api/v1/subnets/7",
  });
}

// Invoke a queryOptions' queryFn directly (the factory returns a fully-typed
// options object; each call site keeps its own precise data type).
function runQuery<
  O extends {
    queryKey: readonly unknown[];
    queryFn?: (context: never) => unknown;
  },
>(opts: O): ReturnType<NonNullable<O["queryFn"]>> {
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as never) as ReturnType<NonNullable<O["queryFn"]>>;
}

describe("normalizeSubnetRegistrations", () => {
  it("passes a well-formed card through", () => {
    const raw = {
      schema_version: 1,
      netuid: 7,
      window: "30d",
      observed_at: "2026-07-01T00:00:00Z",
      distinct_registrants: 3,
      registrations: 8,
      registrations_per_registrant: 2.6667,
    };
    expect(normalizeSubnetRegistrations(7, raw)).toEqual(raw);
  });

  it("degrades cold / junk to a zeroed card (average null, never NaN)", () => {
    for (const raw of [{}, null, { registrations: "nope" }]) {
      const card = normalizeSubnetRegistrations(7, raw);
      expect(card.netuid).toBe(7);
      expect(card.registrations).toBe(0);
      expect(card.distinct_registrants).toBe(0);
      expect(card.registrations_per_registrant).toBeNull();
    }
  });
});

describe("normalizeSubnetDeregistrations", () => {
  it("passes a well-formed card through", () => {
    const raw = {
      schema_version: 1,
      netuid: 7,
      window: "7d",
      observed_at: null,
      distinct_deregistered_hotkeys: 2,
      deregistrations: 5,
      deregistrations_per_hotkey: 2.5,
    };
    expect(normalizeSubnetDeregistrations(7, raw)).toEqual(raw);
  });

  it("degrades cold / junk to a zeroed card", () => {
    const card = normalizeSubnetDeregistrations(7, {
      deregistrations_per_hotkey: { x: 1 },
    });
    expect(card.deregistrations).toBe(0);
    expect(card.distinct_deregistered_hotkeys).toBe(0);
    expect(card.deregistrations_per_hotkey).toBeNull();
  });
});

describe("registration/deregistration queries", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("registrations: hits its route with the window param", async () => {
    resolveWith({ netuid: 7, registrations: 4 });
    const res = await runQuery(subnetRegistrationsQuery(7, "7d"));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/registrations",
      expect.objectContaining({ params: { window: "7d" } }),
    );
    expect(res.data.registrations).toBe(4);
  });

  it("deregistrations: defaults to the 30d window", async () => {
    resolveWith({});
    await runQuery(subnetDeregistrationsQuery(7));
    expect(mockedApiFetch).toHaveBeenCalledWith(
      "/api/v1/subnets/7/deregistrations",
      expect.objectContaining({ params: { window: "30d" } }),
    );
  });
});

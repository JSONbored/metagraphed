import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { subnetDeregistrationStandingQuery, subnetLifecycleQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: "https://example.test",
  });
}

async function run<T>(opts: { queryFn?: unknown; queryKey: readonly unknown[] }): Promise<T> {
  const fn = opts.queryFn as ((c: Record<string, unknown>) => Promise<T>) | undefined;
  if (!fn) throw new Error("expected a queryFn");
  return fn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  });
}

beforeEach(() => mockedApiFetch.mockReset());

describe("subnetLifecycleQuery", () => {
  it("keeps a pre-capture transition's block NULL rather than zero", async () => {
    // THE DISTINCTION. Every subnet alive when the lane first ran was
    // registered before we were watching, so its block is null. Coercing that
    // to 0 would claim it launched at genesis -- and 0 is a real block, so the
    // lie is not even detectable downstream.
    resolveWith({
      entries: [
        {
          netuid: 64,
          event: "registered",
          block_number: null,
          observed_at: "2026-08-09T01:06:16.110Z",
          predates_capture: true,
        },
      ],
    });
    const out = await run<{ data: Array<Record<string, unknown>> }>(subnetLifecycleQuery(64));
    expect(out.data[0]?.block_number).toBeNull();
    expect(out.data[0]?.block_number).not.toBe(0);
    expect(out.data[0]?.predates_capture).toBe(true);
  });

  it("keeps a real block 0 distinguishable from a missing one", async () => {
    resolveWith({
      entries: [
        {
          netuid: 1,
          event: "registered",
          block_number: 0,
          observed_at: null,
          predates_capture: false,
        },
      ],
    });
    const out = await run<{ data: Array<Record<string, unknown>> }>(subnetLifecycleQuery(1));
    expect(out.data[0]?.block_number).toBe(0);
    expect(out.data[0]?.predates_capture).toBe(false);
  });

  it("drops entries with no netuid or no event rather than inventing one", async () => {
    resolveWith({ entries: [{ event: "registered" }, { netuid: 5 }, {}] });
    const out = await run<{ data: unknown[] }>(subnetLifecycleQuery(5));
    expect(out.data).toEqual([]);
  });

  it("an empty list is a real answer, not an error", async () => {
    resolveWith({ entries: [] });
    const out = await run<{ data: unknown[] }>(subnetLifecycleQuery(9));
    expect(out.data).toEqual([]);
  });
});

describe("subnetDeregistrationStandingQuery", () => {
  const ranked = {
    netuid: 70,
    rank: 1,
    comparison_price: 0.0014243,
    moving_price: 0.0014243,
    registered_at_block: 7787562,
    subnet_mechanism: 1,
    immune: false,
    immune_until_block: null,
    blocks_until_prunable: 0,
  };
  const immune = {
    netuid: 78,
    rank: null,
    comparison_price: 0.0027054,
    moving_price: 0.0027054,
    registered_at_block: 7966145,
    subnet_mechanism: 1,
    immune: true,
    immune_until_block: 8830145,
    blocks_until_prunable: 18832,
  };
  const payload = {
    ranked: [ranked],
    immune: [immune],
    ranked_count: 112,
    immune_count: 16,
    next_to_deregister: 70,
  };

  it("finds a subnet in the ranked list", async () => {
    resolveWith(payload);
    const out = await run<{ data: { standing: { rank: number } | null } }>(
      subnetDeregistrationStandingQuery(70),
    );
    expect(out.data.standing?.rank).toBe(1);
  });

  it("finds a subnet in the IMMUNE list, where rank is null not zero", async () => {
    // An immune subnet is not near the top of the pruning order -- it is not in
    // the order at all. `rank: 0` would read as "first to be pruned", the exact
    // inverse of the truth, so null must survive normalisation.
    resolveWith(payload);
    const out = await run<{
      data: { standing: { rank: number | null; immune: boolean } | null };
    }>(subnetDeregistrationStandingQuery(78));
    expect(out.data.standing?.immune).toBe(true);
    expect(out.data.standing?.rank).toBeNull();
    expect(out.data.standing?.rank).not.toBe(0);
  });

  it("a subnet in neither list is null, not a fabricated standing", async () => {
    // Root is the live case: never a pruning candidate. "Not a candidate" and
    // "rank unknown" are different statements and the panel renders them
    // differently, so this must not resolve to an empty object.
    resolveWith(payload);
    const out = await run<{ data: { standing: unknown } }>(subnetDeregistrationStandingQuery(0));
    expect(out.data.standing).toBeNull();
  });

  it("keeps comparison_price and moving_price separate", async () => {
    // They differ only for a Stable-mechanism subnet, where the pallet
    // substitutes a flat 1.0 -- which moves it from the top of a price order to
    // near the bottom. Collapsing them hides the substitution, and #10285
    // exists because ordering on the raw price gets position one wrong.
    resolveWith({
      ranked: [
        { ...ranked, netuid: 12, subnet_mechanism: 0, comparison_price: 1, moving_price: 0.004 },
      ],
      immune: [],
      ranked_count: 1,
    });
    const out = await run<{
      data: {
        standing: { comparison_price: number; moving_price: number } | null;
      };
    }>(subnetDeregistrationStandingQuery(12));
    expect(out.data.standing?.comparison_price).toBe(1);
    expect(out.data.standing?.moving_price).toBe(0.004);
  });

  it("carries the ranked total, since a rank means little without it", async () => {
    resolveWith(payload);
    const out = await run<{ data: { ranked_count: number | null } }>(
      subnetDeregistrationStandingQuery(70),
    );
    expect(out.data.ranked_count).toBe(112);
  });
});

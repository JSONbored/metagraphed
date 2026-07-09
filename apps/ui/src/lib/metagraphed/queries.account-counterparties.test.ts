import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiResult } from "./client";
import { apiFetch } from "./client";
import { accountCounterpartiesQuery } from "./queries";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, apiFetch: vi.fn() };
});

const mockedApiFetch = vi.mocked(apiFetch);

// Valid-format ss58 addresses (ss58PathSegment rejects malformed input).
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

function resolveWith(data: unknown): void {
  mockedApiFetch.mockResolvedValue({
    data,
    meta: {} as ApiResult<unknown>["meta"],
    url: `/api/v1/accounts/${ALICE}/counterparties`,
  });
}

async function runQuery(ss58: string) {
  const opts = accountCounterpartiesQuery(ss58);
  if (!opts.queryFn) throw new Error("expected a queryFn");
  return opts.queryFn({
    signal: new AbortController().signal,
    queryKey: opts.queryKey,
    meta: undefined,
  } as unknown as Parameters<NonNullable<typeof opts.queryFn>>[0]);
}

describe("accountCounterpartiesQuery", () => {
  beforeEach(() => {
    mockedApiFetch.mockReset();
  });

  it("hits the counterparties route and passes through a well-formed row", async () => {
    resolveWith({
      ss58: ALICE,
      counterparty_count: 1,
      transfers_scanned: 42,
      scan_capped: false,
      total_sent_tao: 10,
      total_received_tao: 5,
      counterparties: [
        {
          address: BOB,
          sent_tao: 7,
          received_tao: 3,
          net_tao: -4,
          transfer_count: 5,
          last_block: 1234,
        },
      ],
    });
    const res = await runQuery(ALICE);
    expect(mockedApiFetch).toHaveBeenCalledWith(
      `/api/v1/accounts/${ALICE}/counterparties`,
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(res.data).toMatchObject({
      ss58: ALICE,
      counterparty_count: 1,
      transfers_scanned: 42,
      scan_capped: false,
      total_sent_tao: 10,
      total_received_tao: 5,
    });
    expect(res.data.counterparties).toEqual([
      {
        address: BOB,
        sent_tao: 7,
        received_tao: 3,
        net_tao: -4,
        transfer_count: 5,
        last_block: 1234,
      },
    ]);
  });

  it("drops rows with no address and coerces junk numeric cells to null (never NaN)", async () => {
    resolveWith({
      ss58: ALICE,
      counterparties: [
        { address: BOB, sent_tao: "nope", received_tao: {}, net_tao: null },
        { sent_tao: 1 }, // no address → dropped
      ],
    });
    const res = await runQuery(ALICE);
    expect(res.data.counterparties).toEqual([
      {
        address: BOB,
        sent_tao: null,
        received_tao: null,
        net_tao: null,
        transfer_count: null,
        last_block: null,
      },
    ]);
    // counterparty_count falls back to the surviving-row count when absent.
    expect(res.data.counterparty_count).toBe(1);
  });

  it("degrades a cold / unknown account to an empty leaderboard (never throws)", async () => {
    for (const raw of [{}, null, { counterparties: "not-an-array" }]) {
      resolveWith(raw);
      const res = await runQuery(ALICE);
      expect(res.data.ss58).toBe(ALICE);
      expect(res.data.counterparties).toEqual([]);
      expect(res.data.counterparty_count).toBe(0);
      expect(res.data.total_sent_tao).toBeNull();
    }
  });
});

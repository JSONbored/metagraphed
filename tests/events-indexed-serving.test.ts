import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadIndexedAccountFeedPage } from "../src/indexed-account-feeds.ts";
import {
  loadAccountEventsColdTier,
  loadSubnetEventsColdTier,
} from "../src/events-cold-tier.ts";
import {
  buildAccountEvents,
  buildAccountTransfers,
  buildSubnetEvents,
} from "../src/account-events.ts";
import {
  loadAccountTransfersColdTier,
  loadAccountCounterpartiesColdTier,
  loadCounterpartyRelationshipColdTier,
} from "../src/account-feeds-cold-tier.ts";
import {
  buildCounterparties,
  buildCounterpartyRelationship,
} from "../src/counterparties.ts";
import { encodeCursor } from "../src/cursor.ts";

vi.mock("../src/indexed-account-feeds.ts", () => ({
  loadIndexedAccountFeedPage: vi.fn(),
}));
const read = vi.mocked(loadIndexedAccountFeedPage);
const address = "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F";
const peer = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
const row = {
  block_number: 100,
  event_index: 2,
  extrinsic_index: 1,
  event_kind: "Transfer",
  hotkey: address,
  coldkey: address,
  netuid: 7,
  uid: null,
  amount_tao: 12,
  alpha_amount: null,
  observed_at: 1700000000100,
};
const nextCursor = encodeCursor([
  row.observed_at,
  row.block_number,
  row.event_index,
]);
const env = { METAGRAPH_ARCHIVE: { get: vi.fn() } };

beforeEach(() => {
  read.mockReset();
  env.METAGRAPH_ARCHIVE.get.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Unexpected SQL fallback");
    }),
  );
});

describe("indexed event route parity", () => {
  it("retains transfer direction, block bounds, cursor, self transfers and offset semantics", async () => {
    read.mockResolvedValue([row]);
    for (const direction of ["all", "sent", "received"] as const) {
      expect(
        await loadAccountTransfersColdTier(env as never, address, {
          limit: 1,
          offset: 3,
          direction,
          blockStart: "80",
          blockEnd: 120,
        }),
      ).toEqual(
        buildAccountTransfers([row], address, {
          limit: 1,
          offset: 3,
          nextCursor,
          direction: direction === "all" ? undefined : direction,
        }),
      );
      const sides =
        direction === "all"
          ? ["hotkey", "coldkey"]
          : direction === "sent"
            ? ["hotkey"]
            : ["coldkey"];
      expect(read).toHaveBeenLastCalledWith(
        env,
        sides.map((side) => ({
          side,
          account: address,
          kind: "Transfer",
          blockStart: 80,
          blockEnd: 120,
          cursor: null,
        })),
        1,
        3,
      );
    }
    await loadAccountTransfersColdTier(env as never, address, {
      limit: 1,
      offset: 3,
      cursor: nextCursor,
    });
    expect(read).toHaveBeenLastCalledWith(
      env,
      ["hotkey", "coldkey"].map((side) => ({
        side,
        account: address,
        kind: "Transfer",
        blockStart: undefined,
        blockEnd: undefined,
        cursor: [row.observed_at, row.block_number, row.event_index],
      })),
      1,
      0,
    );
    read.mockResolvedValue([]);
    expect(
      await loadAccountTransfersColdTier(env as never, address, { limit: 50 }),
    ).toEqual(
      buildAccountTransfers([], address, {
        limit: 50,
        offset: 0,
        nextCursor: null,
      }),
    );
    read.mockResolvedValue(null);
    expect(
      await loadAccountTransfersColdTier(env as never, address, { limit: 50 }),
    ).toBeNull();
    expect(env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains complete counterparty and relationship payloads from the same capped newest rows", async () => {
    const rows = [
      { ...row, coldkey: peer },
      { ...row, hotkey: peer, amount_tao: 3, block_number: 99, event_index: 1 },
    ];
    read.mockResolvedValue(rows);
    expect(
      await loadAccountCounterpartiesColdTier(env as never, address, {
        limit: 1,
      }),
    ).toEqual(buildCounterparties(rows, address, { limit: 1 }));
    expect(read).toHaveBeenLastCalledWith(
      env,
      ["hotkey", "coldkey"].map((side) => ({
        side,
        account: address,
        kind: "Transfer",
      })),
      5000,
    );
    const relationship = buildCounterpartyRelationship(rows, address, peer, {
      limit: 1,
    });
    expect(
      await loadCounterpartyRelationshipColdTier(env as never, address, peer, {
        limit: 1,
      }),
    ).toEqual({
      schema_version: 1,
      ss58: address,
      counterparty_count: 1,
      transfers_scanned: relationship.transfers_scanned,
      scan_capped: relationship.scan_capped,
      total_sent_tao: relationship.total_sent_tao,
      total_received_tao: relationship.total_received_tao,
      counterparties: [
        {
          address: peer,
          sent_tao: relationship.total_sent_tao,
          received_tao: relationship.total_received_tao,
          net_tao: relationship.net_tao,
          transfer_count: relationship.transfer_count,
          last_block: relationship.last_block,
        },
      ],
      relationship,
    });
    expect(read).toHaveBeenLastCalledWith(
      env,
      ["hotkey", "coldkey"].map((side) => ({
        side,
        account: address,
        counterparty: peer,
        kind: "Transfer",
      })),
      5000,
    );
    read.mockResolvedValue([]);
    expect(
      await loadAccountCounterpartiesColdTier(env as never, address),
    ).toEqual(buildCounterparties([], address));
    expect(
      await loadCounterpartyRelationshipColdTier(env as never, address, peer),
    ).toMatchObject({
      counterparty_count: 0,
      transfers_scanned: 0,
      counterparties: [],
      relationship: buildCounterpartyRelationship([], address, peer),
    });
    read.mockResolvedValue(null);
    expect(
      await loadAccountCounterpartiesColdTier(env as never, address),
    ).toBeNull();
    expect(
      await loadCounterpartyRelationshipColdTier(env as never, address, peer),
    ).toBeNull();
    expect(env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps account filters, offset, cursor and formatter semantics without a SQL request", async () => {
    read.mockResolvedValue([row]);
    const query = {
      limit: 1,
      offset: 3,
      kind: "Transfer",
      netuid: "7",
      blockStart: "80",
      blockEnd: 120,
    };
    expect(
      await loadAccountEventsColdTier(env as never, address, query, "testnet"),
    ).toEqual(
      buildAccountEvents([row], address, { limit: 1, offset: 3, nextCursor }),
    );
    const filters = {
      kind: "Transfer",
      netuid: 7,
      blockStart: 80,
      blockEnd: 120,
      cursor: null,
    };
    expect(read).toHaveBeenLastCalledWith(
      env,
      [
        { ...filters, side: "hotkey", account: address },
        { ...filters, side: "coldkey", account: address },
      ],
      1,
      3,
      "testnet",
    );
    await loadAccountEventsColdTier(env as never, address, {
      limit: 1,
      offset: 3,
      cursor: nextCursor,
    });
    expect(read).toHaveBeenLastCalledWith(
      env,
      [
        {
          kind: null,
          netuid: null,
          blockStart: undefined,
          blockEnd: undefined,
          cursor: [row.observed_at, 100, 2],
          side: "hotkey",
          account: address,
        },
        {
          kind: null,
          netuid: null,
          blockStart: undefined,
          blockEnd: undefined,
          cursor: [row.observed_at, 100, 2],
          side: "coldkey",
          account: address,
        },
      ],
      1,
      0,
      undefined,
    );
    expect(env.METAGRAPH_ARCHIVE.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps subnet paging and filters without applying an offset twice", async () => {
    read.mockResolvedValue([row]);
    expect(
      await loadSubnetEventsColdTier(
        env as never,
        7,
        {
          limit: 1,
          offset: 4,
          kind: "Transfer",
          blockStart: 80,
          blockEnd: 120,
        },
        "testnet",
      ),
    ).toEqual(buildSubnetEvents([row], 7, { limit: 1, offset: 4, nextCursor }));
    expect(read).toHaveBeenLastCalledWith(
      env,
      [
        {
          side: "all",
          account: "*",
          kind: "Transfer",
          netuid: 7,
          blockStart: 80,
          blockEnd: 120,
          cursor: null,
        },
      ],
      1,
      4,
      "testnet",
    );
    await loadSubnetEventsColdTier(env as never, 7, {
      limit: 1,
      offset: 4,
      cursor: nextCursor,
    });
    expect(read.mock.calls.at(-1)?.[3]).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves proven empty pages and fails closed on corrupt selected history", async () => {
    read.mockResolvedValue([]);
    expect(
      await loadAccountEventsColdTier(env as never, address, { limit: 5 }),
    ).toEqual(
      buildAccountEvents([], address, {
        limit: 5,
        offset: 0,
        nextCursor: null,
      }),
    );
    expect(
      await loadSubnetEventsColdTier(env as never, 7, { limit: 5 }),
    ).toEqual(
      buildSubnetEvents([], 7, { limit: 5, offset: 0, nextCursor: null }),
    );
    read.mockResolvedValue(null);
    expect(
      await loadAccountEventsColdTier(env as never, address, { limit: 5 }),
    ).toBeNull();
    expect(
      await loadSubnetEventsColdTier(env as never, 7, { limit: 5 }),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});

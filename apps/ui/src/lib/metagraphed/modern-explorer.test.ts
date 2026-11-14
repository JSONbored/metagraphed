import { describe, expect, it, vi } from "vitest";
import { createV2ReadClient } from "../../../../../src/v2/client.ts";
import { V2AccountBalanceSchema } from "../../../../../schemas-src/v2/balance.ts";
import { modernAccountBalanceRow } from "../../../../../scripts/lib/modern-verification-fixture.ts";
import { MODERN_FINNEY_GENESIS, modernCatalogConfiguration } from "./modern-catalog";
import {
  blockDetailInput,
  modernBlockHref,
  modernExplorerPath,
  readModernBlock,
  readModernBlocks,
  modernAccountAnchor,
  modernAccountKey,
  modernAccountPath,
  readModernAccountEvents,
  MODERN_ACCOUNT_MAX_PAGES,
  modernStakeAnchor,
  modernStakeKey,
  modernStakePath,
  readModernAccountStake,
  MODERN_STAKE_PAGE_SIZE,
  modernBalanceKey,
  modernBalancePath,
  readModernAccountBalance,
} from "./modern-explorer";
import {
  modernExplorerFixture,
  MODERN_EXPLORER_HEIGHT,
  MODERN_EXPLORER_PARTICIPANT,
} from "../../../tests/e2e/modern-explorer-fixture";

const scope = {
  origin: "https://example.test",
  network: "finney",
  genesis: MODERN_FINNEY_GENESIS,
} as const;
function fixture(change?: (value: Record<string, unknown>, url: URL) => void) {
  const urls: URL[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    const response = modernExplorerFixture(url)!;
    const value = JSON.parse(response.body);
    change?.(value, url);
    return new Response(JSON.stringify(value), {
      status: response.status,
      headers: { "content-type": response.contentType },
    });
  });
  return { reader: createV2ReadClient({ origin: scope.origin, fetch }), urls };
}

describe("modern explorer selection and pinned reads", () => {
  it("separates exact balance cache keys and paths from account history and stake", () => {
    const account = MODERN_EXPLORER_PARTICIPANT;
    const key = modernBalanceKey(scope, account);
    expect(key).toEqual([
      "metagraphed",
      "v2",
      scope.origin,
      scope.network,
      scope.genesis,
      0,
      "explorer",
      "account-balance",
      account,
    ]);
    for (const changed of [
      modernBalanceKey({ ...scope, origin: "https://another.example" }, account),
      modernBalanceKey(scope, `0x${"b".repeat(64)}`),
      modernBalanceKey(scope, account, 1),
      modernAccountKey(scope, account, 0),
      modernStakeKey(scope, account, 0),
    ])
      expect(changed).not.toEqual(key);
    expect(modernBalancePath(scope, account)).toBe(
      `/api/v2/networks/finney/accounts/${account}/balance`,
    );
    expect(modernBalancePath(scope, "untrusted/key?selector")).toBe(
      "/api/v2/networks/finney/accounts/untrusted%2Fkey%3Fselector/balance",
    );
  });

  it("forwards balance scope genesis and cancellation to the canonical reader", async () => {
    const row = modernAccountBalanceRow(MODERN_EXPLORER_PARTICIPANT);
    const value = V2AccountBalanceSchema.parse({
      api_version: "2",
      account_id: MODERN_EXPLORER_PARTICIPANT,
      network: row.network,
      snapshot: row.snapshot,
      balance: row.balance,
      result: row.result,
      freshness: {
        status: "stale",
        age_seconds: 3600,
        finalized_lag_blocks: "300",
        target_seconds: 30,
        target_blocks: 2,
      },
    });
    const fetch = vi.fn();
    const reader = createV2ReadClient({ origin: scope.origin, fetch });
    const read = vi.spyOn(reader, "read").mockResolvedValue(value);
    const controller = new AbortController();
    expect(
      await readModernAccountBalance(reader, scope, MODERN_EXPLORER_PARTICIPANT, controller.signal),
    ).toBe(value);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(
      "get_account_balance",
      { network: scope.network, account_id: MODERN_EXPLORER_PARTICIPANT },
      { expectedGenesisHash: scope.genesis, signal: controller.signal },
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects invalid and cancelled balance selections before fetching", async () => {
    const fetch = vi.fn();
    const reader = createV2ReadClient({ origin: scope.origin, fetch });
    await expect(readModernAccountBalance(reader, scope, "0xdead")).rejects.toMatchObject({
      code: "invalid_input",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      readModernAccountBalance(reader, scope, MODERN_EXPLORER_PARTICIPANT, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cancels a pending balance request through the canonical client", async () => {
    let started!: () => void;
    const fetching = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requestSignal: AbortSignal | null | undefined;
    const fetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal;
          requestSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Cancelled", "AbortError")),
            { once: true },
          );
          started();
        }),
    );
    const reader = createV2ReadClient({ origin: scope.origin, fetch });
    const controller = new AbortController();
    const request = readModernAccountBalance(
      reader,
      scope,
      MODERN_EXPLORER_PARTICIPANT,
      controller.signal,
    );
    await fetching;
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "cancelled" });
    expect(requestSignal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("pages exact stake and claimant entries at a pinned stake publication", async () => {
    const f = fixture();
    const account = MODERN_EXPLORER_PARTICIPANT;
    const first = await readModernAccountStake(f.reader, scope, account);
    expect(first.entries).toHaveLength(10);
    expect(first.entries[0].kind).toBe("position");
    expect(first.entries[1].kind).toBe("root_entitlement");
    const principal = first.entries[0];
    const right = first.entries[1];
    if (principal.kind !== "position" || right.kind !== "root_entitlement")
      throw new Error("Fixture kind order differs");
    expect(principal.position.quote).toEqual({
      status: "exact",
      basis: { kind: "root_tao" },
      atomic_units: "100",
    });
    expect(right.entitlement.principal).toEqual({ status: "exact_rao", value: "100" });
    expect(first.snapshot.spec_version).toBe(486);
    expect(first.stake.state.spec_version).toBe(488);
    const second = await readModernAccountStake(f.reader, scope, account, {
      anchor: modernStakeAnchor(first),
      cursor: first.next_cursor!,
    });
    expect(second.entries).toHaveLength(5);
    expect(second.next_cursor).toBeNull();
    expect(modernStakeAnchor(second)).toEqual(modernStakeAnchor(first));
    expect(modernStakePath(scope, account, first.next_cursor!)).toBe(
      f.urls[1].pathname + f.urls[1].search,
    );
    expect(MODERN_STAKE_PAGE_SIZE).toBe(10);
    expect(modernStakeKey(scope, account, 0)).not.toEqual(modernAccountKey(scope, account, 0));
    for (const changed of [
      modernStakeKey({ ...scope, origin: "https://another.example" }, account, 0),
      modernStakeKey(scope, `0x${"b".repeat(64)}`, 0),
      modernStakeKey(scope, account, 1),
    ])
      expect(changed).not.toEqual(modernStakeKey(scope, account, 0));
  });
  it("rejects foreign stake continuation and propagates cancellation before fetching", async () => {
    const f = fixture();
    const account = MODERN_EXPLORER_PARTICIPANT;
    const first = await readModernAccountStake(f.reader, scope, account);
    const continuation = { anchor: modernStakeAnchor(first), cursor: first.next_cursor! };
    await expect(
      readModernAccountStake(f.reader, scope, `0x${"b".repeat(64)}`, continuation),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      readModernAccountStake(f.reader, scope, account, {
        ...continuation,
        anchor: {
          ...continuation.anchor,
          network: { ...first.network, genesis_hash: `0x${"f".repeat(64)}` },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      readModernAccountStake(f.reader, scope, account, undefined, controller.signal),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(f.urls).toHaveLength(1);
  });
  it("refuses stake continuations whose accepted source state or execution metadata changes", async () => {
    for (const mutate of [
      (v: Record<string, unknown>) => {
        (v.stake as { source_id: string }).source_id = "d".repeat(64);
      },
      (v: Record<string, unknown>) => {
        (v.snapshot as { metadata_digest: string }).metadata_digest = "d".repeat(64);
      },
      (v: Record<string, unknown>) => {
        (v.stake as { state: { producer_revision: string } }).state.producer_revision = "d".repeat(
          40,
        );
      },
    ]) {
      const f = fixture((v, url) => {
        if (url.searchParams.has("cursor")) mutate(v);
      });
      const first = await readModernAccountStake(f.reader, scope, MODERN_EXPLORER_PARTICIPANT);
      await expect(
        readModernAccountStake(f.reader, scope, MODERN_EXPLORER_PARTICIPANT, {
          anchor: modernStakeAnchor(first),
          cursor: first.next_cursor!,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(first.entries).toHaveLength(10);
    }
  });

  it("walks typed account appearances with opaque continuation and exact quantities", async () => {
    const f = fixture();
    const account = MODERN_EXPLORER_PARTICIPANT;
    const first = await readModernAccountEvents(f.reader, scope, account);
    expect(first.events).toHaveLength(25);
    expect(first.events[0].event.event_index).toBe(26);
    expect(first.events[0].matching_participants.map((p) => p.participant_index)).toEqual([0, 2]);
    expect(first.events[0].event.fields).toEqual({ amount_rao: "18446744073709551615" });
    const continuation = { anchor: modernAccountAnchor(first), cursor: first.next_cursor! };
    const second = await readModernAccountEvents(f.reader, scope, account, continuation);
    expect(second.events).toHaveLength(25);
    expect(second.events[0].event.event_index).toBe(1);
    expect(second.events[2].snapshot.block_number).toBe(
      String(BigInt(MODERN_EXPLORER_HEIGHT) - 1n),
    );
    expect(f.urls[1].searchParams.get("cursor")).toBe(first.next_cursor);
    expect(f.urls[1].searchParams.has("from_block")).toBe(false);
    expect(modernAccountAnchor(second)).toEqual(modernAccountAnchor(first));
    expect(modernAccountPath(scope, account, first.next_cursor!)).toBe(
      f.urls[1].pathname + f.urls[1].search,
    );
    expect(MODERN_ACCOUNT_MAX_PAGES).toBeGreaterThan(1);
    expect(modernAccountKey(scope, account, 0)).not.toEqual(modernAccountKey(scope, account, 1));
    expect(modernAccountKey(scope, account, 0)).not.toEqual(
      modernAccountKey(scope, `0x${"b".repeat(64)}`, 0),
    );
    expect(modernAccountKey(scope, account, 0)).not.toEqual(
      modernAccountKey({ ...scope, origin: "https://another.example" }, account, 0),
    );
  });
  it("rejects foreign account scope before fetch and propagates cancellation", async () => {
    const f = fixture();
    const first = await readModernAccountEvents(f.reader, scope, MODERN_EXPLORER_PARTICIPANT);
    const continuation = { anchor: modernAccountAnchor(first), cursor: first.next_cursor! };
    await expect(
      readModernAccountEvents(f.reader, scope, `0x${"b".repeat(64)}`, continuation),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      readModernAccountEvents(f.reader, scope, MODERN_EXPLORER_PARTICIPANT, {
        ...continuation,
        anchor: {
          ...continuation.anchor,
          network: { ...first.network, genesis_hash: `0x${"f".repeat(64)}` },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      readModernAccountEvents(
        f.reader,
        scope,
        MODERN_EXPLORER_PARTICIPANT,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "cancelled" });
    expect(f.urls).toHaveLength(1);
  });
  it("retains accepted account evidence when a continuation changes its revision or source", async () => {
    for (const change of [
      (value: Record<string, unknown>) => {
        (value.revision as { generation: string }).generation = "6";
      },
      (value: Record<string, unknown>) => {
        (value.snapshot as { metadata_digest: string }).metadata_digest = "e".repeat(64);
      },
    ]) {
      const f = fixture((value, url) => {
        if (url.searchParams.has("cursor")) change(value);
      });
      const first = await readModernAccountEvents(f.reader, scope, MODERN_EXPLORER_PARTICIPANT);
      await expect(
        readModernAccountEvents(f.reader, scope, MODERN_EXPLORER_PARTICIPANT, {
          anchor: modernAccountAnchor(first),
          cursor: first.next_cursor!,
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(first.events).toHaveLength(25);
      expect(first.revision.generation).toBe("5");
    }
  });
  it("maps only the supported network and validated public source", () => {
    expect(modernCatalogConfiguration(scope.origin, "mainnet")).toEqual({ status: "ready", scope });
    expect(modernCatalogConfiguration(scope.origin, "testnet")).toEqual({
      status: "unsupported-network",
    });
    expect(modernCatalogConfiguration("https://example.test/path", "mainnet")).toEqual({
      status: "invalid-origin",
    });
  });
  it("continues older blocks at the original anchor and links each own publication", async () => {
    const f = fixture();
    const first = await readModernBlocks(f.reader, scope);
    const last = await readModernBlocks(f.reader, scope, first, first.next_before!);
    expect(first.blocks).toHaveLength(25);
    expect(last.blocks).toHaveLength(5);
    expect(last.next_before).toBeNull();
    expect(f.urls[1].searchParams.get("anchor_height")).toBe(MODERN_EXPLORER_HEIGHT);
    expect(f.urls[1].searchParams.get("anchor_publication_id")).toBe(first.snapshot.publication_id);
    const row = first.blocks[1];
    const link = new URL(modernBlockHref(row), scope.origin);
    expect(link.pathname).toBe(`/blocks/${row.snapshot.block_number}`);
    expect(link.searchParams.get("publication_id")).toBe(row.snapshot.publication_id);
    expect(row.snapshot.publication_id).not.toBe(first.snapshot.publication_id);
    expect(modernExplorerPath(scope, "123", { limit: 25 })).toBe(
      "/api/v2/networks/finney/blocks/123?limit=25",
    );
  });
  it("paginates each body independently while preserving exact quantities and participants", async () => {
    const f = fixture();
    const first = await readModernBlock(f.reader, scope, MODERN_EXPLORER_HEIGHT);
    const pins = {
      block_hash: first.snapshot.block_hash,
      publication_id: first.snapshot.publication_id,
    };
    const events = await readModernBlock(
      f.reader,
      scope,
      MODERN_EXPLORER_HEIGHT,
      pins,
      first,
      "events",
      first.next_event_index!,
    );
    const extrinsics = await readModernBlock(
      f.reader,
      scope,
      MODERN_EXPLORER_HEIGHT,
      pins,
      first,
      "extrinsics",
      first.next_extrinsic_index!,
    );
    expect(events.events.map((event) => event.event_index)).toEqual([25, 26]);
    expect(extrinsics.extrinsics.map((extrinsic) => extrinsic.extrinsic_index)).toEqual([25, 26]);
    expect(events.events[0].fields).toEqual({ amount_rao: "18446744073709551615" });
    expect(events.events[0]).toMatchObject({
      phase: "ApplyExtrinsic",
      extrinsic_index: 25,
      participants: [{ role: "field_0" }, { role: "field_1" }, { role: "field_2" }],
    });
    expect(f.urls[1].searchParams.has("after_extrinsic_index")).toBe(false);
    expect(f.urls[2].searchParams.has("after_event_index")).toBe(false);
    expect(blockDetailInput(scope, MODERN_EXPLORER_HEIGHT, pins).height).toBe(
      MODERN_EXPLORER_HEIGHT,
    );
  });
  it("refuses a changed snapshot without replacing accepted rows", async () => {
    const f = fixture((value, url) => {
      if (url.searchParams.has("after_event_index")) value.source_capture_digest = "f".repeat(64);
    });
    const first = await readModernBlock(f.reader, scope, MODERN_EXPLORER_HEIGHT);
    await expect(
      readModernBlock(
        f.reader,
        scope,
        MODERN_EXPLORER_HEIGHT,
        first.snapshot,
        first,
        "events",
        first.next_event_index!,
      ),
    ).rejects.toMatchObject({ code: "identity_mismatch" });
    expect(first.events).toHaveLength(25);
  });
  it("selects only the two accepted pin fields from a complete snapshot", async () => {
    const f = fixture();
    const first = await readModernBlock(f.reader, scope, MODERN_EXPLORER_HEIGHT);
    const next = await readModernBlock(
      f.reader,
      scope,
      MODERN_EXPLORER_HEIGHT,
      first.snapshot,
      first,
      "events",
      first.next_event_index!,
    );
    expect(next.events.map((event) => event.event_index)).toEqual([25, 26]);
    expect(f.urls[1].searchParams.has("parent_hash")).toBe(false);
    expect(f.urls[1].searchParams.get("block_hash")).toBe(first.snapshot.block_hash);
    expect(f.urls[1].searchParams.get("publication_id")).toBe(first.snapshot.publication_id);
  });
  it("refuses changed list coverage while retaining the accepted anchor", async () => {
    const f = fixture((value, url) => {
      if (url.searchParams.has("before"))
        value.coverage = {
          from_block: String(BigInt(MODERN_EXPLORER_HEIGHT) - 28n),
          through_block: MODERN_EXPLORER_HEIGHT,
          contiguous: true,
        };
    });
    const first = await readModernBlocks(f.reader, scope);
    await expect(
      readModernBlocks(f.reader, scope, first, first.next_before!),
    ).rejects.toMatchObject({ code: "pagination_mismatch" });
    expect(first.blocks).toHaveLength(25);
  });
  it("rejects a partial continuation before issuing a read", async () => {
    const f = fixture();
    await expect(readModernBlocks(f.reader, scope, undefined, "123")).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(f.urls).toEqual([]);
  });
  it("requires a collection, cursor and accepted pins for a body continuation", async () => {
    const f = fixture();
    const first = await readModernBlock(f.reader, scope, MODERN_EXPLORER_HEIGHT);
    const pins = {
      block_hash: first.snapshot.block_hash,
      publication_id: first.snapshot.publication_id,
    };
    await expect(
      readModernBlock(f.reader, scope, MODERN_EXPLORER_HEIGHT, undefined, first, "events", 24),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      readModernBlock(f.reader, scope, MODERN_EXPLORER_HEIGHT, pins, first, undefined, 24),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      readModernBlock(f.reader, scope, MODERN_EXPLORER_HEIGHT, pins, first, "events"),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.urls).toHaveLength(1);
  });
});

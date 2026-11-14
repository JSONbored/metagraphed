import { useEffect, useState } from "react";
import { useHydrated } from "@/hooks/use-hydrated";
import { getApiBase, getNetwork, onApiBaseChange, onNetworkChange } from "./config";
import { useRegisterApiSource } from "./api-source-context";
import {
  modernCatalogConfiguration,
  modernCatalogKey,
  type ModernCatalogConfiguration,
  type ModernCatalogReader,
  type ModernCatalogScope,
} from "./modern-catalog";
import { V2ReadClientError, type V2ReadOutput } from "../../../../../src/v2/client.ts";

export type ModernExplorerScope = ModernCatalogScope;
export type ModernExplorerReader = ModernCatalogReader;
export type ModernBlockList = V2ReadOutput<"list_blocks">;
export type ModernBlock = V2ReadOutput<"get_block">;
export type ModernAccountEvents = V2ReadOutput<"list_account_events">;
export type ModernAccountStake = V2ReadOutput<"list_account_stake">;
export type ModernStakeAnchor = Pick<
  ModernAccountStake,
  "network" | "snapshot" | "stake" | "account_id"
>;
export type ModernStakeContinuation = { anchor: ModernStakeAnchor; cursor: string };
export const MODERN_STAKE_PAGE_SIZE = 10;
export type ModernAccountAnchor = Pick<
  ModernAccountEvents,
  "network" | "snapshot" | "coverage" | "revision" | "account_id"
>;
export type ModernAccountContinuation = { anchor: ModernAccountAnchor; cursor: string };
export type ModernBlockSummary = ModernBlockList["blocks"][number];
export type ModernBlockPins = Pick<ModernBlock["snapshot"], "block_hash" | "publication_id">;
export const MODERN_BLOCK_PAGE_SIZE = 25;
export const MODERN_EVENT_PAGE_SIZE = 25;
export const MODERN_ACCOUNT_MAX_PAGES = 8;

export function modernAccountKey(scope: ModernExplorerScope, accountId: string, restart: number) {
  return [...modernExplorerKey(scope, restart), "account-events", accountId] as const;
}

export function modernAccountPath(scope: ModernExplorerScope, accountId: string, cursor?: string) {
  const query = new URLSearchParams();
  if (cursor !== undefined) query.set("cursor", cursor);
  query.set("limit", String(MODERN_EVENT_PAGE_SIZE));
  return `/api/v2/networks/${scope.network}/accounts/${encodeURIComponent(accountId)}/events?${query}`;
}

export function modernAccountAnchor(page: ModernAccountEvents): ModernAccountAnchor {
  return {
    account_id: page.account_id,
    network: page.network,
    snapshot: page.snapshot,
    coverage: page.coverage,
    revision: page.revision,
  };
}

export async function readModernAccountEvents(
  reader: ModernExplorerReader,
  scope: ModernExplorerScope,
  accountId: string,
  continuation?: ModernAccountContinuation,
  signal?: AbortSignal,
): Promise<ModernAccountEvents> {
  if (
    continuation &&
    (continuation.anchor.account_id !== accountId ||
      continuation.anchor.network.id !== scope.network ||
      continuation.anchor.network.genesis_hash !== scope.genesis)
  )
    throw new V2ReadClientError("invalid_input");
  const page = await reader.read(
    "list_account_events",
    {
      network: scope.network,
      account_id: accountId,
      limit: MODERN_EVENT_PAGE_SIZE,
      ...(continuation ? { cursor: continuation.cursor } : {}),
    },
    { expectedGenesisHash: scope.genesis, signal },
  );
  if (
    continuation &&
    JSON.stringify(modernAccountAnchor(page)) !== JSON.stringify(continuation.anchor)
  )
    throw new V2ReadClientError("identity_mismatch");
  return page;
}

export function modernStakeKey(scope: ModernExplorerScope, accountId: string, restart: number) {
  return [...modernExplorerKey(scope, restart), "account-stake", accountId] as const;
}

export function modernStakePath(scope: ModernExplorerScope, accountId: string, cursor?: string) {
  const query = new URLSearchParams();
  if (cursor !== undefined) query.set("cursor", cursor);
  query.set("limit", String(MODERN_STAKE_PAGE_SIZE));
  return `/api/v2/networks/${scope.network}/accounts/${encodeURIComponent(accountId)}/stake?${query}`;
}

export function modernStakeAnchor(page: ModernAccountStake): ModernStakeAnchor {
  return {
    account_id: page.account_id,
    network: page.network,
    snapshot: page.snapshot,
    stake: page.stake,
  };
}

/** A continuation keeps its entire accepted publication, state and source identity. */
export async function readModernAccountStake(
  reader: ModernExplorerReader,
  scope: ModernExplorerScope,
  accountId: string,
  continuation?: ModernStakeContinuation,
  signal?: AbortSignal,
): Promise<ModernAccountStake> {
  if (
    continuation &&
    (continuation.anchor.account_id !== accountId ||
      continuation.anchor.network.id !== scope.network ||
      continuation.anchor.network.genesis_hash !== scope.genesis)
  )
    throw new V2ReadClientError("invalid_input");
  const page = await reader.read(
    "list_account_stake",
    {
      network: scope.network,
      account_id: accountId,
      limit: MODERN_STAKE_PAGE_SIZE,
      ...(continuation ? { cursor: continuation.cursor } : {}),
    },
    { expectedGenesisHash: scope.genesis, signal },
  );
  if (
    continuation &&
    JSON.stringify(modernStakeAnchor(page)) !== JSON.stringify(continuation.anchor)
  )
    throw new V2ReadClientError("identity_mismatch");
  return page;
}

/** Render beneath AppShell so its source provider owns the registration. */
export function ModernExplorerSources({ paths, origin }: { paths: string[]; origin: string }) {
  useRegisterApiSource(paths, [], origin);
  return null;
}

/** Preferences become authoritative only in the hydrated browser. */
export function useModernExplorerConfiguration(): ModernCatalogConfiguration | null {
  const hydrated = useHydrated();
  const [configuration, setConfiguration] = useState<ModernCatalogConfiguration | null>(null);
  useEffect(() => {
    if (!hydrated) return;
    const capture = () =>
      setConfiguration(modernCatalogConfiguration(getApiBase(), getNetwork().id));
    capture();
    const offOrigin = onApiBaseChange(capture);
    const offNetwork = onNetworkChange(capture);
    return () => {
      offOrigin();
      offNetwork();
    };
  }, [hydrated]);
  return configuration;
}

export function modernExplorerKey(scope: ModernExplorerScope, restart: number) {
  return [...modernCatalogKey(scope, restart), "explorer"] as const;
}

export function modernExplorerPath(
  scope: ModernExplorerScope,
  height?: string,
  pins: Record<string, string | number | undefined> = {},
) {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(pins))
    if (value !== undefined) query.set(name, String(value));
  const search = query.toString();
  return `/api/v2/networks/${scope.network}/blocks${height === undefined ? "" : `/${height}`}${search ? `?${search}` : ""}`;
}

export function modernBlockHref(block: ModernBlockSummary): string {
  const pins = new URLSearchParams({
    block_hash: block.snapshot.block_hash,
    publication_id: block.snapshot.publication_id,
  });
  return `/blocks/${block.snapshot.block_number}?${pins}`;
}

export function modernExplorerFailure(): Error {
  return new Error(
    "Published block evidence is unavailable. Retry this read or restart from the latest publication.",
  );
}

export function blockListInput(
  scope: ModernExplorerScope,
  first?: ModernBlockList,
  before?: string,
) {
  return {
    network: scope.network,
    limit: MODERN_BLOCK_PAGE_SIZE,
    ...(first
      ? {
          anchor_height: first.snapshot.block_number,
          anchor_hash: first.snapshot.block_hash,
          anchor_publication_id: first.snapshot.publication_id,
          from_block: first.coverage.from_block,
          before,
        }
      : {}),
  };
}

export async function readModernBlocks(
  reader: ModernExplorerReader,
  scope: ModernExplorerScope,
  first?: ModernBlockList,
  before?: string,
  signal?: AbortSignal,
): Promise<ModernBlockList> {
  if ((first === undefined) !== (before === undefined))
    throw new V2ReadClientError("invalid_input");
  const page = await reader.read("list_blocks", blockListInput(scope, first, before), {
    expectedGenesisHash: scope.genesis,
    signal,
  });
  if (
    first &&
    (JSON.stringify(page.snapshot) !== JSON.stringify(first.snapshot) ||
      JSON.stringify(page.coverage) !== JSON.stringify(first.coverage))
  )
    throw new V2ReadClientError("identity_mismatch");
  return page;
}

export function blockDetailInput(
  scope: ModernExplorerScope,
  height: string,
  pins?: ModernBlockPins,
  collection?: "events" | "extrinsics",
  after?: number,
) {
  return {
    network: scope.network,
    height,
    ...(pins ? { block_hash: pins.block_hash, publication_id: pins.publication_id } : {}),
    limit: MODERN_EVENT_PAGE_SIZE,
    extrinsic_limit: MODERN_BLOCK_PAGE_SIZE,
    ...(collection === "events" ? { after_event_index: after } : {}),
    ...(collection === "extrinsics" ? { after_extrinsic_index: after } : {}),
  };
}

/** Each collection continues independently under the accepted block identity. */
export async function readModernBlock(
  reader: ModernExplorerReader,
  scope: ModernExplorerScope,
  height: string,
  pins?: ModernBlockPins,
  first?: ModernBlock,
  collection?: "events" | "extrinsics",
  after?: number,
  signal?: AbortSignal,
): Promise<ModernBlock> {
  if (first && (!collection || after === undefined || !pins))
    throw new V2ReadClientError("invalid_input");
  const page = await reader.read(
    "get_block",
    blockDetailInput(scope, height, pins, collection, after),
    { expectedGenesisHash: scope.genesis, signal },
  );
  if (
    first &&
    (JSON.stringify(first.snapshot) !== JSON.stringify(page.snapshot) ||
      first.source_capture_digest !== page.source_capture_digest ||
      first.event_count !== page.event_count ||
      first.extrinsic_count !== page.extrinsic_count)
  )
    throw new V2ReadClientError("identity_mismatch");
  return page;
}

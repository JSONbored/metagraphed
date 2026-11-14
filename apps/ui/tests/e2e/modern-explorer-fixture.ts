import {
  modernAccountBalanceRow,
  modernAccountStakeRow,
} from "../../../../scripts/lib/modern-verification-fixture.ts";
import {
  accountStakeKey,
  compareAccountStakeKeys,
  decodeAccountStakeCursor,
  encodeAccountStakeCursor,
} from "../../../../src/v2/account-stake-cursor.ts";
import { V2AccountStakeSchema } from "../../../../schemas-src/v2/stake.ts";
import { V2AccountBalanceSchema } from "../../../../schemas-src/v2/balance.ts";
import type { V2ReadOutput } from "../../../../src/v2/client.ts";
import { MODERN_FINNEY_GENESIS as MODERN_CATALOG_GENESIS } from "../../src/lib/metagraphed/modern-catalog.ts";
import {
  decodeAccountEventCursor,
  encodeAccountEventCursor,
} from "../../../../src/v2/account-event-cursor.ts";

const hash = (height: number) => `0x${height.toString(16).padStart(64, "0")}`;
const digest = (height: number) => height.toString(16).padStart(64, "0");
export const MODERN_EXPLORER_HEIGHT = "9007199254740993";
export const MODERN_EXPLORER_PUBLICATION = digest(500);
export const MODERN_EXPLORER_HASH = hash(500);
export const MODERN_EXPLORER_PARTICIPANT =
  "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";
export const MODERN_EXPLORER_ACCOUNT = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const top = BigInt(MODERN_EXPLORER_HEIGHT);
const snapshot = (offset: number) => ({
  block_number: String(top - BigInt(offset)),
  block_hash: hash(500 - offset),
  parent_hash: hash(499 - offset),
  metadata_digest: digest(900),
  spec_version: 488,
  transaction_version: 1,
  producer_revision: "d".repeat(40),
  publication_id: digest(500 - offset),
  observed_at: "2026-11-06T14:00:00.000Z",
  published_at: "2026-11-06T14:00:01.000Z",
});
const envelope = {
  api_version: "2",
  network: { id: "finney", genesis_hash: MODERN_CATALOG_GENESIS },
  snapshot: snapshot(0),
  freshness: {
    status: "stale",
    age_seconds: 3600,
    finalized_lag_blocks: "300",
    target_seconds: 30,
    target_blocks: 2,
  },
} as const;
const events: V2ReadOutput<"get_block">["events"] = Array.from(
  { length: 27 },
  (_, event_index) => ({
    event_index,
    pallet: "Balances",
    variant: "Transfer",
    fields: { amount_rao: "18446744073709551615" },
    phase: "ApplyExtrinsic",
    extrinsic_index: event_index,
    topics: [hash(800 + event_index)],
    participants: [
      { participant_index: 0, account_id: MODERN_EXPLORER_PARTICIPANT, role: "field_0" },
      {
        participant_index: 1,
        account_id: "0xd4b3efa00c7f20e8e94f39d1bed97ce0cacceb122a09a9ca24dfda401710391b",
        role: "field_1",
      },
      { participant_index: 2, account_id: MODERN_EXPLORER_PARTICIPANT, role: "field_2" },
    ],
  }),
);
const extrinsics: V2ReadOutput<"get_block">["extrinsics"] = Array.from(
  { length: 27 },
  (_, extrinsic_index) => ({
    extrinsic_index,
    extrinsic_hash: hash(600 + extrinsic_index),
    pallet: "Balances",
    call: "transfer_keep_alive",
    fields: { amount_rao: "18446744073709551615" },
    is_signed: true,
    signer: { account_id: MODERN_EXPLORER_PARTICIPANT },
  }),
);

/** Controlled display specimen; exact account observations are not a stake valuation. */
export function modernBalanceFixture(
  accountId: string,
  status: "stored" | "not_stored" = "stored",
): V2ReadOutput<"get_account_balance"> {
  const row = modernAccountBalanceRow(accountId);
  const runtimeDefault = {
    ...row.result.account,
    nonce: "0",
    consumers: "0",
    providers: "0",
    sufficients: "0",
    free_rao: "0",
    reserved_rao: "0",
    frozen_rao: "0",
  };
  return V2AccountBalanceSchema.parse({
    api_version: "2",
    account_id: accountId,
    network: row.network,
    snapshot: row.snapshot,
    balance: row.balance,
    result:
      status === "stored" ? row.result : { status: "not_stored", runtime_default: runtimeDefault },
    freshness: envelope.freshness,
  });
}

/** Controlled display specimens, never an oracle for producer arithmetic or custody. */
export function modernStakeFixture(
  accountId: string,
  cursor?: string,
  limit = 10,
  positionCount = 14,
): V2ReadOutput<"list_account_stake"> {
  if (!Number.isInteger(positionCount) || positionCount < 2 || positionCount > 100)
    throw new Error("Controlled stake specimen bounds");
  const protocolCustody =
    accountId === "0x6d6f646c73756274656e7372626574612f657363000000000000000000000000";
  const row = modernAccountStakeRow(protocolCustody ? `0x${"b".repeat(64)}` : accountId);
  if (protocolCustody)
    for (const entry of row.entries)
      if (entry.kind === "root_entitlement") {
        entry.entitlement.key.coldkey = accountId;
        entry.entitlement.outcome = { status: "protocol_custody" };
      }
  row.network.genesis_hash = MODERN_CATALOG_GENESIS;
  for (const entry of row.entries)
    if (entry.kind === "position") entry.position.asset.genesis_hash = MODERN_CATALOG_GENESIS;
  const initial = row.entries.find((entry) => entry.kind === "position");
  if (initial?.kind === "position") {
    for (let i = 2; i < positionCount; i++) {
      const copy = structuredClone(initial);
      copy.position.hotkey = hash(i);
      copy.position.quote = {
        status: "exact",
        basis: { kind: "root_tao" },
        atomic_units: "18446744073709551615",
      };
      copy.position.observations.pool_balance = {
        status: "stored",
        scale_hex: "0xffffffffffffffff",
      };
      row.entries.push(copy);
    }
  }
  row.entries.sort((a, b) => compareAccountStakeKeys(accountStakeKey(a), accountStakeKey(b)));
  const after = cursor === undefined ? undefined : decodeAccountStakeCursor(cursor);
  if (
    after &&
    (after.account_id !== accountId ||
      after.network !== "finney" ||
      after.genesis_hash !== MODERN_CATALOG_GENESIS ||
      after.publication_id !== row.stake.publication_id)
  )
    throw new Error("Controlled stake cursor differs");
  const eligible = after
    ? row.entries.filter((entry) => compareAccountStakeKeys(accountStakeKey(entry), after) > 0)
    : row.entries;
  const entries = eligible.slice(0, limit);
  const last = entries.at(-1);
  return V2AccountStakeSchema.parse({
    api_version: "2",
    network: row.network,
    snapshot: row.snapshot,
    stake: { ...row.stake, member_count: "100", claimant_count: "200" },
    account_id: accountId,
    entries,
    freshness: {
      status: "stale",
      age_seconds: 3600,
      finalized_lag_blocks: "300",
      target_seconds: 3600,
      target_blocks: null,
    },
    next_cursor:
      eligible.length > limit && last
        ? encodeAccountStakeCursor({
            version: 1,
            network: "finney",
            genesis_hash: MODERN_CATALOG_GENESIS,
            account_id: accountId,
            publication_id: row.stake.publication_id,
            ...accountStakeKey(last),
          })
        : null,
  });
}

/** Closed, bounded responses for the native browser journey; never calls a provider. */
export function modernExplorerFixture(url: URL, method = "GET") {
  const accountRoute = /^\/api\/v2\/networks\/[^/]+\/accounts\/([^/]+)\/events$/.exec(url.pathname);
  const stakeRoute = /^\/api\/v2\/networks\/[^/]+\/accounts\/([^/]+)\/stake$/.exec(url.pathname);
  const balanceRoute = /^\/api\/v2\/networks\/[^/]+\/accounts\/([^/]+)\/balance$/.exec(
    url.pathname,
  );
  if (
    !accountRoute &&
    !stakeRoute &&
    !balanceRoute &&
    !/^\/api\/v2\/networks\/[^/]+\/blocks(?:\/[^/]+)?$/.test(url.pathname)
  )
    return null;
  const response = (value: unknown, status = 200) => ({
    status,
    contentType: "application/json",
    body: JSON.stringify(value),
  });
  const refuse = (code: "invalid_input" | "not_found" | "data_unavailable", status: number) =>
    response(
      { api_version: "2", error: { code, message: "Controlled block evidence unavailable" } },
      status,
    );
  if (method !== "GET" || !url.pathname.startsWith("/api/v2/networks/finney/"))
    return refuse("not_found", 404);
  if (balanceRoute) {
    if (!/^0x[0-9a-f]{64}$/.test(balanceRoute[1])) return refuse("invalid_input", 400);
    for (const key of url.searchParams.keys())
      if (key !== "publication_id" || url.searchParams.getAll(key).length !== 1)
        return refuse("invalid_input", 400);
    const selected = url.searchParams.get("publication_id");
    if (selected !== null && !/^[0-9a-f]{64}$/.test(selected)) return refuse("invalid_input", 400);
    const value = modernBalanceFixture(balanceRoute[1]);
    if (selected !== null && selected !== value.balance.publication_id)
      return refuse("data_unavailable", 503);
    return response(value);
  }
  const limit = Number(url.searchParams.get("limit") ?? (stakeRoute ? 10 : 25));
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) return refuse("invalid_input", 400);
  if (stakeRoute) {
    if (!/^0x[0-9a-f]{64}$/.test(stakeRoute[1]) || limit > 10) return refuse("invalid_input", 400);
    for (const key of url.searchParams.keys())
      if (
        !["limit", "cursor", "publication_id"].includes(key) ||
        url.searchParams.getAll(key).length !== 1
      )
        return refuse("invalid_input", 400);
    const selected = url.searchParams.get("publication_id");
    if (selected !== null && selected !== "e".repeat(64)) return refuse("data_unavailable", 503);
    try {
      return response(
        modernStakeFixture(stakeRoute[1], url.searchParams.get("cursor") ?? undefined, limit),
      );
    } catch {
      return refuse("invalid_input", 400);
    }
  }
  if (accountRoute) {
    const accountId = accountRoute[1];
    if (!/^0x[0-9a-f]{64}$/.test(accountId) || limit > 100) return refuse("invalid_input", 400);
    for (const key of url.searchParams.keys())
      if (!["limit", "cursor"].includes(key) || url.searchParams.getAll(key).length !== 1)
        return refuse("invalid_input", 400);
    const revision = { generation: "5", publication_id: MODERN_EXPLORER_PUBLICATION };
    const from = String(top - 29n);
    let before: { height: bigint; index: number } | undefined;
    if (url.searchParams.has("cursor")) {
      try {
        const cursor = decodeAccountEventCursor(url.searchParams.get("cursor")!);
        if (
          cursor.network !== "finney" ||
          cursor.account_id !== accountId ||
          cursor.genesis_hash !== MODERN_CATALOG_GENESIS
        )
          return refuse("invalid_input", 400);
        if (
          cursor.from_block !== from ||
          cursor.anchor_height !== MODERN_EXPLORER_HEIGHT ||
          cursor.anchor_hash !== MODERN_EXPLORER_HASH ||
          cursor.anchor_publication_id !== MODERN_EXPLORER_PUBLICATION ||
          cursor.revision_generation !== revision.generation ||
          cursor.revision_publication_id !== revision.publication_id
        )
          return refuse("data_unavailable", 503);
        before = { height: BigInt(cursor.before_block), index: cursor.before_event_index };
      } catch {
        return refuse("invalid_input", 400);
      }
    }
    const matching = events.filter((event) =>
      event.participants.some((p) => p.account_id === accountId),
    );
    const rows: V2ReadOutput<"list_account_events">["events"] = [];
    for (let offset = 0; offset < 30; offset++)
      for (const event of [...matching].reverse()) {
        const selected = snapshot(offset);
        const height = BigInt(selected.block_number);
        if (
          before &&
          (height > before.height ||
            (height === before.height && event.event_index >= before.index))
        )
          continue;
        rows.push({
          snapshot: selected,
          source_capture_digest: digest(1000 + offset),
          event_count: events.length,
          extrinsic_count: extrinsics.length,
          event,
          matching_participants: event.participants.filter((p) => p.account_id === accountId),
        });
      }
    const selected = rows.slice(0, limit);
    const last = selected.at(-1);
    return response({
      ...envelope,
      account_id: accountId,
      coverage: { from_block: from, through_block: MODERN_EXPLORER_HEIGHT, contiguous: true },
      revision,
      events: selected,
      next_cursor:
        rows.length > limit && last
          ? encodeAccountEventCursor({
              version: 1,
              network: "finney",
              genesis_hash: MODERN_CATALOG_GENESIS,
              account_id: accountId,
              from_block: from,
              anchor_height: MODERN_EXPLORER_HEIGHT,
              anchor_hash: MODERN_EXPLORER_HASH,
              anchor_publication_id: MODERN_EXPLORER_PUBLICATION,
              revision_generation: revision.generation,
              revision_publication_id: revision.publication_id,
              before_block: last.snapshot.block_number,
              before_event_index: last.event.event_index,
            })
          : null,
    } satisfies V2ReadOutput<"list_account_events">);
  }
  if (url.pathname.endsWith("/blocks")) {
    const before = url.searchParams.get("before");
    const anchored = ["anchor_height", "anchor_hash", "anchor_publication_id", "from_block"].some(
      (key) => url.searchParams.has(key),
    );
    if (before || anchored) {
      if (
        url.searchParams.get("anchor_height") !== MODERN_EXPLORER_HEIGHT ||
        url.searchParams.get("anchor_hash") !== MODERN_EXPLORER_HASH ||
        url.searchParams.get("anchor_publication_id") !== MODERN_EXPLORER_PUBLICATION ||
        url.searchParams.get("from_block") !== String(top - 29n)
      )
        return refuse("data_unavailable", 503);
    }
    if (before && !/^[0-9]+$/.test(before)) return refuse("invalid_input", 400);
    const start = before === null ? 0 : Number(top - BigInt(before) + 1n);
    if (start < 0 || start > 29 || limit > 100) return refuse("invalid_input", 400);
    const blocks = Array.from({ length: Math.min(limit, 30 - start) }, (_, index) => ({
      snapshot: snapshot(start + index),
      source_capture_digest: digest(1000 + start + index),
      event_count: 27,
      extrinsic_count: 27,
    }));
    return response({
      ...envelope,
      coverage: {
        from_block: String(top - 29n),
        through_block: MODERN_EXPLORER_HEIGHT,
        contiguous: true,
      },
      blocks,
      next_before: start + blocks.length < 30 ? blocks.at(-1)!.snapshot.block_number : null,
    } satisfies V2ReadOutput<"list_blocks">);
  }
  const height = url.pathname.split("/").at(-1)!;
  if (!/^[0-9]+$/.test(height)) return refuse("invalid_input", 400);
  const offset = Number(top - BigInt(height));
  if (offset < 0 || offset > 29) return refuse("not_found", 404);
  const selected = snapshot(offset);
  const blockHash = url.searchParams.get("block_hash");
  const publication = url.searchParams.get("publication_id");
  if ((blockHash === null) !== (publication === null)) return refuse("invalid_input", 400);
  if (blockHash && (blockHash !== selected.block_hash || publication !== selected.publication_id))
    return refuse("data_unavailable", 503);
  const eventAfter = Number(url.searchParams.get("after_event_index") ?? -1);
  const extrinsicAfter = Number(url.searchParams.get("after_extrinsic_index") ?? -1);
  const extrinsicLimit = Number(url.searchParams.get("extrinsic_limit") ?? 25);
  if (
    ![eventAfter, extrinsicAfter, extrinsicLimit].every(Number.isInteger) ||
    eventAfter < -1 ||
    extrinsicAfter < -1 ||
    extrinsicLimit < 1 ||
    extrinsicLimit > 100 ||
    ((eventAfter >= 0 || extrinsicAfter >= 0) && !publication)
  )
    return refuse("invalid_input", 400);
  const eventPage = events.slice(eventAfter + 1, eventAfter + 1 + limit);
  const extrinsicPage = extrinsics.slice(extrinsicAfter + 1, extrinsicAfter + 1 + extrinsicLimit);
  return response({
    ...envelope,
    snapshot: selected,
    source_capture_digest: digest(1000 + offset),
    event_count: events.length,
    extrinsic_count: extrinsics.length,
    events: eventPage,
    extrinsics: extrinsicPage,
    next_event_index:
      eventAfter + 1 + eventPage.length < events.length ? eventPage.at(-1)!.event_index : null,
    next_extrinsic_index:
      extrinsicAfter + 1 + extrinsicPage.length < extrinsics.length
        ? extrinsicPage.at(-1)!.extrinsic_index
        : null,
  } satisfies V2ReadOutput<"get_block">);
}

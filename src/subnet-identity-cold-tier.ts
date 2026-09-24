import type { ArtifactStoreEnv } from "./projection-store.ts";
import { readStateArchiveRows } from "./state-archive-read.ts";
// Subnet identity timelines retain their original archived row IDs and ordering.

import { decodeCursor, encodeCursor } from "./cursor.ts";
import { safeBlockNumber } from "./r2-sql.ts";
import { buildSubnetIdentityHistory } from "./subnet-identity-history.ts";
import {
  buildChainIdentityHistory,
  CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT,
  CHAIN_IDENTITY_HISTORY_LIMIT_MAX,
} from "./chain-identity-history.ts";
import type { R2SqlEnv } from "./r2-sql.ts";

/** The (observed_at, id) pair the per-subnet timeline pages on. */
const CURSOR_ARITY = 2;

/**
 * One subnet's identity-change timeline, newest first. Returns null when the
 * lakehouse cannot answer, so the caller keeps its schema-stable empty.
 */
export async function loadSubnetIdentityHistoryColdTier(
  env: (R2SqlEnv & ArtifactStoreEnv) | null | undefined,
  netuid: unknown,
  query: { limit: number; offset?: number | null; cursor?: unknown },
): Promise<ReturnType<typeof buildSubnetIdentityHistory> | null> {
  // Reject invalid pagination inputs before reading retained history.
  const n = safeBlockNumber(netuid);
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (n === null || limit === null || offset === null || limit <= 0)
    return null;
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);
  // Cursor pages never carry an offset, mirroring data-api.
  const paged = cursor ? 0 : offset;

  const archive = await readStateArchiveRows(env, "subnet_identity_history");
  if (archive == null) return null;
  const page = archive
    .filter(
      (row) =>
        Number(row.netuid) === n &&
        (!cursor ||
          Number(row.observed_at) < cursor[0] ||
          (Number(row.observed_at) === cursor[0] &&
            Number(row.id) < cursor[1])),
    )
    .sort(
      (a, b) =>
        Number(b.observed_at) - Number(a.observed_at) ||
        Number(b.id) - Number(a.id),
    )
    .slice(paged, paged + limit);

  const last = page.length === limit ? page[page.length - 1] : null;
  // The SAME token the Postgres tier emits for this row, so paging survives a
  // tier transition in either direction.
  const nextCursor = last
    ? encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.id),
      ])
    : null;
  return buildSubnetIdentityHistory(page, n, { limit, offset, nextCursor });
}

/**
 * The network-wide identity-change feed: every subnet's rows, most recent
 * first, capped. No cursor and no offset -- the route has neither, matching
 * data-api's own single-shot LIMIT query.
 */
export async function loadChainIdentityHistoryColdTier(
  env: (R2SqlEnv & ArtifactStoreEnv) | null | undefined,
  query: { limit?: unknown } = {},
): Promise<ReturnType<typeof buildChainIdentityHistory> | null> {
  // An absent limit takes the route default, exactly as data-api resolves it.
  // A present-but-unusable or out-of-range one DECLINES rather than being
  // clamped: the handler has already 400'd anything invalid, so a bad value
  // here is a direct caller this tier must not silently reinterpret.
  const cap =
    query.limit == null
      ? CHAIN_IDENTITY_HISTORY_LIMIT_DEFAULT
      : safeBlockNumber(query.limit);
  if (cap === null || cap <= 0 || cap > CHAIN_IDENTITY_HISTORY_LIMIT_MAX)
    return null;

  const archive = await readStateArchiveRows(env, "subnet_identity_history");
  if (archive == null) return null;
  const page = archive
    .sort(
      (a, b) =>
        Number(b.block_number) - Number(a.block_number) ||
        Number(a.netuid) - Number(b.netuid) ||
        Number(b.id) - Number(a.id),
    )
    .slice(0, cap);
  return buildChainIdentityHistory(page, { limit: cap });
}

import type { ArtifactStoreEnv } from "./projection-store.ts";
import { readStateArchiveRows } from "./state-archive-read.ts";
import { readD1Metadata } from "./d1-metadata-read.ts";
// D1 owns current identities; verified immutable R2 archives own their history.

import { buildAccountIdentity, IDENTITY_FIELDS } from "./account-identity.ts";
import { buildAccountIdentityHistory } from "./account-identity-history.ts";
import type { AccountIdentityRow } from "../generated/lakehouse/types.ts";
import { decodeCursor, encodeCursor } from "./cursor.ts";
import { safeBlockNumber, safeSs58Literal } from "./history-readers.ts";
import type { HistoryReadEnv } from "./history-readers.ts";

// Derive the current-state columns from the canonical identity field set.
const LATEST_COLUMNS = `account, ${IDENTITY_FIELDS.join(", ")}, captured_at`;

/** The (observed_at, id) pair the history feed pages on, mirroring data-api. */
const CURSOR_ARITY = 2;

/**
 * One account's latest-only identity. Returns null when the lakehouse cannot
 * answer, so the caller keeps its schema-stable "no identity" fallback.
 */
export async function loadAccountIdentityColdTier(
  env: (HistoryReadEnv & ArtifactStoreEnv) | null | undefined,
  ss58: string,
): Promise<ReturnType<typeof buildAccountIdentity> | null> {
  // Validate the account before reading its bound D1 row.
  const addr = safeSs58Literal(ss58);
  if (addr === null) return null;
  // TYPED, because the SELECT list IS the generated row. `LATEST_COLUMNS` is
  // `account` + the seven identity fields + `captured_at`, which is every column
  // `AccountIdentityRow` declares -- so naming it here is a restatement of what
  // the catalog already says rather than a guess about it.
  const rows = await readD1Metadata<AccountIdentityRow>(
    env,
    "account_identity",
    `SELECT ${LATEST_COLUMNS} FROM account_identity WHERE account = ?`,
    [addr],
  );
  if (rows == null) return null;
  // A confirmed absence is an ANSWER: has_identity:false is the same payload
  // the Postgres tier produces for the (common) never-set-identity case.
  return buildAccountIdentity(rows[0] ?? null, ss58);
}

/**
 * One account's identity-change timeline, newest first -- data-api's exact
 * order, columns, cursor token, and OFFSET-only-without-cursor rule.
 */
export async function loadAccountIdentityHistoryColdTier(
  env: (HistoryReadEnv & ArtifactStoreEnv) | null | undefined,
  ss58: string,
  query: { limit: number; offset?: number | null; cursor?: unknown },
): Promise<ReturnType<typeof buildAccountIdentityHistory> | null> {
  const addr = safeSs58Literal(ss58);
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (addr === null || limit === null || offset === null || limit <= 0)
    return null;
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);
  // Cursor pages never carry an offset, mirroring data-api.
  const paged = cursor ? 0 : offset;

  const archived = await readStateArchiveRows(env, "account_identity_history");
  if (archived == null) return null;
  const page = archived
    .filter(
      (row) =>
        row.account === addr &&
        (!cursor ||
          Number(row.observed_at) < Number(cursor[0]) ||
          (row.observed_at === cursor[0] &&
            Number(row.id) < Number(cursor[1]))),
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
  return buildAccountIdentityHistory(page, ss58, { limit, offset, nextCursor });
}

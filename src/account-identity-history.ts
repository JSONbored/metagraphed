// Personal (coldkey) chain identity history diff-tracking (#4326, epic
// #4301/5.2): detect account_identity changes against the last recorded hash
// per account. The append-only write itself lives entirely in Postgres now
// (workers/data-api.mjs's handleAccountIdentitySync does its own diff-and-
// append against Postgres's account_identity_history directly) -- this
// file's own D1-side diff-and-append (recordAccountIdentityChanges) never had
// a production caller (only ever invoked via loadStagedAccountIdentity, which
// was removed in the D1→Postgres cutover #4772 — see workers/api.mjs's
// staged-loader note) and was retired outright (2026-07-16, D1 fully
// eliminated from this module) rather than ported, mirroring src/subnet-
// hyperparams-history.mjs's own recordSubnetHyperparamsChanges retirement.
//
// Read/format/build functions land here with the serving route (#4328/5.4),
// mirroring src/subnet-identity-history.ts's read side exactly (keyed by
// account instead of netuid, and with no block_number column — account_identity
// carries no chain block height, only captured_at).

import {
  IDENTITY_FIELDS,
  sanitizeAccountIdentityFields,
} from "./account-identity.ts";
import { encodeCursor, decodeCursor } from "./cursor.ts";
import {
  clampLimit,
  clampOffset,
  FEED_PAGINATION,
} from "../workers/request-params.ts";

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

async function sha256Hex(text: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(text)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Hash of the tracked identity fields only — stable regardless of the row's
 * account/captured_at, which change independently of the identity itself. */
export async function identityHash(snapshot: unknown): Promise<string | null> {
  if (!snapshot) return null;
  return sha256Hex(stableStringify(snapshot));
}

const READ_COLUMNS = [
  "id",
  "observed_at",
  ...IDENTITY_FIELDS,
  "identity_hash",
].join(", ");

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export interface AccountIdentityHistoryEntry {
  observed_at: string | null;
  identity_hash: unknown;
  [key: string]: unknown;
}

export function formatAccountIdentityHistoryEntry(
  row: Record<string, unknown> | null | undefined,
): AccountIdentityHistoryEntry | null {
  if (!row || typeof row !== "object") return null;
  const sanitized = sanitizeAccountIdentityFields(row) ?? {};
  const entry: AccountIdentityHistoryEntry = {
    observed_at: toIso(row.observed_at),
    identity_hash: null,
  };
  for (const field of IDENTITY_FIELDS) entry[field] = sanitized[field] ?? null;
  entry.identity_hash = row.identity_hash ?? null;
  return entry;
}

export interface AccountIdentityHistoryResult {
  schema_version: 1;
  account: string;
  entry_count: number;
  limit: number | null;
  offset: number | null;
  next_cursor: string | null;
  entries: AccountIdentityHistoryEntry[];
}

export function buildAccountIdentityHistory(
  rows: Array<Record<string, unknown>> | null | undefined,
  account: string,
  {
    limit,
    offset,
    nextCursor,
  }: {
    limit?: number | null;
    offset?: number | null;
    nextCursor?: string | null;
  } = {},
): AccountIdentityHistoryResult {
  const entries = (rows || [])
    .map(formatAccountIdentityHistoryEntry)
    .filter((entry): entry is AccountIdentityHistoryEntry => Boolean(entry));
  return {
    schema_version: 1,
    account,
    entry_count: entries.length,
    limit: limit ?? null,
    offset: offset ?? null,
    next_cursor: nextCursor ?? null,
    entries,
  };
}

export async function loadAccountIdentityHistory(
  d1: (
    sql: string,
    params: unknown[],
  ) => Promise<Array<Record<string, unknown>>>,
  account: string,
  {
    limit,
    offset,
    cursor,
  }: {
    limit?: number | string | null;
    offset?: number | string | null;
    cursor?: unknown;
  } = {},
): Promise<AccountIdentityHistoryResult> {
  const lim = clampLimit(limit, FEED_PAGINATION);
  const off = clampOffset(offset);
  const cur = decodeCursor(cursor, 2);
  const useCursor = Boolean(cur);
  const params: unknown[] = [account];
  let sql = `SELECT ${READ_COLUMNS} FROM account_identity_history WHERE account = ?`;
  if (useCursor && cur) {
    sql += " AND (observed_at, id) < (?, ?)";
    params.push(cur[0], cur[1]);
  }
  sql += " ORDER BY observed_at DESC, id DESC LIMIT ?";
  params.push(lim);
  if (!useCursor) {
    sql += " OFFSET ?";
    params.push(off);
  }
  const rows = await d1(sql, params);
  const last = rows.length === lim ? rows[rows.length - 1] : null;
  const nextCursor =
    last && Number.isFinite(Number(last.observed_at))
      ? encodeCursor([Number(last.observed_at), Number(last.id)])
      : null;
  return buildAccountIdentityHistory(rows, account, {
    limit: lim,
    offset: off,
    nextCursor,
  });
}

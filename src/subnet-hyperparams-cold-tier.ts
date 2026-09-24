import type { ArtifactStoreEnv } from "./projection-store.ts";
import { readStateArchiveRows } from "./state-archive-read.ts";
import { readD1Metadata } from "./d1-metadata-read.ts";
// Subnet hyperparameter readers prefer the current D1 owner, preserving the
// canonical parameter format, nullable values, filters, and timeline cursor.

import { decodeCursor, encodeCursor } from "./cursor.ts";
import { safeBlockNumber } from "./r2-sql.ts";
import {
  buildSubnetHyperparams,
  SUBNET_HYPERPARAMS_INSERT_COLUMNS,
} from "./subnet-hyperparams.ts";
import { buildSubnetHyperparamsHistory } from "./subnet-hyperparams-history.ts";
import type { R2SqlEnv } from "./r2-sql.ts";

// Keep the current-state read aligned with the canonical write columns.
const LATEST_COLUMNS = SUBNET_HYPERPARAMS_INSERT_COLUMNS.slice(1).join(", ");

/** The (observed_at, id) pair the history feed pages on, mirroring data-api. */
const CURSOR_ARITY = 2;

/**
 * One subnet's latest hyperparameters. Returns null when the lakehouse cannot
 * answer, so the caller keeps its existing schema-stable fallback.
 */
export async function loadSubnetHyperparamsColdTier(
  env: (R2SqlEnv & ArtifactStoreEnv) | null | undefined,
  netuid: unknown,
): Promise<ReturnType<typeof buildSubnetHyperparams> | null> {
  // Keep the published integer-input contract before issuing a bound read.
  const n = safeBlockNumber(netuid);
  if (n === null) return null;
  const rows = await readD1Metadata(
    env,
    "subnet_hyperparams",
    `SELECT ${LATEST_COLUMNS} FROM subnet_hyperparams WHERE netuid = ? LIMIT 1`,
    [n],
  );
  if (rows == null) return null;
  // A confirmed absence is an ANSWER: hyperparameters:null is the same payload
  // the Postgres tier produces for an unknown netuid, not a tier failure.
  return buildSubnetHyperparams(rows[0] ?? null, n);
}

/**
 * One subnet's hyperparameter-change timeline, newest first -- data-api's
 * exact order, columns, cursor token, and OFFSET-only-without-cursor rule.
 */
export async function loadSubnetHyperparamsHistoryColdTier(
  env: (R2SqlEnv & ArtifactStoreEnv) | null | undefined,
  netuid: unknown,
  query: { limit: number; offset?: number | null; cursor?: unknown },
): Promise<ReturnType<typeof buildSubnetHyperparamsHistory> | null> {
  const n = safeBlockNumber(netuid);
  const limit = safeBlockNumber(query.limit);
  const offset = safeBlockNumber(query.offset ?? 0);
  if (n === null || limit === null || offset === null || limit <= 0)
    return null;
  const cursor = decodeCursor(query.cursor, CURSOR_ARITY);
  // Cursor pages never carry an offset (the cursor already narrows past prior
  // pages), mirroring data-api's `OFFSET only when no cursor`.
  const paged = cursor ? 0 : offset;

  const archived = await readStateArchiveRows(
    env,
    "subnet_hyperparams_history",
  );
  if (archived == null) return null;
  const page = archived
    .filter(
      (row) =>
        row.netuid === n &&
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
  // The SAME token the Postgres tier emits for this row, so a client can page
  // seamlessly across a tier transition in either direction.
  const nextCursor = last
    ? encodeCursor([
        safeBlockNumber(last.observed_at),
        safeBlockNumber(last.id),
      ])
    : null;
  return buildSubnetHyperparamsHistory(page, n, { limit, offset, nextCursor });
}

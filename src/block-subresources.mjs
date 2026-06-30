// Per-block sub-resources (#1845 extrinsics, #1852 events): shared D1 loaders for
// REST handlers and MCP block-explorer tools. Ref is a numeric block_number or 0x
// block_hash; unknown/cold refs return schema-stable null block_number + empty lists.

import { ACCOUNT_EVENT_COLUMNS, buildBlockEvents } from "./account-events.mjs";
import { buildBlockExtrinsics, EXTRINSIC_READ_COLUMNS } from "./extrinsics.mjs";
import {
  BLOCK_PAGINATION,
  clampLimit,
  clampOffset,
  FEED_PAGINATION,
} from "../workers/request-params.mjs";

function strictBlockNumber(ref) {
  if (!/^\d+$/.test(String(ref))) return null;
  const value = Number(ref);
  return Number.isSafeInteger(value) ? value : null;
}

export async function resolveBlockNumber(d1, ref) {
  const isHash = /^0x[0-9a-fA-F]{64}$/.test(String(ref));
  const refBlockNumber = isHash ? null : strictBlockNumber(ref);
  if (!isHash && refBlockNumber === null) return null;
  const rows = await d1(
    isHash
      ? `SELECT block_number FROM blocks WHERE block_hash = ? LIMIT 1`
      : `SELECT block_number FROM blocks WHERE block_number = ? LIMIT 1`,
    [isHash ? String(ref).toLowerCase() : refBlockNumber],
  );
  return rows[0]?.block_number ?? null;
}

export async function loadBlockExtrinsics(d1, ref, { limit, offset } = {}) {
  const lim = clampLimit(limit, BLOCK_PAGINATION);
  const off = clampOffset(offset);
  const blockNumber = await resolveBlockNumber(d1, ref);
  const rows =
    blockNumber == null
      ? []
      : await d1(
          `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics WHERE block_number = ? ORDER BY extrinsic_index ASC LIMIT ? OFFSET ?`,
          [blockNumber, lim, off],
        );
  const data = buildBlockExtrinsics(rows, ref, blockNumber, {
    limit: lim,
    offset: off,
  });
  return { data, rows, blockNumber };
}

export async function loadBlockEvents(d1, ref, { limit, offset } = {}) {
  const lim = clampLimit(limit, FEED_PAGINATION);
  const off = clampOffset(offset);
  const blockNumber = await resolveBlockNumber(d1, ref);
  const rows =
    blockNumber == null
      ? []
      : await d1(
          `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events WHERE block_number = ? ORDER BY event_index ASC LIMIT ? OFFSET ?`,
          [blockNumber, lim, off],
        );
  const data = buildBlockEvents(rows, ref, blockNumber, {
    limit: lim,
    offset: off,
  });
  return { data, rows, blockNumber };
}

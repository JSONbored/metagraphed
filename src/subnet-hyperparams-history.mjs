// Historical hyperparameter change tracking (#4309, epic #4301): detect
// subnet_hyperparams changes against the last recorded hash per netuid and
// store append-only rows, served as a paginated per-subnet timeline.
// Forward-only for now — a full backfill needs archive-node state_call at
// past block heights (#2111). Reuses subnet-hyperparams.mjs's field mapping
// (formatSubnetHyperparams) rather than re-deriving it, since a history
// entry's hyperparameters are the same 33-field shape as the latest-only
// route already formats.
//
// The write path itself (diff-against-last-hash-and-append) lives in
// workers/data-api.mjs's handleSubnetHyperparamsSync (Postgres) — this file
// owns only the tier-agnostic pieces both that write path and the read route
// share: the shaping (formatHyperparamsHistoryEntry/
// buildSubnetHyperparamsHistory) and the hash (hyperparamsHash) both hash
// against, so history rows stay hash-identical no matter which tier wrote
// them. D1's own diff-and-append (recordSubnetHyperparamsChanges) and
// paginated read (loadSubnetHyperparamsHistory) are retired alongside D1's
// subnet_hyperparams write path — see workers/api.mjs's staged-loader
// retirement note (#4772) and workers/request-handlers/entities.mjs's
// handleSubnetHyperparamsHistory.

import { formatSubnetHyperparams } from "./subnet-hyperparams.mjs";

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(String(text)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Hash of the formatted (type-coerced) hyperparameters object — stable
 * regardless of the raw staged row's string-vs-number/0-1-vs-boolean shape. */
export async function hyperparamsHash(hyperparameters) {
  if (!hyperparameters) return null;
  return sha256Hex(stableStringify(hyperparameters));
}

function toBlockNumber(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function toIso(ms) {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function formatHyperparamsHistoryEntry(row) {
  if (!row || typeof row !== "object") return null;
  return {
    block_number: toBlockNumber(row.block_number),
    observed_at: toIso(row.observed_at),
    hyperparameters: formatSubnetHyperparams(row),
    hyperparams_hash: row.hyperparams_hash ?? null,
  };
}

export function buildSubnetHyperparamsHistory(
  rows,
  netuid,
  { limit, offset, nextCursor } = {},
) {
  const entries = (rows || [])
    .map(formatHyperparamsHistoryEntry)
    .filter(Boolean);
  return {
    schema_version: 1,
    netuid,
    entry_count: entries.length,
    limit: limit ?? null,
    offset: offset ?? null,
    next_cursor: nextCursor ?? null,
    entries,
  };
}

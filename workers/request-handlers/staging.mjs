// Staged-artifact loaders: the */3 fast-load cron path that drains HMAC-signed R2
// batches into D1 (extracted from workers/api.mjs per #1763).
//
// This module co-locates the four `loadStaged*` loaders (neurons, events, blocks,
// extrinsics) with the signing/validation machinery they alone use — the staged
// R2 keys, the per-tier byte/row caps, the HMAC envelope helpers, and the staged
// row/coverage validators. They form one trust contract: every loader reads an
// HMAC-signed envelope from `env.METAGRAPH_ARCHIVE`, re-derives the signature with
// `env.METAGRAPH_STAGING_SIGNING_KEY`, and only then loads bounded, schema-valid
// rows into `env.METAGRAPH_HEALTH_DB` with parameterized INSERTs. Keeping the
// signers and their callers in one file makes the "verify before load, delete
// after success" invariant reviewable in a single place.
//
// Every dependency is a leaf module (config caps + the per-tier row validators and
// INSERT builders from src/*), so this file never imports api.mjs — no injected
// deps are needed (unlike analytics.mjs, which had an api.mjs-local KV reader to
// wire). api.mjs re-exports the loaders so the scheduled cron and the staging tests
// keep importing them from "../workers/api.mjs".

import {
  MAX_STAGED_EVENTS_BYTES,
  MAX_STAGED_EVENT_ROWS,
  MAX_STAGED_BLOCKS_BYTES,
  MAX_STAGED_BLOCK_ROWS,
  MAX_STAGED_EXTRINSICS_BYTES,
  MAX_STAGED_EXTRINSIC_ROWS,
  NEURON_SNAPSHOT_PRUNE_RETRIES,
} from "../config.mjs";
import { NEURON_INSERT_COLUMNS } from "../../src/metagraph-neurons.mjs";
import {
  eventInsertStatements,
  validEventRows,
} from "../../src/account-events.mjs";
import { blockInsertStatements, validBlockRows } from "../../src/blocks.mjs";
import {
  extrinsicInsertStatements,
  validExtrinsicRows,
} from "../../src/extrinsics.mjs";

// Sanity bounds for an authenticated, HMAC-signed staged neuron batch (the data
// is already trusted; these are defense-in-depth caps so a malformed signed file
// can't blow up the D1 load). The byte cap intentionally allows the
// expected all-subnet signed JSON envelope (~33k rows) while still bounding
// memory use before parsing. netuid and uid are both u16 on-chain, so each is
// capped at the u16 max (65535) — matching the existing netuid guard in
// src/webhooks.mjs and avoiding rejection of legitimately high subnet ids.
const STAGED_NEURONS_KEY = "metagraph/neurons-pending.json";
const STAGED_EVENTS_KEY = "events/account-events-pending.json";
const STAGED_BLOCKS_KEY = "events/blocks-pending.json";
const STAGED_EXTRINSICS_KEY = "events/extrinsics-pending.json";
const MAX_STAGED_NEURONS_BYTES = 32_000_000;
const MAX_STAGED_NEURON_ROWS = 50_000;
const MAX_STAGED_NEURON_STRING_BYTES = 512;
const MAX_STAGED_NETUID = 65_535;
const MAX_STAGED_UID = 65_535;
const MAX_STAGED_REFRESHED_NETUIDS = 256;

function neuronStagingSignPayload(rows, refreshed_netuids, captured_at) {
  if (refreshed_netuids == null && captured_at == null) {
    return JSON.stringify(rows);
  }
  return JSON.stringify({ rows, refreshed_netuids, captured_at });
}

function parseNeuronStagingMeta(envelope, rows) {
  const hasRefreshed = envelope?.refreshed_netuids !== undefined;
  const hasCaptured = envelope?.captured_at !== undefined;
  if (!hasRefreshed && !hasCaptured) {
    return { legacy: true };
  }
  if (!hasRefreshed || !hasCaptured) {
    return { invalid: true };
  }
  const refreshed_netuids = envelope.refreshed_netuids;
  const captured_at = envelope.captured_at;
  if (
    !Array.isArray(refreshed_netuids) ||
    refreshed_netuids.length > MAX_STAGED_REFRESHED_NETUIDS ||
    !Number.isInteger(captured_at) ||
    captured_at < 0
  ) {
    return { invalid: true };
  }
  const refreshedSet = new Set();
  for (const netuid of refreshed_netuids) {
    if (
      !Number.isInteger(netuid) ||
      netuid < 0 ||
      netuid > MAX_STAGED_NETUID ||
      refreshedSet.has(netuid)
    ) {
      return { invalid: true };
    }
    refreshedSet.add(netuid);
  }
  for (const row of rows) {
    if (row.captured_at !== captured_at || !refreshedSet.has(row.netuid)) {
      return { invalid: true };
    }
  }
  return { legacy: false, refreshed_netuids, captured_at };
}

function eventStagingSignPayload(rows) {
  return JSON.stringify(rows);
}

function blockStagingSignPayload(rows) {
  return JSON.stringify(rows);
}

function extrinsicStagingSignPayload(rows) {
  return JSON.stringify(rows);
}

async function signedEventEnvelope(signingKey, rows) {
  return {
    schema_version: 1,
    hmac_sha256: await hmacHex(signingKey, eventStagingSignPayload(rows)),
    rows,
  };
}

async function signedBlockEnvelope(signingKey, rows) {
  return {
    schema_version: 1,
    hmac_sha256: await hmacHex(signingKey, blockStagingSignPayload(rows)),
    rows,
  };
}

async function signedExtrinsicEnvelope(signingKey, rows) {
  return {
    schema_version: 1,
    hmac_sha256: await hmacHex(signingKey, extrinsicStagingSignPayload(rows)),
    rows,
  };
}

function utf8Bytes(value) {
  return new TextEncoder().encode(value);
}

function timingSafeStringEqual(a, b) {
  const left = utf8Bytes(String(a || ""));
  const right = utf8Bytes(String(b || ""));
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function hmacHex(key, value) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    utf8Bytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, utf8Bytes(value));
  return [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function validStagedNeuronRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  if (
    !Number.isInteger(row.netuid) ||
    row.netuid < 0 ||
    row.netuid > MAX_STAGED_NETUID
  )
    return false;
  if (!Number.isInteger(row.uid) || row.uid < 0 || row.uid > MAX_STAGED_UID)
    return false;
  for (const [key, value] of Object.entries(row)) {
    if (!NEURON_INSERT_COLUMNS.includes(key)) return false;
    if (
      typeof value === "string" &&
      utf8Bytes(value).length > MAX_STAGED_NEURON_STRING_BYTES
    )
      return false;
    if (typeof value === "number" && !Number.isFinite(value)) return false;
    if (
      typeof value === "boolean" ||
      typeof value === "bigint" ||
      typeof value === "symbol" ||
      typeof value === "function"
    )
      return false;
  }
  return true;
}

function neuronSnapshotPruneStatement(db, stagingMeta, snapshotCapturedAt) {
  return stagingMeta.legacy
    ? db
        .prepare(`DELETE FROM neurons WHERE captured_at < ?`)
        .bind(snapshotCapturedAt)
    : db
        .prepare(
          `DELETE FROM neurons WHERE netuid IN (${stagingMeta.refreshed_netuids
            .map(() => "?")
            .join(",")}) AND captured_at < ?`,
        )
        .bind(...stagingMeta.refreshed_netuids, stagingMeta.captured_at);
}

async function runNeuronSnapshotPrune(
  db,
  stagingMeta,
  snapshotCapturedAt,
  { retries = NEURON_SNAPSHOT_PRUNE_RETRIES } = {},
) {
  const prune = neuronSnapshotPruneStatement(
    db,
    stagingMeta,
    snapshotCapturedAt,
  );
  let lastError;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await prune.run();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// Load a staged per-UID metagraph snapshot from R2 into D1 (#1303). The
// refresh-metagraph CI job fetches the metagraph first-party (#1348), wraps the
// neuron rows in an HMAC-signed envelope, and writes it to R2
// (metagraph/neurons-pending.json) using its existing R2 permission; we load only
// authenticated, bounded, schema-valid rows through the METAGRAPH_HEALTH_DB
// binding — which needs no API-token D1 permission — with PARAMETERIZED inserts
// (values are always bound, never interpolated). After every batch succeeds we
// delete older rows for the coverage represented by the staged payload: legacy
// bare-array snapshots replace the full table, while coverage envelopes replace
// only their refreshed subnets. Then delete the staged object so it loads exactly
// once.
export async function loadStagedNeurons(env) {
  const bucket = env.METAGRAPH_ARCHIVE;
  const db = env.METAGRAPH_HEALTH_DB;
  const signingKey = env.METAGRAPH_STAGING_SIGNING_KEY;
  if (!bucket?.get || !db?.prepare || !signingKey) {
    return { ok: false, reason: "unavailable" };
  }
  const object = await bucket.get(STAGED_NEURONS_KEY);
  if (!object) return { ok: false, reason: "none" };
  // Byte cap: never materialize a pathological body. `size` is object metadata,
  // available before the body is streamed. Do NOT delete — that would drop rows the
  // producer staged; leave it (loud) and let the overlapping poller's next window
  // self-heal it. A misconfigured backfill exceeding this should be chunked by the
  // producer, not parsed here.
  if (Number(object.size || 0) > MAX_STAGED_NEURONS_BYTES) {
    console.warn(
      `loadStagedNeurons: staged file ${object.size} bytes exceeds ${MAX_STAGED_NEURONS_BYTES}; skipping (poller overlap self-heals)`,
    );
    return { ok: false, reason: "too_large", size: Number(object.size) };
  }
  let envelope;
  try {
    envelope = await object.json();
  } catch {
    await bucket.delete(STAGED_NEURONS_KEY);
    return { ok: false, reason: "parse_failed" };
  }
  const rows = Array.isArray(envelope?.rows) ? envelope.rows : [];
  if (
    envelope?.schema_version !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(envelope?.hmac_sha256 || ""))
  ) {
    await bucket.delete(STAGED_NEURONS_KEY);
    return { ok: false, reason: "unauthenticated" };
  }
  if (rows.length > MAX_STAGED_NEURON_ROWS) {
    await bucket.delete(STAGED_NEURONS_KEY);
    return { ok: false, reason: "too_many_rows" };
  }
  if (!rows.length || rows.some((row) => !validStagedNeuronRow(row))) {
    await bucket.delete(STAGED_NEURONS_KEY);
    return { ok: false, reason: "invalid" };
  }
  const stagingMeta = parseNeuronStagingMeta(envelope, rows);
  if (stagingMeta.invalid) {
    await bucket.delete(STAGED_NEURONS_KEY);
    return { ok: false, reason: "invalid" };
  }
  const expected = await hmacHex(
    signingKey,
    neuronStagingSignPayload(
      rows,
      stagingMeta.legacy ? null : stagingMeta.refreshed_netuids,
      stagingMeta.legacy ? null : stagingMeta.captured_at,
    ),
  );
  if (!timingSafeStringEqual(expected, envelope.hmac_sha256)) {
    await bucket.delete(STAGED_NEURONS_KEY);
    return { ok: false, reason: "unauthenticated" };
  }
  const cols = NEURON_INSERT_COLUMNS;
  const colList = cols.join(",");
  const ROWS_PER_STMT = 5;
  const STMTS_PER_BATCH = 50;
  const statements = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
    const chunk = rows.slice(i, i + ROWS_PER_STMT);
    const tuples = chunk
      .map(() => `(${cols.map(() => "?").join(",")})`)
      .join(",");
    const values = chunk.flatMap((row) => cols.map((c) => row[c] ?? null));
    statements.push(
      db
        .prepare(`INSERT OR REPLACE INTO neurons (${colList}) VALUES ${tuples}`)
        .bind(...values),
    );
  }
  // A staged snapshot is replacement data for its declared coverage: every row
  // shares one captured_at stamp (set once by the producer). If ANY batch throws,
  // bail WITHOUT deleting prior rows or the staged object — the prior snapshot
  // stays as a fallback and the next cron retries the same staged file.
  let snapshotCapturedAt = 0;
  for (const row of rows) {
    if (
      Number.isInteger(row.captured_at) &&
      row.captured_at > snapshotCapturedAt
    )
      snapshotCapturedAt = row.captured_at;
  }
  const pruneStatement = neuronSnapshotPruneStatement(
    db,
    stagingMeta,
    snapshotCapturedAt,
  );
  let purged;
  try {
    // Single-batch snapshots upsert + prune in one D1 transaction so a failed
    // prune cannot commit replacement rows while deregistered UIDs linger.
    if (statements.length + 1 <= STMTS_PER_BATCH) {
      const batchResult = await db.batch([...statements, pruneStatement]);
      purged = batchResult.at(-1)?.meta?.changes ?? 0;
    } else {
      for (let i = 0; i < statements.length; i += STMTS_PER_BATCH) {
        await db.batch(statements.slice(i, i + STMTS_PER_BATCH));
      }
      const result = await runNeuronSnapshotPrune(
        db,
        stagingMeta,
        snapshotCapturedAt,
      );
      purged = result?.meta?.changes ?? 0;
    }
  } catch {
    // Mid-upsert failure: prior snapshot stays intact and the staged object is
    // preserved for retry. Post-upsert prune failure (multi-batch only): upserts
    // are already committed — keep the staged object so the next cron re-prunes.
    return {
      ok: false,
      reason:
        statements.length + 1 <= STMTS_PER_BATCH
          ? "load_failed"
          : "purge_failed",
    };
  }
  await bucket.delete(STAGED_NEURONS_KEY);
  return { ok: true, rows: rows.length, purged };
}

// Load a staged chain-event batch from R2 into D1 (#1346, epic #1345). The
// refresh-events CI job decodes finney's System.Events first-party (no Taostats),
// signs rows with METAGRAPH_STAGING_SIGNING_KEY, and writes the envelope to R2;
// we load only authenticated rows through the binding (no API-token D1 permission)
// with PARAMETERIZED INSERT OR IGNORE keyed (block_number, event_index) — so
// overlapping poller windows re-insert harmlessly (idempotent, no cursor needed).
// Then delete the object (or rewrite a signed remainder) so each batch loads once.
export async function loadStagedEvents(env) {
  const bucket = env.METAGRAPH_ARCHIVE;
  const db = env.METAGRAPH_HEALTH_DB;
  const signingKey = env.METAGRAPH_STAGING_SIGNING_KEY;
  if (!bucket?.get || !db?.prepare || !signingKey) {
    return { ok: false, reason: "unavailable" };
  }
  const key = STAGED_EVENTS_KEY;
  const object = await bucket.get(key);
  if (!object) return { ok: false, reason: "none" };
  // Byte cap: never materialize a pathological body. `size` is object metadata,
  // available before the body is streamed. Do NOT delete — that would drop rows the
  // producer staged; leave it (loud) and let the overlapping poller's next window
  // self-heal it. A misconfigured backfill exceeding this should be chunked by the
  // producer, not parsed here.
  if (Number(object.size || 0) > MAX_STAGED_EVENTS_BYTES) {
    console.warn(
      `loadStagedEvents: staged file ${object.size} bytes exceeds ${MAX_STAGED_EVENTS_BYTES}; skipping (poller overlap self-heals)`,
    );
    return { ok: false, reason: "too_large", size: Number(object.size || 0) };
  }
  let envelope;
  try {
    envelope = await object.json();
  } catch {
    await bucket.delete(key);
    return { ok: false, reason: "parse_failed" };
  }
  const rows = Array.isArray(envelope?.rows) ? envelope.rows : [];
  if (
    envelope?.schema_version !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(envelope?.hmac_sha256 || ""))
  ) {
    await bucket.delete(key);
    return { ok: false, reason: "unauthenticated" };
  }
  const expected = await hmacHex(signingKey, eventStagingSignPayload(rows));
  if (!timingSafeStringEqual(expected, envelope.hmac_sha256)) {
    await bucket.delete(key);
    return { ok: false, reason: "unauthenticated" };
  }
  const validRows = validEventRows(rows);
  if (!validRows.length) {
    await bucket.delete(key);
    return { ok: false, reason: "empty" };
  }
  // Row cap: bound the D1 writes + subrequests per */3 tick. Drain up to the cap
  // now; if rows remain, rewrite the object with ONLY the signed remainder so the
  // next tick continues — never delete while rows are un-persisted. Order matters:
  // write to D1 FIRST, then shrink R2. A crash between them re-reads the full file
  // next tick and re-inserts the loaded rows harmlessly (INSERT OR IGNORE), so
  // nothing is dropped.
  const batch =
    validRows.length > MAX_STAGED_EVENT_ROWS
      ? validRows.slice(0, MAX_STAGED_EVENT_ROWS)
      : validRows;
  const remainder =
    validRows.length > MAX_STAGED_EVENT_ROWS
      ? validRows.slice(MAX_STAGED_EVENT_ROWS)
      : [];
  const statements = eventInsertStatements(db, batch);
  const STMTS_PER_BATCH = 50;
  for (let i = 0; i < statements.length; i += STMTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + STMTS_PER_BATCH));
  }
  if (remainder.length) {
    await bucket.put(
      key,
      JSON.stringify(await signedEventEnvelope(signingKey, remainder)),
    );
    return { ok: true, rows: batch.length, remaining: remainder.length };
  }
  await bucket.delete(key);
  return { ok: true, rows: batch.length };
}

// Block-explorer hot window (#1345): load the R2-staged `blocks` sidecar into D1
// `blocks`. Mirrors loadStagedEvents EXACTLY — same byte/row caps, the same
// HMAC-authenticated envelope, the same write-D1-first / shrink-R2-after
// progressive drain, and delete-on-success. Idempotent: INSERT OR IGNORE on
// block_number means an overlapping poller window (or a re-drain after a crash
// between the D1 write and the R2 shrink) re-inserts harmlessly. Called from the
// same */3 fast-load cron that owns loadStagedEvents (NO new cron — the drain is
// gated to one cron to remove cross-cron R2 read-modify-write clobbering).
export async function loadStagedBlocks(env) {
  const bucket = env.METAGRAPH_ARCHIVE;
  const db = env.METAGRAPH_HEALTH_DB;
  const signingKey = env.METAGRAPH_STAGING_SIGNING_KEY;
  if (!bucket?.get || !db?.prepare || !signingKey) {
    return { ok: false, reason: "unavailable" };
  }
  const key = STAGED_BLOCKS_KEY;
  const object = await bucket.get(key);
  if (!object) return { ok: false, reason: "none" };
  // Byte cap: never materialize a pathological body. Do NOT delete on overflow —
  // the overlapping poller's next window self-heals it (same stance as events).
  if (Number(object.size || 0) > MAX_STAGED_BLOCKS_BYTES) {
    console.warn(
      `loadStagedBlocks: staged file ${object.size} bytes exceeds ${MAX_STAGED_BLOCKS_BYTES}; skipping (poller overlap self-heals)`,
    );
    return { ok: false, reason: "too_large", size: Number(object.size || 0) };
  }
  let envelope;
  try {
    envelope = await object.json();
  } catch {
    await bucket.delete(key);
    return { ok: false, reason: "parse_failed" };
  }
  const rows = Array.isArray(envelope?.rows) ? envelope.rows : [];
  if (
    envelope?.schema_version !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(envelope?.hmac_sha256 || ""))
  ) {
    await bucket.delete(key);
    return { ok: false, reason: "unauthenticated" };
  }
  const expected = await hmacHex(signingKey, blockStagingSignPayload(rows));
  if (!timingSafeStringEqual(expected, envelope.hmac_sha256)) {
    await bucket.delete(key);
    return { ok: false, reason: "unauthenticated" };
  }
  const validRows = validBlockRows(rows);
  if (!validRows.length) {
    await bucket.delete(key);
    return { ok: false, reason: "empty" };
  }
  // Row cap + progressive drain: write D1 FIRST, then shrink R2. A crash between
  // them re-reads the full file next tick and re-inserts the loaded rows
  // harmlessly (INSERT OR IGNORE on block_number) — nothing is dropped.
  const batch =
    validRows.length > MAX_STAGED_BLOCK_ROWS
      ? validRows.slice(0, MAX_STAGED_BLOCK_ROWS)
      : validRows;
  const remainder =
    validRows.length > MAX_STAGED_BLOCK_ROWS
      ? validRows.slice(MAX_STAGED_BLOCK_ROWS)
      : [];
  const statements = blockInsertStatements(db, batch);
  const STMTS_PER_BATCH = 50;
  for (let i = 0; i < statements.length; i += STMTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + STMTS_PER_BATCH));
  }
  if (remainder.length) {
    await bucket.put(
      key,
      JSON.stringify(await signedBlockEnvelope(signingKey, remainder)),
    );
    return { ok: true, rows: batch.length, remaining: remainder.length };
  }
  await bucket.delete(key);
  return { ok: true, rows: batch.length };
}

// Block-explorer extrinsic slice (#1345): load the R2-staged `extrinsics` sidecar
// into D1 `extrinsics`. Mirrors loadStagedBlocks EXACTLY — same byte/row caps, the
// same HMAC-authenticated envelope, the same write-D1-first / shrink-R2-after
// progressive drain, and delete-on-success. Idempotent: INSERT OR IGNORE on
// (block_number, extrinsic_index) means an overlapping poller window (or a re-drain
// after a crash between the D1 write and the R2 shrink) re-inserts harmlessly.
// Called from the same */3 fast-load cron that owns loadStagedBlocks (NO new cron —
// the drain is gated to one cron to remove cross-cron R2 read-modify-write
// clobbering).
export async function loadStagedExtrinsics(env) {
  const bucket = env.METAGRAPH_ARCHIVE;
  const db = env.METAGRAPH_HEALTH_DB;
  const signingKey = env.METAGRAPH_STAGING_SIGNING_KEY;
  if (!bucket?.get || !db?.prepare || !signingKey) {
    return { ok: false, reason: "unavailable" };
  }
  const key = STAGED_EXTRINSICS_KEY;
  const object = await bucket.get(key);
  if (!object) return { ok: false, reason: "none" };
  // Byte cap: never materialize a pathological body. Do NOT delete on overflow —
  // the overlapping poller's next window self-heals it (same stance as blocks).
  if (Number(object.size || 0) > MAX_STAGED_EXTRINSICS_BYTES) {
    console.warn(
      `loadStagedExtrinsics: staged file ${object.size} bytes exceeds ${MAX_STAGED_EXTRINSICS_BYTES}; skipping (poller overlap self-heals)`,
    );
    return { ok: false, reason: "too_large", size: Number(object.size || 0) };
  }
  let envelope;
  try {
    envelope = await object.json();
  } catch {
    await bucket.delete(key);
    return { ok: false, reason: "parse_failed" };
  }
  const rows = Array.isArray(envelope?.rows) ? envelope.rows : [];
  if (
    envelope?.schema_version !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(envelope?.hmac_sha256 || ""))
  ) {
    await bucket.delete(key);
    return { ok: false, reason: "unauthenticated" };
  }
  const expected = await hmacHex(signingKey, extrinsicStagingSignPayload(rows));
  if (!timingSafeStringEqual(expected, envelope.hmac_sha256)) {
    await bucket.delete(key);
    return { ok: false, reason: "unauthenticated" };
  }
  const validRows = validExtrinsicRows(rows);
  if (!validRows.length) {
    await bucket.delete(key);
    return { ok: false, reason: "empty" };
  }
  // Row cap + progressive drain: write D1 FIRST, then shrink R2. A crash between
  // them re-reads the full file next tick and re-inserts the loaded rows
  // harmlessly (INSERT OR IGNORE on (block_number, extrinsic_index)) — nothing is
  // dropped.
  const batch =
    validRows.length > MAX_STAGED_EXTRINSIC_ROWS
      ? validRows.slice(0, MAX_STAGED_EXTRINSIC_ROWS)
      : validRows;
  const remainder =
    validRows.length > MAX_STAGED_EXTRINSIC_ROWS
      ? validRows.slice(MAX_STAGED_EXTRINSIC_ROWS)
      : [];
  const statements = extrinsicInsertStatements(db, batch);
  const STMTS_PER_BATCH = 50;
  for (let i = 0; i < statements.length; i += STMTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + STMTS_PER_BATCH));
  }
  if (remainder.length) {
    await bucket.put(
      key,
      JSON.stringify(await signedExtrinsicEnvelope(signingKey, remainder)),
    );
    return { ok: true, rows: batch.length, remaining: remainder.length };
  }
  await bucket.delete(key);
  return { ok: true, rows: batch.length };
}

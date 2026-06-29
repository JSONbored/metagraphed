// Single-entity chain-data handlers: the cheap per-key D1 lookups behind the
// metagraph, account, block, and extrinsic routes (extracted from workers/api.mjs
// per #1763).
//
// These are the "fetch one entity by its key" reads — a subnet's metagraph, one
// UID's neuron + history, a per-subnet history rollup, an account summary/events/
// subnets, the block + extrinsic feeds and their detail rows. Every handler is
// null-safe by design: an unbound or cold D1 returns a schema-stable empty/zero
// payload (never a 404 or a throw), matching the live tiers the analytics module
// already owns.
//
// Dependency wiring (the analytics.mjs pattern): the D1 read path (`d1All` /
// `d1Runner`) and the query-param guards (`validateQueryParams` /
// `analyticsQueryError`) live in request-handlers/analytics.mjs, which this module
// imports directly. analytics.mjs imports nothing from here, so the two are a
// clean leaf chain with no cycle — no injected deps are needed. Everything else is
// imported straight from the src/* leaf modules + config. api.mjs imports the
// handlers back and dispatches them from the router.

import { DAY_MS, SS58_ADDRESS_PATTERN, resolveClientIp } from "../config.mjs";
import {
  BLOCK_PAGINATION,
  DAY_PATTERN,
  FEED_PAGINATION,
  parseDateRange,
  parseNonNegativeIntParam,
  parsePagination,
} from "../request-params.mjs";

import { errorResponse } from "../http.mjs";
import {
  contractVersion,
  envelopeResponse,
  publishedAt,
} from "../responses.mjs";
import {
  analyticsQueryError,
  d1All,
  d1Runner,
  validateQueryParams,
} from "./analytics.mjs";
import {
  loadSubnetMetagraph,
  loadSubnetValidators,
  loadNeuron,
} from "../../src/metagraph-neurons.mjs";
import {
  buildNeuronHistory,
  buildSubnetHistory,
  parseHistoryWindow,
  NEURON_DAILY_READ_COLUMNS,
  MAX_HISTORY_POINTS,
} from "../../src/neuron-history.mjs";
import {
  ACCOUNT_EVENT_COLUMNS,
  INGESTED_EVENT_KINDS,
  buildAccountTransfers,
  buildAccountHistory,
  buildSubnetEvents,
  buildBlockEvents,
  formatAccountEvent,
  loadAccountSummary,
  loadAccountEvents,
  loadAccountSubnets,
} from "../../src/account-events.mjs";
import {
  isFinneySs58Address,
  loadAccountBalance,
} from "../../src/account-balance.mjs";
import { decodeCursor, encodeCursor } from "../../src/cursor.mjs";
import {
  BLOCK_READ_COLUMNS,
  buildBlock,
  buildBlockFeed,
} from "../../src/blocks.mjs";
import {
  EXTRINSIC_READ_COLUMNS,
  EXTRINSIC_RETENTION_MS,
  buildAccountExtrinsics,
  buildBlockExtrinsics,
  buildExtrinsic,
  buildExtrinsicFeed,
} from "../../src/extrinsics.mjs";
import {
  CONCENTRATION_HISTORY_ROW_CAP,
  CONCENTRATION_READ_COLUMNS,
  buildConcentration,
  buildConcentrationHistory,
  parseConcentrationHistoryWindow,
} from "../../src/concentration.mjs";
import {
  COUNTERPARTIES_READ_COLUMNS,
  COUNTERPARTIES_SCAN_CAP,
  COUNTERPARTY_RELATIONSHIP_READ_COLUMNS,
  COUNTERPARTY_RELATIONSHIP_SCAN_CAP,
  buildCounterpartyRelationship,
  buildCounterparties,
} from "../../src/counterparties.mjs";
import { loadSubnetTurnover } from "../../src/turnover.mjs";

const MAX_BLOCK_COUNT_FILTER = 1_000_000;

function parseBoundedIntParam(url, parameter, { def, min, max }) {
  const raw = url.searchParams.get(parameter);
  if (raw == null || raw === "") return { value: def };
  if (!/^\d+$/.test(raw)) {
    return {
      error: {
        parameter,
        message: `${parameter} must be an integer from ${min} to ${max}.`,
      },
    };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return {
      error: {
        parameter,
        message: `${parameter} must be an integer from ${min} to ${max}.`,
      },
    };
  }
  return { value };
}

// Strict path-ref parsers: Number()/split("-") coerce a malformed ref (hex,
// 1e3, empty/extra halves) into a wrong-but-valid lookup; require bare decimal
// segments + Number.isSafeInteger (same convention as parseBoundedIntParam).
const STRICT_UINT_RE = /^\d+$/;
const COMPOSITE_REF_RE = /^(\d+)-(\d+)$/;

// A strict non-negative block_number, or null for a non-decimal ref (so the
// caller skips the lookup and serves the schema-stable miss).
function strictBlockNumber(ref) {
  if (!STRICT_UINT_RE.test(ref)) return null;
  const value = Number(ref);
  return Number.isSafeInteger(value) ? value : null;
}

// --- Per-UID metagraph (#1304/#1305): served live from the neurons D1 tier ---
// (migration 0007, populated by the refresh-metagraph cron). Null-safe: an
// unbound/cold D1 returns a schema-stable empty payload, like the other
// D1-backed analytics routes.
async function metagraphMeta(env, artifactPath, generatedAt) {
  return {
    artifact_path: artifactPath,
    cache: "short",
    contract_version: contractVersion(env),
    generated_at: generatedAt,
    published_at: await publishedAt(env),
    source: "metagraph-snapshot",
  };
}

export async function handleSubnetMetagraph(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["validator_permit"]);
  if (validationError) return analyticsQueryError(validationError);
  const validatorsOnly = url.searchParams.get("validator_permit") === "true";
  const data = await loadSubnetMetagraph(d1Runner(env), netuid, {
    validatorsOnly,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/metagraph.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

export async function handleNeuron(request, env, netuid, uid) {
  // Cold/absent snapshot → 200 with neuron:null, consistent with the other live
  // tiers (health/economics never 404 on a cold store).
  const data = await loadNeuron(d1Runner(env), netuid, uid);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/neurons/${uid}.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

export async function handleSubnetValidators(request, env, netuid, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const data = await loadSubnetValidators(d1Runner(env), netuid);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/validators.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// ---- Per-UID + per-subnet metagraph HISTORY (block-explorer Tier-1, #1345) --
// Served from the dated neuron_daily rollup tier (D1). Cold/absent store → 200
// with empty points (never 404), consistent with the live metagraph tiers.

// GET /api/v1/subnets/{netuid}/neurons/{uid}/history?window=7d|30d|90d|1y|all
// Per-UID time series (one point per snapshot_date, newest first, bounded).
export async function handleNeuronHistory(request, env, netuid, uid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const { label, days, error } = parseHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return analyticsQueryError(error);
  const params = [netuid, uid];
  let sql = `SELECT ${NEURON_DAILY_READ_COLUMNS} FROM neuron_daily WHERE netuid = ? AND uid = ?`;
  if (days != null) {
    // Cutoff computed in JS and bound as a plain YYYY-MM-DD (idx_neuron_daily_uid_date covers it).
    const cutoff = new Date(Date.now() - days * DAY_MS)
      .toISOString()
      .slice(0, 10);
    sql += " AND snapshot_date >= ?";
    params.push(cutoff);
  }
  sql += " ORDER BY snapshot_date DESC LIMIT ?";
  params.push(MAX_HISTORY_POINTS);
  const rows = await d1All(env, sql, params);
  const data = buildNeuronHistory(rows, netuid, uid, { window: label });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/neurons/${uid}/history.json`,
        data.points[0]?.captured_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/history?window=7d|30d|90d|1y|all
// Per-subnet daily aggregates over time (count + totals) for a history sparkline,
// without shipping every UID's row.
export async function handleSubnetHistory(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const { label, days, error } = parseHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return analyticsQueryError(error);
  const params = [netuid];
  let sql =
    "SELECT snapshot_date, COUNT(*) AS neuron_count, " +
    "SUM(validator_permit) AS validator_count, " +
    "SUM(stake_tao) AS total_stake_tao, SUM(emission_tao) AS total_emission_tao " +
    "FROM neuron_daily WHERE netuid = ?";
  if (days != null) {
    const cutoff = new Date(Date.now() - days * DAY_MS)
      .toISOString()
      .slice(0, 10);
    sql += " AND snapshot_date >= ?";
    params.push(cutoff);
  }
  sql += " GROUP BY snapshot_date ORDER BY snapshot_date DESC LIMIT ?";
  params.push(MAX_HISTORY_POINTS);
  const rows = await d1All(env, sql, params);
  const data = buildSubnetHistory(rows, netuid, { window: label });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/history.json`,
        null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/concentration: stake & emission decentralization
// metrics (Gini, HHI, Nakamoto coefficient, top-percentile shares, entropy) over
// the subnet's live distribution (#2106), across three lenses — per-UID, per-entity
// (coldkeys collapsed, the true control distribution) and validator-only consensus
// power. Computed from the neurons D1 tier; a cold/absent store or empty
// subnet → 200 with null blocks (schema-stable, never 404), mirroring the sibling
// metagraph/history routes.
export async function handleSubnetConcentration(request, env, netuid, url) {
  const validationError = validateQueryParams(url, []);
  if (validationError) return analyticsQueryError(validationError);
  const rows = await d1All(
    env,
    `SELECT ${CONCENTRATION_READ_COLUMNS} FROM neurons WHERE netuid = ?`,
    [netuid],
  );
  const data = buildConcentration(rows, netuid);
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/concentration.json`,
        data.captured_at,
      ),
    },
    "short",
  );
}

// Shared helper: build a canonical edge-cache key for any windowed route by
// normalising the ?window= query parameter through the route-specific parse
// function, so that an omitted window and an explicit default-value window map
// to the same cache slot.
function canonicalWindowedCachePath(url, parseWindow) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const { label, error } = parseWindow(url.searchParams.get("window"));
  if (error) return `${url.pathname}${url.search}`;
  return `${url.pathname}?window=${encodeURIComponent(label)}`;
}

export function canonicalSubnetHistoryCachePath(url) {
  return canonicalWindowedCachePath(url, parseHistoryWindow);
}

export function canonicalSubnetConcentrationHistoryCachePath(url) {
  return canonicalWindowedCachePath(url, parseConcentrationHistoryWindow);
}

// Canonical edge-cache key for the subnet-turnover route (?window= via
// parseHistoryWindow). Distinct from canonicalSubnetConcentrationHistoryCachePath
// which uses a different parse function (parseConcentrationHistoryWindow).
export function canonicalSubnetTurnoverCachePath(url) {
  return canonicalWindowedCachePath(url, parseHistoryWindow);
}

// Canonical edge-cache key for the subnet-metagraph route. Only
// ?validator_permit=true changes the response; omission and =false both serve
// the full metagraph and must share one cache slot.
export function canonicalSubnetMetagraphCachePath(url) {
  const validationError = validateQueryParams(url, ["validator_permit"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const validatorsOnly = url.searchParams.get("validator_permit") === "true";
  return validatorsOnly
    ? `${url.pathname}?validator_permit=true`
    : url.pathname;
}

// GET /api/v1/subnets/{netuid}/concentration/history?window=7d|30d|90d: the per-day
// stake & emission concentration trend (Gini, Nakamoto coefficient, top-10% share)
// from the dated neuron_daily rollup — "is this subnet centralizing over time?".
// Each day needs its full per-UID distribution, so the read is the raw rows (not a
// GROUP BY) bounded by a row cap; a cold/absent store → 200 with points:[]
// (schema-stable, never 404).
export async function handleSubnetConcentrationHistory(
  request,
  env,
  netuid,
  url,
) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const { label, days, error } = parseConcentrationHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return analyticsQueryError(error);
  const cutoff = new Date(Date.now() - days * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const rows = await d1All(
    env,
    "SELECT snapshot_date, stake_tao, emission_tao FROM neuron_daily WHERE netuid = ? AND snapshot_date >= ? ORDER BY snapshot_date DESC LIMIT ?",
    [netuid, cutoff, CONCENTRATION_HISTORY_ROW_CAP],
  );
  const data = buildConcentrationHistory(rows, netuid, {
    window: label,
    capped: rows.length >= CONCENTRATION_HISTORY_ROW_CAP,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/concentration/history.json`,
        data.points[0]?.snapshot_date ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/turnover?window=7d|30d|90d|1y|all: validator-set &
// registration churn between the window's start and end neuron_daily snapshots —
// validators entered/exited + Jaccard retention, UID deregistrations, and a 0–100
// stability score. Reads only the two boundary snapshot_dates (a MIN/MAX bounds
// query then their rows). Cold/absent store or a single snapshot → 200 with
// comparable:false + zeroed metrics (schema-stable, never 404).
export async function handleSubnetTurnover(request, env, netuid, url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return analyticsQueryError(validationError);
  const { label, days, error } = parseHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return analyticsQueryError(error);
  const data = await loadSubnetTurnover(d1Runner(env), netuid, {
    windowLabel: label,
    windowDays: days,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/turnover.json`,
        data.end_date,
      ),
    },
    "short",
  );
}

// ---- Account entity handlers (#1347) ---------------------------------------
// SQL + pagination live in src/account-events.mjs (loadAccount*), shared with the
// MCP account tools; these handlers add only the REST envelope + meta.
async function accountMeta(env, artifactPath, generatedAt) {
  return {
    artifact_path: artifactPath,
    cache: "short",
    contract_version: contractVersion(env),
    generated_at: generatedAt,
    published_at: await publishedAt(env),
    source: "chain-events",
  };
}

// GET /api/v1/accounts/{ss58}: cross-subnet summary — event-history aggregates
// (account_events, matched by hotkey OR coldkey) joined to current registrations
// (neurons, by hotkey). Cold/absent store → schema-stable zero (never 404).
export async function handleAccount(request, env, ss58) {
  const data = await loadAccountSummary(d1Runner(env), ss58);
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}.json`,
        data.last_seen_at,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/events: paginated event history (newest first),
// optional ?kind= filter, ?limit (<=1000) / ?offset.
export async function handleAccountEvents(request, env, ss58, url) {
  const validationError = validateQueryParams(url, [
    "kind",
    "limit",
    "offset",
    "cursor",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const data = await loadAccountEvents(d1Runner(env), ss58, {
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
    kind: url.searchParams.get("kind"),
    cursor: url.searchParams.get("cursor"),
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/events.json`,
        data.events[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/history (#1854): the durable per-day activity
// series for an account, from the account_events_daily rollup. ?netuid filters
// to one subnet; ?from / ?to are YYYY-MM-DD bounds (lexicographic on the TEXT
// `day` column); ?limit (<=1000) / ?offset. Newest day first. Cold/absent store
// → schema-stable zero (never 404).
//
// SCOPE: the rollup writes only hotkey-attributed rows, so an ss58 with no
// hotkey activity returns zero days even when /events shows activity — a
// documented limitation of the hotkey-keyed rollup, not a bug (the contract
// description spells out the contrast with /events in full).
const ACCOUNT_DAY_COLUMNS =
  "day, netuid, event_count, event_kinds, first_block, last_block";

export async function handleAccountHistory(request, env, ss58, url) {
  const validationError = validateQueryParams(url, [
    "netuid",
    "from",
    "to",
    "limit",
    "offset",
    "cursor",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const range = parseDateRange(url);
  if (range.error) return errorResponse("invalid_param", range.error, 400);
  const { from, to } = range;
  const { limit, offset, cursor } = parsePagination(url, FEED_PAGINATION);
  const netuid = url.searchParams.get("netuid");
  if (netuid != null && !/^\d+$/.test(netuid)) {
    return errorResponse(
      "invalid_param",
      "netuid must be a non-negative integer.",
      400,
    );
  }
  // Keyset (cursor) pagination over (day, netuid). day sorts as TEXT (YYYY-MM-DD
  // is chronological); the cursor encodes it as its natural sortable integer
  // (2026-06-25 -> 20260625) to fit the integer-only cursor codec, with netuid as
  // the within-day tiebreaker. netuid is NOT NULL (a primary-key column of
  // account_events_daily), so the cursor's netuid leg is always a real integer and
  // the seek never degrades to a NULL comparison. ORDER BY adds `netuid DESC` to
  // make same-day ordering deterministic — it was `day DESC` only before, where
  // same-day order was unspecified, so existing offset callers get a stable (not a
  // changed) page order. offset stays as a deprecated fallback; cursor wins. A
  // cursor that does not decode to a valid YYYYMMDD day is ignored (falls back to
  // the first page), preserving the never-throw contract.
  const cur = decodeCursor(cursor, 2);
  const cursorDay = cur
    ? String(cur[0]).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")
    : null;
  const useCursor = Boolean(cursorDay && DAY_PATTERN.test(cursorDay));
  const params = [ss58];
  let sql = `SELECT ${ACCOUNT_DAY_COLUMNS} FROM account_events_daily WHERE hotkey = ?`;
  if (netuid != null) {
    sql += " AND netuid = ?";
    params.push(Number(netuid));
  }
  if (from) {
    sql += " AND day >= ?";
    params.push(from);
  }
  if (to) {
    sql += " AND day <= ?";
    params.push(to);
  }
  if (useCursor) {
    sql += " AND (day, netuid) < (?, ?)";
    params.push(cursorDay, cur[1]);
  }
  sql += " ORDER BY day DESC, netuid DESC LIMIT ?";
  params.push(limit);
  if (!useCursor) {
    sql += " OFFSET ?";
    params.push(offset);
  }
  const rows = await d1All(env, sql, params);
  const last = rows.length === limit ? rows[rows.length - 1] : null;
  const nextCursor =
    last && typeof last.day === "string" && DAY_PATTERN.test(last.day)
      ? encodeCursor([Number(last.day.replaceAll("-", "")), last.netuid])
      : null;
  const data = buildAccountHistory(rows, ss58, { limit, offset, nextCursor });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/history.json`,
        null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/extrinsics: the extrinsics this account SIGNED
// (newest first), from the extrinsics D1 tier (#1844). Matched by the extrinsic
// signer only — NOT the hotkey or coldkey union the account_events routes use,
// since `extrinsics` carries a single `signer` column. ?limit (<=1000) / ?offset.
// Cold/absent store → schema-stable zero (never 404).
export async function handleAccountExtrinsics(request, env, ss58, url) {
  const validationError = validateQueryParams(url, ["limit", "offset"]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset } = parsePagination(url, FEED_PAGINATION);
  const rows = await d1All(
    env,
    `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics WHERE signer = ? ORDER BY block_number DESC, extrinsic_index DESC LIMIT ? OFFSET ?`,
    [ss58, limit, offset],
  );
  const data = buildAccountExtrinsics(rows, ss58, { limit, offset });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/extrinsics.json`,
        data.extrinsics[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/transfers: the native-TAO Balances.Transfer feed for
// this account (#1850), newest first, from the account_events tier (event_kind=
// 'Transfer', where the poller stores hotkey=from / coldkey=to). ?direction=
// all|sent|received narrows by side; ?limit (<=1000) / ?offset. This is the
// native-TAO transfer feed only, NOT a full balance ledger. Cold/absent store →
// schema-stable zero (never 404).
export async function handleAccountTransfers(request, env, ss58, url) {
  const validationError = validateQueryParams(url, [
    "direction",
    "limit",
    "offset",
    "cursor",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const direction = url.searchParams.get("direction");
  if (
    direction !== null &&
    direction !== "all" &&
    direction !== "sent" &&
    direction !== "received"
  ) {
    return analyticsQueryError({
      parameter: "direction",
      message: `"${direction}" is not a valid direction. Supported: all, sent, received.`,
    });
  }
  const { limit, offset, cursor } = parsePagination(url, FEED_PAGINATION);
  // sent => this account is the sender (hotkey=from); received => recipient
  // (coldkey=to); default/all => either side. Keep the default read as two
  // side-specific seeks rather than an OR predicate so D1 cannot satisfy only
  // event_kind='Transfer' from the pair index and then filter all Transfer rows.
  // Self-transfers are returned once, matching the old OR semantics.
  const cur = decodeCursor(cursor, 2);
  const useCursor = Boolean(cur);
  const cursorClause = useCursor
    ? " AND (block_number, event_index) < (?, ?)"
    : "";
  let params;
  let sql;
  if (direction === "sent") {
    params = [ss58];
    sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events INDEXED BY idx_account_events_hotkey WHERE event_kind = 'Transfer' AND hotkey = ?${cursorClause}`;
  } else if (direction === "received") {
    params = [ss58];
    sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events INDEXED BY idx_account_events_coldkey WHERE event_kind = 'Transfer' AND coldkey = ?${cursorClause}`;
  } else {
    params = [ss58];
    if (useCursor) params.push(cur[0], cur[1]);
    params.push(ss58, ss58);
    sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM (SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events INDEXED BY idx_account_events_hotkey WHERE event_kind = 'Transfer' AND hotkey = ?${cursorClause} UNION ALL SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events INDEXED BY idx_account_events_coldkey WHERE event_kind = 'Transfer' AND coldkey = ? AND hotkey <> ?${cursorClause})`;
  }
  if (useCursor) params.push(cur[0], cur[1]);
  sql += " ORDER BY block_number DESC, event_index DESC LIMIT ?";
  params.push(limit);
  if (!useCursor) {
    sql += " OFFSET ?";
    params.push(offset);
  }
  const rows = await d1All(env, sql, params);
  const last = rows.length === limit ? rows[rows.length - 1] : null;
  const nextCursor = last
    ? encodeCursor([last.block_number, last.event_index])
    : null;
  const data = buildAccountTransfers(rows, ss58, { limit, offset, nextCursor });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/transfers.json`,
        data.transfers[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/counterparties?limit=N: who this account transacts
// with. Add ?counterparty=<ss58> to return a focused relationship drilldown on
// the same route without expanding the public path surface.
export async function handleAccountCounterparties(request, env, ss58, url) {
  const validationError = validateQueryParams(url, ["counterparty", "limit"]);
  if (validationError) return analyticsQueryError(validationError);
  const counterparty = url.searchParams.get("counterparty");
  const parsedLimit = parseBoundedIntParam(url, "limit", {
    def: counterparty == null ? 20 : 50,
    min: 1,
    max: 100,
  });
  if (parsedLimit.error) return analyticsQueryError(parsedLimit.error);
  const limit = parsedLimit.value;
  if (counterparty != null) {
    if (!SS58_ADDRESS_PATTERN.test(counterparty)) {
      return analyticsQueryError({
        parameter: "counterparty",
        message: "counterparty must be a valid SS58 account address.",
      });
    }
    if (ss58 === counterparty) {
      return analyticsQueryError({
        parameter: "counterparty",
        message: "counterparty must differ from ss58.",
      });
    }
    const rows = await d1All(
      env,
      `SELECT ${COUNTERPARTY_RELATIONSHIP_READ_COLUMNS} FROM (SELECT ${COUNTERPARTY_RELATIONSHIP_READ_COLUMNS} FROM account_events WHERE event_kind = 'Transfer' AND hotkey = ? AND coldkey = ? UNION ALL SELECT ${COUNTERPARTY_RELATIONSHIP_READ_COLUMNS} FROM account_events WHERE event_kind = 'Transfer' AND hotkey = ? AND coldkey = ?) ORDER BY block_number DESC, event_index DESC LIMIT ?`,
      [
        ss58,
        counterparty,
        counterparty,
        ss58,
        COUNTERPARTY_RELATIONSHIP_SCAN_CAP,
      ],
    );
    const relationship = buildCounterpartyRelationship(
      rows,
      ss58,
      counterparty,
      {
        limit,
      },
    );
    const counterpartyRow =
      relationship.transfer_count === 0
        ? []
        : [
            {
              address: counterparty,
              sent_tao: relationship.total_sent_tao,
              received_tao: relationship.total_received_tao,
              net_tao: relationship.net_tao,
              transfer_count: relationship.transfer_count,
              last_block: relationship.last_block,
            },
          ];
    return envelopeResponse(
      request,
      {
        data: {
          schema_version: 1,
          ss58,
          counterparty_count: counterpartyRow.length,
          transfers_scanned: relationship.transfers_scanned,
          scan_capped: relationship.scan_capped,
          total_sent_tao: relationship.total_sent_tao,
          total_received_tao: relationship.total_received_tao,
          counterparties: counterpartyRow,
          relationship,
        },
        meta: await accountMeta(
          env,
          `/metagraph/accounts/${ss58}/counterparties.json`,
          relationship.last_seen_at,
        ),
      },
      "short",
    );
  }
  const rows = await d1All(
    env,
    `SELECT ${COUNTERPARTIES_READ_COLUMNS} FROM (SELECT ${COUNTERPARTIES_READ_COLUMNS} FROM account_events INDEXED BY idx_account_events_hotkey WHERE event_kind = 'Transfer' AND hotkey = ? UNION ALL SELECT ${COUNTERPARTIES_READ_COLUMNS} FROM account_events INDEXED BY idx_account_events_coldkey WHERE event_kind = 'Transfer' AND coldkey = ? AND hotkey <> ?) ORDER BY block_number DESC LIMIT ?`,
    [ss58, ss58, ss58, COUNTERPARTIES_SCAN_CAP],
  );
  const data = buildCounterparties(rows, ss58, { limit });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/counterparties.json`,
        null,
      ),
    },
    "short",
  );
}

// GET /api/v1/accounts/{ss58}/subnets: the subnets where this hotkey is currently
// registered (the cross-subnet footprint), from the neurons tier.
export async function handleAccountSubnets(request, env, ss58) {
  const data = await loadAccountSubnets(d1Runner(env), ss58);
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/accounts/${ss58}/subnets.json`,
        null,
      ),
    },
    "short",
  );
}

// GET /api/v1/subnets/{netuid}/events (#1345 block explorer): the first-party
// chain-event stream for one subnet — account_events filtered by netuid, newest
// first (the idx_account_events_netuid index this tier was built for). Optional
// ?kind= filter; ?limit (<=1000)/?offset. Cold/absent store → schema-stable zero
// (never 404), mirroring handleAccountEvents.
export async function handleSubnetEvents(request, env, netuid, url) {
  const validationError = validateQueryParams(url, [
    "kind",
    "limit",
    "offset",
    "cursor",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset, cursor } = parsePagination(url, FEED_PAGINATION);
  const kind = url.searchParams.get("kind");
  // Reject an unknown ?kind= up front, validated against the FULL ingested set
  // (not just INDEXED_EVENT_KINDS, which would wrongly reject Transfer/NetworkAdded
  // etc.). A typo/nonexistent kind otherwise matches nothing and forces a full
  // index walk on this public, ~60s-cached route (#2081).
  if (kind != null && !INGESTED_EVENT_KINDS.includes(kind)) {
    return analyticsQueryError({
      parameter: "kind",
      message: `"${kind}" is not a supported event kind. Supported: ${INGESTED_EVENT_KINDS.join(", ")}.`,
    });
  }
  // Keyset (cursor) pagination on (block_number, event_index), mirroring
  // loadAccountEvents; offset stays as a deprecated fallback, cursor wins.
  const cur = decodeCursor(cursor, 2);
  const useCursor = Boolean(cur);
  const params = [netuid];
  let sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events WHERE netuid = ?`;
  if (kind) {
    sql += " AND event_kind = ?";
    params.push(kind);
  }
  if (useCursor) {
    sql += " AND (block_number, event_index) < (?, ?)";
    params.push(cur[0], cur[1]);
  }
  sql += " ORDER BY block_number DESC, event_index DESC LIMIT ?";
  params.push(limit);
  if (!useCursor) {
    sql += " OFFSET ?";
    params.push(offset);
  }
  const rows = await d1All(env, sql, params);
  const last = rows.length === limit ? rows[rows.length - 1] : null;
  const nextCursor = last
    ? encodeCursor([last.block_number, last.event_index])
    : null;
  const data = buildSubnetEvents(rows, netuid, { limit, offset, nextCursor });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/subnets/${netuid}/events.json`,
        data.events[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

export const BALANCE_RATE_LIMIT = { limit: 100, windowSeconds: 60 };

// GET /api/v1/accounts/{ss58}/balance (#1818): live TAO balance (free+reserved)
// for one account, queried from the finney RPC at request time. 60s KV cache via
// METAGRAPH_CONTROL. Returns 400 on invalid ss58; 200 with balance_tao:null on
// RPC failure (schema-stable, consistent with blocks/extrinsics null-on-miss).
// Served through the shared envelopeResponse so it carries the same ok/data
// envelope, weak ETag, contract-version header, and 304/HEAD handling as every
// other route — the body matches the AccountBalanceArtifact data schema.
export async function handleAccountBalance(request, env, ss58) {
  if (!isFinneySs58Address(ss58)) {
    return errorResponse(
      "invalid_ss58",
      "ss58 address must be a valid finney SS58 account address.",
      400,
    );
  }

  if (env.RPC_RATE_LIMITER?.limit) {
    const { success } = await env.RPC_RATE_LIMITER.limit({
      key: `balance:${resolveClientIp(request)}`,
    });
    if (!success) {
      return errorResponse(
        "balance_rate_limited",
        "Too many live balance requests from this client; slow down.",
        429,
        {},
        {
          "retry-after": String(BALANCE_RATE_LIMIT.windowSeconds),
          "x-ratelimit-limit": String(BALANCE_RATE_LIMIT.limit),
          "x-ratelimit-policy": `${BALANCE_RATE_LIMIT.limit};w=${BALANCE_RATE_LIMIT.windowSeconds}`,
          "x-ratelimit-remaining": "0",
        },
      );
    }
  }

  const data = await loadAccountBalance(env, ss58);
  return envelopeResponse(
    request,
    { data, meta: { contract_version: contractVersion(env) } },
    "short",
  );
}
// GET /api/v1/blocks: the recent-block feed (newest first), served live from the
// `blocks` D1 tier (#1345 block explorer). ?limit clamp <=100, ?offset. Cold/
// absent store → schema-stable zero (never throws). Reuses the chain-events meta
// (source:"chain-events") since the same first-party poller fills this tier.
export async function handleBlocks(request, env, url) {
  const validationError = validateQueryParams(url, [
    "limit",
    "offset",
    "cursor",
    "author",
    "spec_version",
    "from",
    "to",
    "block_start",
    "block_end",
    "min_extrinsics",
    "min_events",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset, cursor } = parsePagination(url, BLOCK_PAGINATION);
  const sp = url.searchParams;
  // Reject non-integer numeric filters with 400 (mirrors handleExtrinsics / #2274).
  const numericFilters = {};
  for (const param of [
    "block_start",
    "block_end",
    "from",
    "to",
    "min_extrinsics",
    "min_events",
    "spec_version",
  ]) {
    const raw = sp.get(param);
    if (raw === null) continue;
    const parsed = parseNonNegativeIntParam(raw, param);
    if (parsed.error) return analyticsQueryError(parsed.error);
    numericFilters[param] = parsed.value;
  }
  const blockStart = numericFilters.block_start ?? null;
  const blockEnd = numericFilters.block_end ?? null;
  const from = numericFilters.from ?? null;
  const to = numericFilters.to ?? null;
  const minExtrinsics = numericFilters.min_extrinsics ?? null;
  const minEvents = numericFilters.min_events ?? null;

  // Inverted indexed ranges and astronomically high per-block count floors are
  // deterministic no-match cases. Short-circuit them before D1 so public callers
  // cannot amplify cost by forcing scans to prove an impossible empty result.
  if (
    (blockStart != null && blockEnd != null && blockStart > blockEnd) ||
    (from != null && to != null && from > to) ||
    (minExtrinsics != null && minExtrinsics > MAX_BLOCK_COUNT_FILTER) ||
    (minEvents != null && minEvents > MAX_BLOCK_COUNT_FILTER)
  ) {
    const data = buildBlockFeed([], { limit, offset, nextCursor: null });
    return envelopeResponse(
      request,
      {
        data,
        meta: await accountMeta(env, "/metagraph/blocks.json", null),
      },
      "short",
    );
  }

  // Conjunctive (AND-ed) filter set mirroring handleExtrinsics (#1846/#1991):
  // every value is BOUND, never interpolated; no-match filters return an empty
  // feed rather than throwing.
  const conds = [];
  const params = [];
  if (sp.get("author")) {
    conds.push("author = ?");
    params.push(sp.get("author"));
  }
  if (numericFilters.spec_version != null) {
    conds.push("spec_version = ?");
    params.push(numericFilters.spec_version);
  }
  if (blockStart != null) {
    conds.push("block_number >= ?");
    params.push(blockStart);
  }
  if (blockEnd != null) {
    conds.push("block_number <= ?");
    params.push(blockEnd);
  }
  if (from != null) {
    conds.push("observed_at >= ?");
    params.push(from);
  }
  if (to != null) {
    conds.push("observed_at <= ?");
    params.push(to);
  }
  if (minExtrinsics != null) {
    conds.push("extrinsic_count >= ?");
    params.push(minExtrinsics);
  }
  if (minEvents != null) {
    conds.push("event_count >= ?");
    params.push(minEvents);
  }
  // Keyset cursor (#1851) takes precedence over offset: fold its block_number < ?
  // seek into the same conds so it ANDs with the filters (PK-ordered, stable under
  // head inserts). A malformed cursor decodes to null → ignored (falls back to
  // offset), preserving never-throw.
  const cur = decodeCursor(cursor, 1);
  const useCursor = Boolean(cur);
  if (useCursor) {
    conds.push("block_number < ?");
    params.push(cur[0]);
  }
  let sql = `SELECT ${BLOCK_READ_COLUMNS} FROM blocks`;
  if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
  sql += " ORDER BY block_number DESC LIMIT ?";
  params.push(limit);
  if (!useCursor) {
    sql += " OFFSET ?";
    params.push(offset);
  }
  const rows = await d1All(env, sql, params);
  // next_cursor only when the page was full (more rows likely); null at the end.
  const last = rows.length === limit ? rows[rows.length - 1] : null;
  const nextCursor = last ? encodeCursor([last.block_number]) : null;
  const data = buildBlockFeed(rows, { limit, offset, nextCursor });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/blocks.json",
        data.blocks[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/blocks/{ref}: per-block detail (#1345). ref is a numeric
// block_number OR a 0x block_hash. Served live from the `blocks` D1 tier; an
// unknown ref / cold store → 200 with block:null (schema-stable, mirrors the
// neuron detail route — NEVER 404/throw).
export async function handleBlock(request, env, ref) {
  const isHash = /^0x[0-9a-fA-F]{64}$/.test(ref);
  // A non-hash ref must be a strict decimal block_number; anything else (0x-short,
  // 1e3, signs, empty) is a guaranteed miss, never a Number()-coerced wrong row.
  const blockNumber = isHash ? null : strictBlockNumber(ref);
  const sql = isHash
    ? `SELECT ${BLOCK_READ_COLUMNS} FROM blocks WHERE block_hash = ? LIMIT 1`
    : `SELECT ${BLOCK_READ_COLUMNS} FROM blocks WHERE block_number = ? LIMIT 1`;
  // The poller stores hashes lowercase (substrateinterface emits `0x` lowercase)
  // and D1 text columns are BINARY-collated, so a mixed/upper-case 0x ref would
  // miss. Normalize the hash ref to lowercase before binding (same for the block-
  // extrinsics, block-events, and extrinsic handlers below).
  const rows =
    isHash || blockNumber !== null
      ? await d1All(env, sql, [isHash ? ref.toLowerCase() : blockNumber])
      : [];
  // prev/next chain-walk neighbors (#1853): indexed scalar lookups for the
  // nearest STORED block numbers around the resolved height (skips pruned gaps;
  // null at the window edges). Derived from the resolved row's number (works for
  // the hash path too). Only when the block resolved — a cold/unknown ref has no
  // anchor. Keep these as WHERE-bounded subqueries so public detail requests use
  // the block_number primary key instead of scanning the retained blocks table.
  let prev = null;
  let next = null;
  const resolvedNumber = rows[0]?.block_number;
  if (Number.isInteger(resolvedNumber)) {
    const nbr = await d1All(
      env,
      `SELECT (SELECT MAX(block_number) FROM blocks WHERE block_number < ?) AS prev, (SELECT MIN(block_number) FROM blocks WHERE block_number > ?) AS next`,
      [resolvedNumber, resolvedNumber],
    );
    prev = nbr[0]?.prev ?? null;
    next = nbr[0]?.next ?? null;
  }
  const data = buildBlock(rows[0], ref, { prev, next });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/blocks/${ref}.json`,
        data.block?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/blocks/{ref}/extrinsics: the extrinsics in one block (#1845), in
// natural read order (extrinsic_index ASC). ref is a numeric block_number OR a 0x
// block_hash — a hash ref is resolved to its block_number first (idx_blocks_hash),
// then extrinsics are read by the (block_number, extrinsic_index) PK prefix. ?limit
// (<=100) / ?offset. Unknown ref / cold store → 200 with block_number:null +
// extrinsics:[] (schema-stable, never 404).
export async function handleBlockExtrinsics(request, env, ref, url) {
  const validationError = validateQueryParams(url, ["limit", "offset"]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset } = parsePagination(url, BLOCK_PAGINATION);
  const isHash = /^0x[0-9a-fA-F]{64}$/.test(ref);
  const refBlockNumber = isHash ? null : strictBlockNumber(ref);
  const blockRows =
    isHash || refBlockNumber !== null
      ? await d1All(
          env,
          isHash
            ? `SELECT block_number FROM blocks WHERE block_hash = ? LIMIT 1`
            : `SELECT block_number FROM blocks WHERE block_number = ? LIMIT 1`,
          [isHash ? ref.toLowerCase() : refBlockNumber],
        )
      : [];
  const blockNumber = blockRows[0]?.block_number ?? null;
  const rows =
    blockNumber == null
      ? []
      : await d1All(
          env,
          `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics WHERE block_number = ? ORDER BY extrinsic_index ASC LIMIT ? OFFSET ?`,
          [blockNumber, limit, offset],
        );
  const data = buildBlockExtrinsics(rows, ref, blockNumber, { limit, offset });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/blocks/${ref}/extrinsics.json`,
        data.extrinsics[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/blocks/{ref}/events: the decoded chain events in one block (#1852),
// in natural read order (event_index ASC). ref is a numeric block_number OR a 0x
// block_hash — a hash ref is resolved to its block_number first (idx_blocks_hash),
// then events are read by the (block_number, event_index) PK prefix. ?limit
// (<=1000) / ?offset. Unknown ref / cold store → 200 with block_number:null +
// events:[] (schema-stable, never 404). Mirrors handleBlockExtrinsics.
export async function handleBlockEvents(request, env, ref, url) {
  const validationError = validateQueryParams(url, ["limit", "offset"]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset } = parsePagination(url, FEED_PAGINATION);
  const isHash = /^0x[0-9a-fA-F]{64}$/.test(ref);
  const refBlockNumber = isHash ? null : strictBlockNumber(ref);
  const blockRows =
    isHash || refBlockNumber !== null
      ? await d1All(
          env,
          isHash
            ? `SELECT block_number FROM blocks WHERE block_hash = ? LIMIT 1`
            : `SELECT block_number FROM blocks WHERE block_number = ? LIMIT 1`,
          [isHash ? ref.toLowerCase() : refBlockNumber],
        )
      : [];
  const blockNumber = blockRows[0]?.block_number ?? null;
  const rows =
    blockNumber == null
      ? []
      : await d1All(
          env,
          `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events WHERE block_number = ? ORDER BY event_index ASC LIMIT ? OFFSET ?`,
          [blockNumber, limit, offset],
        );
  const data = buildBlockEvents(rows, ref, blockNumber, { limit, offset });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/blocks/${ref}/events.json`,
        data.events[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/extrinsics: the recent-extrinsic feed (newest first), served live
// from the `extrinsics` D1 tier (#1345 block explorer). ?limit clamp <=100,
// ?offset, and a conjunctive (AND-ed) filter set (#1846): ?block=<n>, ?signer=,
// ?call_module=, ?call_function=, ?success=true|false, ?block_start/?block_end
// (block range), ?from/?to (observed_at epoch-ms range). All optional; an inverted
// range simply matches nothing (never throws). Cold/absent store → schema-stable
// zero. Reuses the chain-events meta since the same first-party poller fills this
// tier. The per-row shape is bound, never interpolated.
export async function handleExtrinsics(request, env, url) {
  const validationError = validateQueryParams(url, [
    "limit",
    "offset",
    "cursor",
    "block",
    "signer",
    "call_module",
    "call_function",
    "success",
    "block_start",
    "block_end",
    "from",
    "to",
  ]);
  if (validationError) return analyticsQueryError(validationError);
  const { limit, offset, cursor } = parsePagination(url, BLOCK_PAGINATION);
  const sp = url.searchParams;
  const numericFilters = {};
  for (const param of ["block", "block_start", "block_end", "from", "to"]) {
    const raw = sp.get(param);
    if (raw === null) continue;
    const parsed = parseNonNegativeIntParam(raw, param);
    if (parsed.error) return analyticsQueryError(parsed.error);
    numericFilters[param] = parsed.value;
  }
  const fromMs = numericFilters.from ?? null;
  const toMs = numericFilters.to ?? null;
  const nowMs = Date.now();
  const observedFloorMs = nowMs - EXTRINSIC_RETENTION_MS;
  // The extrinsics tier is a retained hot window of block timestamps. Reject
  // impossible time ranges before D1 so unauthenticated future/expired probes
  // cannot force a primary-key scan just to return an empty page.
  if (
    (fromMs != null && fromMs > nowMs + DAY_MS) ||
    (toMs != null && toMs < observedFloorMs) ||
    (fromMs != null && toMs != null && fromMs > toMs)
  ) {
    const data = buildExtrinsicFeed([], { limit, offset, nextCursor: null });
    return envelopeResponse(
      request,
      {
        data,
        meta: await accountMeta(env, "/metagraph/extrinsics.json", null),
      },
      "short",
    );
  }
  const conds = [];
  const params = [];
  const eq = (col, val) => {
    conds.push(`${col} = ?`);
    params.push(val);
  };
  const hasBlockFilter = numericFilters.block != null;
  const hasEqualityFilter =
    sp.get("signer") || sp.get("call_module") || sp.get("call_function");
  if (hasBlockFilter) eq("block_number", numericFilters.block);
  if (sp.get("signer")) eq("signer", sp.get("signer"));
  if (sp.get("call_module")) eq("call_module", sp.get("call_module"));
  if (sp.get("call_function")) eq("call_function", sp.get("call_function"));
  // success is stored 1/0/NULL; bind the literal so success=false never leaks
  // NULL (undeterminable) rows. Any non-true/false value is ignored.
  const successRaw = sp.get("success");
  const hasSuccessFilter = successRaw === "true" || successRaw === "false";
  if (successRaw === "true") eq("success", 1);
  else if (successRaw === "false") eq("success", 0);
  const hasBlockRangeFilter =
    numericFilters.block_start != null || numericFilters.block_end != null;
  if (numericFilters.block_start != null) {
    conds.push("block_number >= ?");
    params.push(numericFilters.block_start);
  }
  if (numericFilters.block_end != null) {
    conds.push("block_number <= ?");
    params.push(numericFilters.block_end);
  }
  if (fromMs != null) {
    conds.push("observed_at >= ?");
    params.push(fromMs);
  }
  if (toMs != null) {
    conds.push("observed_at <= ?");
    params.push(toMs);
  }
  // Keyset cursor (#1851): a row-value seek on the (block_number, extrinsic_index)
  // PK, ANDed with any active filters. Takes precedence over offset; a malformed
  // cursor decodes to null → ignored. SQLite row-value comparison is PK-covered.
  const cur = decodeCursor(cursor, 2);
  const useCursor = Boolean(cur);
  if (useCursor) {
    conds.push("(block_number, extrinsic_index) < (?, ?)");
    params.push(cur[0], cur[1]);
  }
  // Standalone observed_at windows can be highly selective while the feed order
  // is block_number/extrinsic_index. Force the timestamp index for bounded
  // narrow windows and one-sided ranges whose effective retained window is
  // narrow; broad public filters stay planner-selected so SQLite/D1 can use the
  // order-aligned primary-key path and stop at LIMIT.
  const effectiveFromMs = fromMs ?? observedFloorMs;
  const effectiveToMs = toMs ?? nowMs + DAY_MS;
  const hasNarrowObservedWindow =
    (fromMs != null || toMs != null) &&
    effectiveToMs - effectiveFromMs <= DAY_MS;
  const forceObservedOrderIndex =
    hasNarrowObservedWindow &&
    !hasBlockFilter &&
    !hasEqualityFilter &&
    !hasSuccessFilter &&
    !hasBlockRangeFilter &&
    !useCursor;
  let sql = `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics`;
  if (forceObservedOrderIndex)
    sql += " INDEXED BY idx_extrinsics_observed_order";
  if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
  sql += " ORDER BY block_number DESC, extrinsic_index DESC LIMIT ?";
  params.push(limit);
  if (!useCursor) {
    sql += " OFFSET ?";
    params.push(offset);
  }
  const rows = await d1All(env, sql, params);
  const last = rows.length === limit ? rows[rows.length - 1] : null;
  const nextCursor = last
    ? encodeCursor([last.block_number, last.extrinsic_index])
    : null;
  const data = buildExtrinsicFeed(rows, { limit, offset, nextCursor });
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        "/metagraph/extrinsics.json",
        data.extrinsics[0]?.observed_at ?? null,
      ),
    },
    "short",
  );
}

// GET /api/v1/extrinsics/{ref}: per-extrinsic detail (#1345/#1848). ref is EITHER
// a 0x extrinsic_hash OR the canonical composite id "<block_number>-<extrinsic_index>".
// The hash is best-effort/nullable in the decoder, so the composite id is the
// guaranteed-present identifier; the composite path does a direct (block_number,
// extrinsic_index) PK hit. Served live from the `extrinsics` D1 tier; an unknown
// ref / cold store / malformed composite → 200 with extrinsic:null (schema-stable,
// mirrors handleBlock's numeric-OR-hash branch — NEVER 404/throw).
//
// When the extrinsic resolves, the indexed account_events it emitted (#1849) are
// embedded via a second lookup on (block_number, extrinsic_index) — bounded to 50.
// Empty for pre-migration rows, non-ApplyExtrinsic events, or a cold store.
export async function handleExtrinsic(request, env, ref) {
  const isHash = /^0x[0-9a-fA-F]{64}$/.test(ref);
  let rows;
  if (isHash) {
    rows = await d1All(
      env,
      `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics WHERE extrinsic_hash = ? ORDER BY block_number DESC, extrinsic_index DESC LIMIT 1`,
      [ref.toLowerCase()],
    );
  } else {
    // Composite "<block>-<index>": exactly two strict decimal halves, so a
    // malformed ref (extra segment, empty half, hex, sci-notation) is a clean
    // miss (extrinsic:null) rather than a coerced wrong-but-valid row.
    const composite = COMPOSITE_REF_RE.exec(ref);
    const blockNumber = composite ? Number(composite[1]) : NaN;
    const extrinsicIndex = composite ? Number(composite[2]) : NaN;
    rows =
      composite &&
      Number.isSafeInteger(blockNumber) &&
      Number.isSafeInteger(extrinsicIndex)
        ? await d1All(
            env,
            `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics WHERE block_number = ? AND extrinsic_index = ? LIMIT 1`,
            [blockNumber, extrinsicIndex],
          )
        : [];
  }
  // Embed the emitted events once we have the resolved (block_number,
  // extrinsic_index). A second sequential read; d1All swallows a missing-column
  // error pre-migration → [] (the embed is additive, never breaks the detail).
  let events = [];
  const resolved = rows[0];
  if (
    resolved &&
    resolved.block_number != null &&
    resolved.extrinsic_index != null
  ) {
    const eventRows = await d1All(
      env,
      `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events WHERE block_number = ? AND extrinsic_index = ? ORDER BY event_index ASC LIMIT 50`,
      [resolved.block_number, resolved.extrinsic_index],
    );
    events = eventRows.map(formatAccountEvent).filter(Boolean);
  }
  const data = buildExtrinsic(resolved, ref, events);
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/extrinsics/${ref}.json`,
        data.extrinsic?.observed_at ?? null,
      ),
    },
    "short",
  );
}

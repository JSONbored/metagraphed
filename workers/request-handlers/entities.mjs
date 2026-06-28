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

import { DAY_MS, clampInt, resolveClientIp } from "../config.mjs";

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
  buildCounterparties,
} from "../../src/counterparties.mjs";
import { TURNOVER_READ_COLUMNS, buildTurnover } from "../../src/turnover.mjs";

const MAX_BLOCK_COUNT_FILTER = 1_000_000;

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

export function canonicalSubnetConcentrationHistoryCachePath(url) {
  const validationError = validateQueryParams(url, ["window"]);
  if (validationError) return `${url.pathname}${url.search}`;
  const { label, error } = parseConcentrationHistoryWindow(
    url.searchParams.get("window"),
  );
  if (error) return `${url.pathname}${url.search}`;
  return `${url.pathname}?window=${encodeURIComponent(label)}`;
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
  let boundsSql =
    "SELECT MIN(snapshot_date) AS start_date, MAX(snapshot_date) AS end_date FROM neuron_daily WHERE netuid = ?";
  const boundsParams = [netuid];
  if (days != null) {
    const cutoff = new Date(Date.now() - days * DAY_MS)
      .toISOString()
      .slice(0, 10);
    boundsSql += " AND snapshot_date >= ?";
    boundsParams.push(cutoff);
  }
  const bounds = await d1All(env, boundsSql, boundsParams);
  const startDate = bounds[0]?.start_date ?? null;
  const endDate = bounds[0]?.end_date ?? null;
  const rows =
    startDate == null || endDate == null
      ? []
      : await d1All(
          env,
          `SELECT ${TURNOVER_READ_COLUMNS} FROM neuron_daily WHERE netuid = ? AND snapshot_date IN (?, ?)`,
          [netuid, startDate, endDate],
        );
  const data = buildTurnover(rows, netuid, {
    window: label,
    startDate,
    endDate,
  });
  return envelopeResponse(
    request,
    {
      data,
      meta: await metagraphMeta(
        env,
        `/metagraph/subnets/${netuid}/turnover.json`,
        endDate,
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
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  if ((from && !DAY_RE.test(from)) || (to && !DAY_RE.test(to))) {
    return errorResponse(
      "invalid_param",
      "from/to must be YYYY-MM-DD dates.",
      400,
    );
  }
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
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
  const cur = decodeCursor(url.searchParams.get("cursor"), 2);
  const cursorDay = cur
    ? String(cur[0]).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")
    : null;
  const useCursor = Boolean(cursorDay && DAY_RE.test(cursorDay));
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
    last && typeof last.day === "string" && DAY_RE.test(last.day)
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
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
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
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  // sent => this account is the sender (hotkey=from); received => recipient
  // (coldkey=to); default/all => either side.
  let sideClause = "(hotkey = ? OR coldkey = ?)";
  let sideParams = [ss58, ss58];
  if (direction === "sent") {
    sideClause = "hotkey = ?";
    sideParams = [ss58];
  } else if (direction === "received") {
    sideClause = "coldkey = ?";
    sideParams = [ss58];
  }
  // Keyset (cursor) pagination mirrors loadAccountEvents/handleExtrinsicsFeed: a
  // (block_number, event_index) row-value seek, stable + O(limit) at depth on the
  // large account_events tier. offset stays as a deprecated fallback; cursor wins.
  const cur = decodeCursor(url.searchParams.get("cursor"), 2);
  const useCursor = Boolean(cur);
  const params = [...sideParams];
  let sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events WHERE event_kind = 'Transfer' AND ${sideClause}`;
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
// with — the account's recent account_events Transfers aggregated per counterparty
// into sent / received / net flow + count, ranked by total volume (the address
// "relationship" view). The transfer scan is bounded (newest-first); the summary
// flags truncation. Cold/absent store → 200 with counterparties:[] (schema-stable,
// never 404), mirroring the sibling account routes.
export async function handleAccountCounterparties(request, env, ss58, url) {
  const validationError = validateQueryParams(url, ["limit"]);
  if (validationError) return analyticsQueryError(validationError);
  const limit = clampInt(url.searchParams.get("limit"), 20, 1, 100);
  const rows = await d1All(
    env,
    `SELECT ${COUNTERPARTIES_READ_COLUMNS} FROM account_events WHERE event_kind = 'Transfer' AND (hotkey = ? OR coldkey = ?) ORDER BY block_number DESC LIMIT ?`,
    [ss58, ss58, COUNTERPARTIES_SCAN_CAP],
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
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
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
  const cur = decodeCursor(url.searchParams.get("cursor"), 2);
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

// Bittensor/finney account addresses are SS58-encoded values with network
// prefix 42, a 32-byte account id, and a checksum suffix. The balance route is
// a live RPC fan-out, so reject malformed path captures before any cache/limit
// work. This decoder enforces the base58 alphabet and fixed finney payload
// shape; the RPC limiter below remains the upstream abuse boundary.
const SS58_BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SS58_BASE58_INDEX = new Map(
  [...SS58_BASE58_ALPHABET].map((char, index) => [char, index]),
);
const FINNEY_SS58_PREFIX = 42;
const FINNEY_SS58_MIN_LENGTH = 47;
const FINNEY_SS58_MAX_LENGTH = 48;
const FINNEY_SS58_DECODED_LENGTH = 35;
const BALANCE_KV_TTL = 60; // seconds
const BALANCE_NEGATIVE_KV_TTL = 10; // seconds
const BALANCE_RPC_TIMEOUT_MS = 5000;
const BALANCE_RATE_LIMIT = { limit: 100, windowSeconds: 60 };
const FINNEY_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";

function decodeBase58(value) {
  const bytes = [0];
  for (const char of value) {
    const carryStart = SS58_BASE58_INDEX.get(char);
    if (carryStart == null) return null;
    let carry = carryStart;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const char of value) {
    if (char !== "1") break;
    bytes.push(0);
  }
  return Uint8Array.from(bytes.reverse());
}

function isFinneySs58Address(value) {
  if (
    value.length < FINNEY_SS58_MIN_LENGTH ||
    value.length > FINNEY_SS58_MAX_LENGTH
  ) {
    return false;
  }

  const decoded = decodeBase58(value);
  return (
    decoded?.length === FINNEY_SS58_DECODED_LENGTH &&
    decoded[0] === FINNEY_SS58_PREFIX
  );
}

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

  const cacheKey = `balance:${ss58}`;
  const kv = env.METAGRAPH_CONTROL;

  const respond = (data) =>
    envelopeResponse(
      request,
      { data, meta: { contract_version: contractVersion(env) } },
      "short",
    );

  // KV cache hit — return immediately without touching the RPC.
  if (kv?.get) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached) return respond(cached);
    } catch {
      // KV read failure is non-fatal — fall through to the live RPC.
    }
  }

  const queriedAt = new Date().toISOString();
  let balanceTao = null;
  let rpcOk = false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BALANCE_RPC_TIMEOUT_MS);
  try {
    const rpcResp = await fetch(FINNEY_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "system_account",
        params: [ss58],
      }),
    });
    if (rpcResp.ok) {
      const rpcBody = await rpcResp.json();
      const data = rpcBody?.result?.data;
      if (data && typeof data.free !== "undefined") {
        // free + reserved are hex-encoded u128 rao values (1 TAO = 1e9 rao).
        // Sum in BigInt space and split the whole / fractional TAO only at the
        // end, so a balance above Number.MAX_SAFE_INTEGER rao (~9.007M TAO) keeps
        // its low-order rao digits — a direct Number(BigInt(...)) cast would
        // collapse them to the nearest double *before* the 1e9 scale. A malformed
        // hex `free` still throws here (BigInt parse) and is caught below →
        // balance_tao:null, 200 (unchanged error path).
        const toRao = (v) =>
          typeof v === "string"
            ? BigInt(v)
            : BigInt(Math.trunc(Number(v ?? 0)));
        const totalRao = toRao(data.free) + toRao(data.reserved);
        balanceTao =
          Number(totalRao / 1_000_000_000n) +
          Number(totalRao % 1_000_000_000n) / 1e9;
        rpcOk = true;
      }
    }
  } catch {
    // RPC fetch failed — balance_tao stays null, return 200 below.
  } finally {
    clearTimeout(timeout);
  }

  const data = {
    schema_version: 1,
    ss58,
    balance_tao: balanceTao,
    queried_at: queriedAt,
  };

  if (kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(data), {
        expirationTtl: rpcOk ? BALANCE_KV_TTL : BALANCE_NEGATIVE_KV_TTL,
      });
    } catch {
      // KV write failure is non-fatal.
    }
  }

  return respond(data);
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
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 100);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const sp = url.searchParams;
  const MAX = Number.MAX_SAFE_INTEGER;
  const intParam = (name) => clampInt(sp.get(name), 0, 0, MAX);
  const blockStart =
    sp.get("block_start") != null ? intParam("block_start") : null;
  const blockEnd = sp.get("block_end") != null ? intParam("block_end") : null;
  const from = sp.get("from") != null ? intParam("from") : null;
  const to = sp.get("to") != null ? intParam("to") : null;
  const minExtrinsics =
    sp.get("min_extrinsics") != null ? intParam("min_extrinsics") : null;
  const minEvents =
    sp.get("min_events") != null ? intParam("min_events") : null;

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
  if (sp.get("spec_version") != null) {
    conds.push("spec_version = ?");
    params.push(clampInt(sp.get("spec_version"), 0, 0, MAX));
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
  const cur = decodeCursor(url.searchParams.get("cursor"), 1);
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
  const sql = isHash
    ? `SELECT ${BLOCK_READ_COLUMNS} FROM blocks WHERE block_hash = ? LIMIT 1`
    : `SELECT ${BLOCK_READ_COLUMNS} FROM blocks WHERE block_number = ? LIMIT 1`;
  // The poller stores hashes lowercase (substrateinterface emits `0x` lowercase)
  // and D1 text columns are BINARY-collated, so a mixed/upper-case 0x ref would
  // miss. Normalize the hash ref to lowercase before binding (same for the block-
  // extrinsics, block-events, and extrinsic handlers below).
  const param = isHash ? ref.toLowerCase() : Number(ref);
  const rows = await d1All(env, sql, [param]);
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
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 100);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const isHash = /^0x[0-9a-fA-F]{64}$/.test(ref);
  const blockRows = await d1All(
    env,
    isHash
      ? `SELECT block_number FROM blocks WHERE block_hash = ? LIMIT 1`
      : `SELECT block_number FROM blocks WHERE block_number = ? LIMIT 1`,
    [isHash ? ref.toLowerCase() : Number(ref)],
  );
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
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const isHash = /^0x[0-9a-fA-F]{64}$/.test(ref);
  const blockRows = await d1All(
    env,
    isHash
      ? `SELECT block_number FROM blocks WHERE block_hash = ? LIMIT 1`
      : `SELECT block_number FROM blocks WHERE block_number = ? LIMIT 1`,
    [isHash ? ref.toLowerCase() : Number(ref)],
  );
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
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 100);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const sp = url.searchParams;
  const MAX = Number.MAX_SAFE_INTEGER;
  const parseTimeBound = (raw) => {
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.min(MAX, Math.trunc(n)));
  };
  const fromMs = parseTimeBound(sp.get("from"));
  const toMs = parseTimeBound(sp.get("to"));
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
  const hasBlockFilter = sp.get("block") != null;
  const hasEqualityFilter =
    sp.get("signer") || sp.get("call_module") || sp.get("call_function");
  if (hasBlockFilter) eq("block_number", clampInt(sp.get("block"), 0, 0, MAX));
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
    sp.get("block_start") != null || sp.get("block_end") != null;
  if (sp.get("block_start") != null) {
    conds.push("block_number >= ?");
    params.push(clampInt(sp.get("block_start"), 0, 0, MAX));
  }
  if (sp.get("block_end") != null) {
    conds.push("block_number <= ?");
    params.push(clampInt(sp.get("block_end"), 0, 0, MAX));
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
  const cur = decodeCursor(sp.get("cursor"), 2);
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
    // Composite "<block>-<index>": coerce both halves; a non-finite half is a
    // miss (extrinsic:null), never a bad bind.
    const [b, i] = ref.split("-");
    const blockNumber = Number(b);
    const extrinsicIndex = Number(i);
    rows =
      Number.isInteger(blockNumber) && Number.isInteger(extrinsicIndex)
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

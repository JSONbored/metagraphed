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
  sql += " ORDER BY day DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  const rows = await d1All(env, sql, params);
  const data = buildAccountHistory(rows, ss58, { limit, offset });
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
  const rows = await d1All(
    env,
    `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events WHERE event_kind = 'Transfer' AND ${sideClause} ORDER BY block_number DESC, event_index DESC LIMIT ? OFFSET ?`,
    [...sideParams, limit, offset],
  );
  const data = buildAccountTransfers(rows, ss58, { limit, offset });
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
  const validationError = validateQueryParams(url, ["kind", "limit", "offset"]);
  if (validationError) return analyticsQueryError(validationError);
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const kind = url.searchParams.get("kind");
  const params = [netuid];
  let sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events WHERE netuid = ?`;
  if (kind) {
    sql += " AND event_kind = ?";
    params.push(kind);
  }
  sql += " ORDER BY block_number DESC, event_index DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  const rows = await d1All(env, sql, params);
  const data = buildSubnetEvents(rows, netuid, { limit, offset });
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
        const freeRao =
          typeof data.free === "string"
            ? Number(BigInt(data.free))
            : Number(data.free);
        const reservedRao =
          typeof data.reserved === "string"
            ? Number(BigInt(data.reserved))
            : Number(data.reserved ?? 0);
        balanceTao = (freeRao + reservedRao) / 1e9;
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
  // Conjunctive (AND-ed) filter set mirroring handleExtrinsics (#1846/#1991):
  // every value is BOUND, never interpolated; an inverted range or an absent
  // nullable column simply matches nothing — never a throw.
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
  if (sp.get("block_start") != null) {
    conds.push("block_number >= ?");
    params.push(clampInt(sp.get("block_start"), 0, 0, MAX));
  }
  if (sp.get("block_end") != null) {
    conds.push("block_number <= ?");
    params.push(clampInt(sp.get("block_end"), 0, 0, MAX));
  }
  if (sp.get("from") != null) {
    conds.push("observed_at >= ?");
    params.push(clampInt(sp.get("from"), 0, 0, MAX));
  }
  if (sp.get("to") != null) {
    conds.push("observed_at <= ?");
    params.push(clampInt(sp.get("to"), 0, 0, MAX));
  }
  if (sp.get("min_extrinsics") != null) {
    conds.push("extrinsic_count >= ?");
    params.push(clampInt(sp.get("min_extrinsics"), 0, 0, MAX));
  }
  if (sp.get("min_events") != null) {
    conds.push("event_count >= ?");
    params.push(clampInt(sp.get("min_events"), 0, 0, MAX));
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
  const param = isHash ? ref : Number(ref);
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
    [isHash ? ref : Number(ref)],
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
  let blockNumber = isHash ? null : Number(ref);
  if (isHash) {
    const blockRows = await d1All(
      env,
      `SELECT block_number FROM blocks WHERE block_hash = ? LIMIT 1`,
      [ref],
    );
    blockNumber = blockRows[0]?.block_number ?? null;
  }
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
  const fromRaw = sp.get("from");
  const toRaw = sp.get("to");
  const fromMs = fromRaw == null ? null : clampInt(fromRaw, 0, 0, MAX);
  const toMs = toRaw == null ? null : clampInt(toRaw, 0, 0, MAX);
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
  // Standalone observed_at ranges can be highly selective or empty while the
  // feed order is block_number/extrinsic_index. Force the covering timestamp
  // index for that public unauthenticated case so D1 cannot satisfy ORDER BY by
  // walking most of the retained primary-key order before finding no rows.
  const forceObservedOrderIndex =
    (fromMs != null || toMs != null) &&
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
      [ref],
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

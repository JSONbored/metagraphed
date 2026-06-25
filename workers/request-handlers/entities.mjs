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

import { DAY_MS } from "../config.mjs";
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
  buildAccountEvents,
  buildAccountSubnets,
  buildAccountSummary,
} from "../../src/account-events.mjs";
import {
  BLOCK_READ_COLUMNS,
  buildBlock,
  buildBlockFeed,
} from "../../src/blocks.mjs";
import {
  EXTRINSIC_READ_COLUMNS,
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
function clampInt(raw, def, min, max) {
  if (raw == null || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

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
  const where = "hotkey = ? OR coldkey = ?";
  const [aggRows, kindRows, regRows, recentRows, activityRows, moduleRows] =
    await Promise.all([
      d1All(
        env,
        `SELECT COUNT(*) AS c, COUNT(DISTINCT netuid) AS sc, MIN(block_number) AS fb, MAX(block_number) AS lb, MIN(observed_at) AS fo, MAX(observed_at) AS lo FROM account_events WHERE ${where}`,
        [ss58, ss58],
      ),
      d1All(
        env,
        `SELECT event_kind AS kind, COUNT(*) AS count FROM account_events WHERE ${where} GROUP BY event_kind ORDER BY count DESC`,
        [ss58, ss58],
      ),
      d1All(
        env,
        `SELECT netuid, uid, stake_tao, validator_permit, active FROM neurons WHERE hotkey = ? ORDER BY stake_tao DESC`,
        [ss58],
      ),
      d1All(
        env,
        `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events WHERE ${where} ORDER BY block_number DESC, event_index DESC LIMIT 10`,
        [ss58, ss58],
      ),
      // Signing activity (#1847): aggregates from the extrinsics tier by signer
      // (idx_extrinsics_signer). Single [ss58] bind. Hot-window-bounded, not
      // all-time. Matched by signer only — see formatAccountActivity.
      d1All(
        env,
        `SELECT COUNT(*) AS tx_count, MAX(block_number) AS last_tx_block, MAX(observed_at) AS last_tx_at, SUM(fee_tao) AS total_fee_tao FROM extrinsics WHERE signer = ?`,
        [ss58],
      ),
      d1All(
        env,
        `SELECT call_module, COUNT(*) AS count FROM extrinsics WHERE signer = ? GROUP BY call_module ORDER BY count DESC LIMIT 10`,
        [ss58],
      ),
    ]);
  const data = buildAccountSummary(ss58, {
    agg: aggRows[0],
    kinds: kindRows,
    registrations: regRows,
    recent: recentRows,
    activity: activityRows[0],
    modules: moduleRows,
  });
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
  const validationError = validateQueryParams(url, ["kind", "limit", "offset"]);
  if (validationError) return analyticsQueryError(validationError);
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const kind = url.searchParams.get("kind");
  const params = [ss58, ss58];
  let sql = `SELECT ${ACCOUNT_EVENT_COLUMNS} FROM account_events WHERE (hotkey = ? OR coldkey = ?)`;
  if (kind) {
    sql += " AND event_kind = ?";
    params.push(kind);
  }
  sql += " ORDER BY block_number DESC, event_index DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  const rows = await d1All(env, sql, params);
  const data = buildAccountEvents(rows, ss58, { limit, offset });
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

// GET /api/v1/accounts/{ss58}/subnets: the subnets where this hotkey is currently
// registered (the cross-subnet footprint), from the neurons tier.
export async function handleAccountSubnets(request, env, ss58) {
  const rows = await d1All(
    env,
    `SELECT netuid, uid, stake_tao, validator_permit, active FROM neurons WHERE hotkey = ? ORDER BY netuid`,
    [ss58],
  );
  const data = buildAccountSubnets(rows, ss58);
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

// Basic ss58 guard: Bittensor hotkeys start with '5', base58 chars, 47-48 chars.
// The ACCOUNT_BALANCE_PATH_PATTERN captures any non-slash segment so this check
// is the first-pass validity gate before the RPC call.
const SS58_GUARD = /^5[a-zA-Z0-9]{46,47}$/;
const BALANCE_KV_TTL = 60; // seconds
const FINNEY_RPC_URL = "https://entrypoint-finney.opentensor.ai:443";

// GET /api/v1/accounts/{ss58}/balance (#1818): live TAO balance (free+reserved)
// for one account, queried from the finney RPC at request time. 60s KV cache via
// METAGRAPH_CONTROL. Returns 400 on invalid ss58; 200 with balance_tao:null on
// RPC failure (schema-stable, consistent with blocks/extrinsics null-on-miss).
// Served through the shared envelopeResponse so it carries the same ok/data
// envelope, weak ETag, contract-version header, and 304/HEAD handling as every
// other route — the body matches the AccountBalanceArtifact data schema.
export async function handleAccountBalance(request, env, ss58) {
  if (!SS58_GUARD.test(ss58)) {
    return errorResponse(
      "invalid_ss58",
      "ss58 address must start with '5' and be 47-48 alphanumeric characters.",
      400,
    );
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

  try {
    const rpcResp = await fetch(FINNEY_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  }

  const data = {
    schema_version: 1,
    ss58,
    balance_tao: balanceTao,
    queried_at: queriedAt,
  };

  // Cache only on success so a transient RPC failure doesn't poison the cache.
  if (rpcOk && kv?.put) {
    try {
      await kv.put(cacheKey, JSON.stringify(data), {
        expirationTtl: BALANCE_KV_TTL,
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
  const validationError = validateQueryParams(url, ["limit", "offset"]);
  if (validationError) return analyticsQueryError(validationError);
  const limit = clampInt(url.searchParams.get("limit"), 50, 1, 100);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 1_000_000);
  const rows = await d1All(
    env,
    `SELECT ${BLOCK_READ_COLUMNS} FROM blocks ORDER BY block_number DESC LIMIT ? OFFSET ?`,
    [limit, offset],
  );
  const data = buildBlockFeed(rows, { limit, offset });
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
  const data = buildBlock(rows[0], ref);
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
  const conds = [];
  const params = [];
  const eq = (col, val) => {
    conds.push(`${col} = ?`);
    params.push(val);
  };
  if (sp.get("block") != null)
    eq("block_number", clampInt(sp.get("block"), 0, 0, MAX));
  if (sp.get("signer")) eq("signer", sp.get("signer"));
  if (sp.get("call_module")) eq("call_module", sp.get("call_module"));
  if (sp.get("call_function")) eq("call_function", sp.get("call_function"));
  // success is stored 1/0/NULL; bind the literal so success=false never leaks
  // NULL (undeterminable) rows. Any non-true/false value is ignored.
  const successRaw = sp.get("success");
  if (successRaw === "true") eq("success", 1);
  else if (successRaw === "false") eq("success", 0);
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
  let sql = `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics`;
  if (conds.length) sql += ` WHERE ${conds.join(" AND ")}`;
  sql += " ORDER BY block_number DESC, extrinsic_index DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);
  const rows = await d1All(env, sql, params);
  const data = buildExtrinsicFeed(rows, { limit, offset });
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

// GET /api/v1/extrinsics/{hash}: per-extrinsic detail (#1345). hash is a 0x
// extrinsic_hash. Served live from the `extrinsics` D1 tier; an unknown hash /
// cold store → 200 with extrinsic:null (schema-stable, mirrors the block detail
// route — NEVER 404/throw).
export async function handleExtrinsic(request, env, hash) {
  const rows = await d1All(
    env,
    `SELECT ${EXTRINSIC_READ_COLUMNS} FROM extrinsics WHERE extrinsic_hash = ? ORDER BY block_number DESC, extrinsic_index DESC LIMIT 1`,
    [hash],
  );
  const data = buildExtrinsic(rows[0], hash);
  return envelopeResponse(
    request,
    {
      data,
      meta: await accountMeta(
        env,
        `/metagraph/extrinsics/${hash}.json`,
        data.extrinsic?.observed_at ?? null,
      ),
    },
    "short",
  );
}

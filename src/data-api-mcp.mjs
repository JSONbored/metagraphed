// MCP helpers for the Postgres-backed all-events tier (ADR 0013), reached through
// the DATA_API service binding — the same path REST proxy routes use. Keeps the
// postgres.js driver out of the main Worker bundle.

function throwToolError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  throw error;
}

const CHAIN_EVENTS_LIMIT_DEFAULT = 50;
const CHAIN_EVENTS_LIMIT_MAX = 200;

function clampChainEventsLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return CHAIN_EVENTS_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.floor(n), 1), CHAIN_EVENTS_LIMIT_MAX);
}

// Blocks-window validator shared by MCP get_chain_activity and GraphQL
// Query.chain_events_stats (#7432): a missing window defaults to 1000, a
// non-positive-integer window is an invalid_params error, and the window is
// clamped to the 5000-block maximum. Colocated with loadChainActivity below so
// both callers reuse one validator instead of duplicating it.
export function optionalBlocksWindow(args) {
  const value = args?.blocks;
  if (value === undefined || value === null) return 1000;
  if (!Number.isInteger(value) || value < 1) {
    throwToolError(
      "invalid_params",
      "Argument `blocks` must be a positive integer.",
    );
  }
  return Math.min(value, 5000);
}

// The data Worker returns `{ error: "..." }` on 400; some envelopes use
// `{ error: { message } }` or a top-level `message` instead.
function dataApiErrorMessage(body) {
  if (typeof body?.error === "string" && body.error) return body.error;
  if (typeof body?.error?.message === "string" && body.error.message)
    return body.error.message;
  if (typeof body?.message === "string" && body.message) return body.message;
  return null;
}

// REST all-events routes use `count`; tolerate legacy/alternate `event_count`.
function eventCountFromDataApi(data) {
  if (data?.count != null) return data.count;
  if (data?.event_count != null) return data.event_count;
  return Array.isArray(data?.events) ? data.events.length : 0;
}

export async function dataApiFetchJson(ctx, pathAndQuery) {
  if (ctx.env?.DATA_RATE_LIMITER?.limit) {
    const { success } = await ctx.env.DATA_RATE_LIMITER.limit({
      key: `data:${ctx.clientIp}`,
    });
    if (!success) {
      throwToolError(
        "data_rate_limited",
        "Too many data API requests from this client; slow down.",
      );
    }
  }

  const dataApi = ctx.env?.DATA_API;
  if (!dataApi?.fetch) {
    throwToolError(
      "tier_unavailable",
      "The all-events data tier is unavailable (the data Worker is not bound to " +
        "this deployment). Try again against the production endpoint.",
    );
  }

  let response;
  try {
    response = await dataApi.fetch(new Request(`https://d${pathAndQuery}`));
  } catch {
    throwToolError(
      "tier_unavailable",
      "The all-events data tier could not be reached. Try again shortly.",
    );
  }

  if (response.status === 400) {
    let message = "Invalid request to the all-events data tier.";
    try {
      const body = await response.json();
      message = dataApiErrorMessage(body) ?? message;
    } catch {
      /* ignore */
    }
    throwToolError("invalid_params", message);
  }

  if (!response.ok) {
    throwToolError(
      "tier_unavailable",
      `The all-events data tier returned an error (status ${response.status}). ` +
        "Try again shortly.",
    );
  }

  try {
    return await response.json();
  } catch {
    throwToolError(
      "tier_unavailable",
      "The all-events data tier returned a malformed response. Try again shortly.",
    );
  }
}

export async function loadBlockChainEvents(ctx, blockNumber) {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throwToolError(
      "invalid_params",
      "block_number must be a non-negative integer.",
    );
  }
  const data = await dataApiFetchJson(
    ctx,
    `/api/v1/blocks/${blockNumber}/chain-events`,
  );
  return {
    schema_version: 1,
    block_number: data?.block_number ?? blockNumber,
    event_count: eventCountFromDataApi(data),
    events: Array.isArray(data?.events) ? data.events : [],
  };
}

const COMPOSITE_REF_RE = /^(\d+)-(\d+)$/;

export async function loadExtrinsicChainEvents(
  ctx,
  ref,
  { limit, cursor } = {},
) {
  const composite = COMPOSITE_REF_RE.exec(String(ref));
  const blockNumber = composite ? Number(composite[1]) : NaN;
  const extrinsicIndex = composite ? Number(composite[2]) : NaN;
  if (
    !composite ||
    !Number.isSafeInteger(blockNumber) ||
    !Number.isSafeInteger(extrinsicIndex)
  ) {
    throwToolError(
      "invalid_params",
      "ref must be the composite id 'block_number-extrinsic_index' (e.g. '4200000-3').",
    );
  }
  const lim = clampChainEventsLimit(limit);
  let path =
    `/api/v1/chain-events?block=${blockNumber}` +
    `&extrinsic=${extrinsicIndex}&limit=${lim}`;
  if (cursor) path += `&cursor=${encodeURIComponent(String(cursor))}`;
  const data = await dataApiFetchJson(ctx, path);
  return {
    schema_version: 1,
    ref,
    block_number: blockNumber,
    extrinsic_index: extrinsicIndex,
    limit: lim,
    event_count: eventCountFromDataApi(data),
    next_cursor: data?.next_cursor ?? null,
    events: Array.isArray(data?.events) ? data.events : [],
  };
}

// One page of the raw recent chain-events feed (newest first) — same DATA_API
// path REST's /api/v1/chain-events proxy and MCP list_chain_events use.
// Optional pallet/method/block/extrinsic filters + opaque keyset cursor (or
// legacy before=block_number); the data Worker validates the filter combo and
// returns 400, surfaced here as invalid_params.
export async function loadChainEventsFeed(
  ctx,
  { pallet, method, block, extrinsic, cursor, before, limit } = {},
) {
  const parts = [];
  if (pallet != null) parts.push(`pallet=${encodeURIComponent(pallet)}`);
  if (method != null) parts.push(`method=${encodeURIComponent(method)}`);
  if (block != null) parts.push(`block=${encodeURIComponent(block)}`);
  if (extrinsic != null)
    parts.push(`extrinsic=${encodeURIComponent(extrinsic)}`);
  if (cursor != null) parts.push(`cursor=${encodeURIComponent(cursor)}`);
  else if (before != null) parts.push(`before=${encodeURIComponent(before)}`);
  if (limit != null) parts.push(`limit=${encodeURIComponent(limit)}`);
  const qs = parts.length ? `?${parts.join("&")}` : "";
  const data = await dataApiFetchJson(ctx, `/api/v1/chain-events${qs}`);
  return {
    count: data?.count ?? 0,
    next_before: data?.next_before ?? null,
    next_cursor: data?.next_cursor ?? null,
    events: Array.isArray(data?.events) ? data.events : [],
  };
}

// Chain-activity aggregate (pallet.method event distribution) over the most
// recent N blocks, from the Postgres-backed all-events tier via the DATA_API
// binding -- the same path loadChainEventsFeed uses for the raw feed. Shared by
// MCP get_chain_activity and GraphQL Query.chain_events_stats (#7432); the
// caller applies optionalBlocksWindow first.
export async function loadChainActivity(ctx, blocks) {
  const data = await dataApiFetchJson(
    ctx,
    `/api/v1/chain-events/stats?blocks=${blocks}`,
  );
  return {
    window_blocks: data?.window_blocks ?? blocks,
    groups: data?.groups ?? 0,
    activity: Array.isArray(data?.activity) ? data.activity : [],
  };
}

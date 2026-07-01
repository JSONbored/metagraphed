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

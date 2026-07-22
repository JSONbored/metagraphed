// MCP helpers for the Postgres-backed all-events tier (ADR 0013), reached through
// the DATA_API service binding — the same path REST proxy routes use. Keeps the
// postgres.js driver out of the main Worker bundle.

interface DataApiToolError extends Error {
  toolError: true;
  code: string;
}

function throwToolError(code: string, message: string): never {
  const error = new Error(message) as DataApiToolError;
  error.toolError = true;
  error.code = code;
  throw error;
}

const CHAIN_EVENTS_LIMIT_DEFAULT = 50;
const CHAIN_EVENTS_LIMIT_MAX = 200;

function clampChainEventsLimit(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return CHAIN_EVENTS_LIMIT_DEFAULT;
  return Math.min(Math.max(Math.floor(n), 1), CHAIN_EVENTS_LIMIT_MAX);
}

// The data Worker returns `{ error: "..." }` on 400; some envelopes use
// `{ error: { message } }` or a top-level `message` instead.
function dataApiErrorMessage(body: unknown): string | null {
  const record = body as
    { error?: unknown; message?: unknown } | null | undefined;
  if (typeof record?.error === "string" && record.error) return record.error;
  const errorMessage = (record?.error as { message?: unknown } | undefined)
    ?.message;
  if (typeof errorMessage === "string" && errorMessage) return errorMessage;
  if (typeof record?.message === "string" && record.message)
    return record.message;
  return null;
}

// REST all-events routes use `count`; tolerate legacy/alternate `event_count`.
function eventCountFromDataApi(data: unknown): unknown {
  const record = data as
    | { count?: unknown; event_count?: unknown; events?: unknown }
    | null
    | undefined;
  if (record?.count != null) return record.count;
  if (record?.event_count != null) return record.event_count;
  return Array.isArray(record?.events) ? record.events.length : 0;
}

export interface DataApiMcpContext {
  env: Env;
  clientIp?: string;
}

export async function dataApiFetchJson(
  ctx: DataApiMcpContext,
  pathAndQuery: string,
): Promise<unknown> {
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

  let response: Response;
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

export async function loadBlockChainEvents(
  ctx: DataApiMcpContext,
  blockNumber: number,
): Promise<{
  schema_version: 1;
  block_number: unknown;
  event_count: unknown;
  events: unknown[];
}> {
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throwToolError(
      "invalid_params",
      "block_number must be a non-negative integer.",
    );
  }
  const data = (await dataApiFetchJson(
    ctx,
    `/api/v1/blocks/${blockNumber}/chain-events`,
  )) as { block_number?: unknown; events?: unknown } | null | undefined;
  return {
    schema_version: 1,
    block_number: data?.block_number ?? blockNumber,
    event_count: eventCountFromDataApi(data),
    events: Array.isArray(data?.events) ? data.events : [],
  };
}

const COMPOSITE_REF_RE = /^(\d+)-(\d+)$/;

export async function loadExtrinsicChainEvents(
  ctx: DataApiMcpContext,
  ref: unknown,
  { limit, cursor }: { limit?: unknown; cursor?: unknown } = {},
): Promise<{
  schema_version: 1;
  ref: unknown;
  block_number: number;
  extrinsic_index: number;
  limit: number;
  event_count: unknown;
  next_cursor: unknown;
  events: unknown[];
}> {
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
  const data = (await dataApiFetchJson(ctx, path)) as
    { next_cursor?: unknown; events?: unknown } | null | undefined;
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
  ctx: DataApiMcpContext,
  {
    pallet,
    method,
    block,
    extrinsic,
    cursor,
    before,
    limit,
  }: {
    pallet?: unknown;
    method?: unknown;
    block?: unknown;
    extrinsic?: unknown;
    cursor?: unknown;
    before?: unknown;
    limit?: unknown;
  } = {},
): Promise<{
  count: unknown;
  next_before: unknown;
  next_cursor: unknown;
  events: unknown[];
}> {
  const parts: string[] = [];
  if (pallet != null)
    parts.push(`pallet=${encodeURIComponent(String(pallet))}`);
  if (method != null)
    parts.push(`method=${encodeURIComponent(String(method))}`);
  if (block != null) parts.push(`block=${encodeURIComponent(String(block))}`);
  if (extrinsic != null)
    parts.push(`extrinsic=${encodeURIComponent(String(extrinsic))}`);
  if (cursor != null)
    parts.push(`cursor=${encodeURIComponent(String(cursor))}`);
  else if (before != null)
    parts.push(`before=${encodeURIComponent(String(before))}`);
  if (limit != null) parts.push(`limit=${encodeURIComponent(String(limit))}`);
  const qs = parts.length ? `?${parts.join("&")}` : "";
  const data = (await dataApiFetchJson(ctx, `/api/v1/chain-events${qs}`)) as
    | {
        count?: unknown;
        next_before?: unknown;
        next_cursor?: unknown;
        events?: unknown;
      }
    | null
    | undefined;
  return {
    count: data?.count ?? 0,
    next_before: data?.next_before ?? null,
    next_cursor: data?.next_cursor ?? null,
    events: Array.isArray(data?.events) ? data.events : [],
  };
}

// The optional `blocks` window for the chain-events/stats aggregate: a missing
// value defaults to 1000; a provided value must be a positive integer and is
// clamped to the data Worker's 1-5000 bound so a stray large value is silently
// capped (the data Worker clamps too, but capping here keeps the request URL
// honest). Shared by MCP's get_chain_activity and GraphQL's chain_events_stats.
export function optionalBlocksWindow(
  args: Record<string, unknown> | null | undefined,
): number {
  const value = args?.blocks;
  if (value === undefined || value === null) return 1000;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throwToolError(
      "invalid_params",
      "Argument `blocks` must be a positive integer.",
    );
  }
  return Math.min(value, 5000);
}

// Chain-activity aggregate (pallet.method event distribution) over the most
// recent N blocks, from the Postgres-backed all-events tier via the DATA_API
// binding — the same path REST's /api/v1/chain-events/stats proxy uses, and the
// stats sibling of loadChainEventsFeed's raw feed above. Shared by MCP's
// get_chain_activity and GraphQL's chain_events_stats.
export async function loadChainActivity(
  ctx: DataApiMcpContext,
  blocks: number,
): Promise<{ window_blocks: unknown; groups: unknown; activity: unknown[] }> {
  const data = (await dataApiFetchJson(
    ctx,
    `/api/v1/chain-events/stats?blocks=${blocks}`,
  )) as
    | { window_blocks?: unknown; groups?: unknown; activity?: unknown }
    | null
    | undefined;
  return {
    window_blocks: data?.window_blocks ?? blocks,
    groups: data?.groups ?? 0,
    activity: Array.isArray(data?.activity) ? data.activity : [],
  };
}

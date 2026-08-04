// MCP helpers for the all-events tier -- the same store REST's chain-events
// family reads, reached the same way.
//
// It used to be Postgres behind the DATA_API service binding (ADR 0013). That
// store was destroyed (#9186 unbound HYPERDRIVE, #9193 deleted the reader), and
// because REST had a lakehouse ladder below its forward while MCP and GraphQL
// did not, REST kept serving while `list_chain_events` and `get_chain_activity`
// answered `tier_unavailable` in production -- one broken surface hidden behind
// a working one. #8700 points all three at the lakehouse readers.
//
// What still goes through DATA_API here is everything backed by D1 (user state,
// the neurons families); that binding is alive, just not for chain events.

import { chainDetailGapMessage } from "./chain-detail-hot-tier.ts";
import { hotTierBlockChainEvents } from "./chain-events-degraded.ts";
import {
  chainEventsQueryError,
  loadChainEventsColdTier,
  loadChainEventsStatsColdTier,
} from "./chain-events-cold-tier.ts";
import { type ChainNetworkId, DEFAULT_CHAIN_NETWORK } from "./chain-network.ts";

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
  clientIp?: string | null;
}

/**
 * The per-client data-tier rate limit.
 *
 * Its own function because it gates the CALLER, not the store: the chain-events
 * loaders below read the lakehouse rather than DATA_API, and leaving the limit
 * inside `dataApiFetchJson` would have quietly exempted them the moment they
 * stopped making that call.
 */
async function enforceDataRateLimit(ctx: DataApiMcpContext): Promise<void> {
  if (!ctx.env?.DATA_RATE_LIMITER?.limit) return;
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

export async function dataApiFetchJson(
  ctx: DataApiMcpContext,
  pathAndQuery: string,
): Promise<unknown> {
  await enforceDataRateLimit(ctx);

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
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
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
  await enforceDataRateLimit(ctx);
  // #9208: the D1 hot tier owns everything above the decode seam and the
  // lakehouse everything at or below it -- the SAME tiered read REST's
  // /blocks/{n}/chain-events performs, through the same function, so the two
  // surfaces cannot disagree about a block. A gap between the tiers DECLINES
  // here exactly as it does over REST: an agent handed `events: []` for a block
  // with 400 of them will reason from it, and will not think to retry in an
  // hour the way a person clicking a page might.
  //
  // There is no DATA_API leg below this any more (#8700). There used to be, and
  // for every block the tiers could not cover it could only answer 503 -- its
  // Postgres store was destroyed in #9186/#9193.
  const answer = await hotTierBlockChainEvents(
    ctx.env,
    new URL(`https://data.invalid/api/v1/blocks/${blockNumber}/chain-events`),
    network,
  );
  if (answer?.kind === "gap")
    throwToolError("block_detail_unavailable", chainDetailGapMessage(answer));
  // A MISS is not an empty block. Neither tier covers this height -- above the
  // chain head, below the decoded floor, or the store is unreachable -- and
  // saying so is what the DATA_API leg's 503 used to say. Returning
  // `events: []` would be indistinguishable from a genuinely quiet block, which
  // is the whole failure #9260 exists about.
  if (!answer || answer.kind !== "answer") {
    throwToolError(
      "tier_unavailable",
      "The all-events tier does not cover this block. Try again shortly, or " +
        "check that the height is within this network's decoded range.",
    );
  }
  return {
    schema_version: 1,
    block_number: answer.data.block_number,
    event_count: answer.data.count,
    events: answer.data.events,
  };
}

const COMPOSITE_REF_RE = /^(\d+)-(\d+)$/;

export async function loadExtrinsicChainEvents(
  ctx: DataApiMcpContext,
  ref: unknown,
  { limit, cursor }: { limit?: unknown; cursor?: unknown } = {},
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
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
  // Through the feed loader rather than a hand-built query: a single-block,
  // single-extrinsic lookup is the SAME read with two filters, and composing it
  // here kept a second copy of the limit/cursor semantics alive that could
  // drift from the feed's.
  const page = await loadChainEventsFeed(
    ctx,
    {
      block: blockNumber,
      extrinsic: extrinsicIndex,
      limit: lim,
      cursor: cursor ?? undefined,
    },
    network,
  );
  return {
    schema_version: 1,
    ref,
    block_number: blockNumber,
    extrinsic_index: extrinsicIndex,
    limit: lim,
    event_count: eventCountFromDataApi(page),
    next_cursor: page.next_cursor ?? null,
    events: page.events,
  };
}

/**
 * One page of the raw recent chain-events feed (newest first) -- the same
 * lakehouse reader REST's /api/v1/chain-events serves from, so the two surfaces
 * cannot disagree about what the feed contains.
 *
 * Optional pallet/method/block/extrinsic filters plus an opaque keyset cursor
 * (or the legacy before=block_number). A filter the reader cannot express
 * safely makes it DECLINE rather than silently widen the feed to everything,
 * which surfaces here as invalid_params.
 */
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
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<{
  count: unknown;
  next_before: unknown;
  next_cursor: unknown;
  events: unknown[];
}> {
  await enforceDataRateLimit(ctx);
  const query = {
    // Clamped to THIS surface's published 1-200 bound, not REST's 1-100: both
    // are already public API, and the reader takes the caller's word.
    limit: clampChainEventsLimit(limit),
    pallet,
    method,
    block,
    extrinsic,
    // A cursor supersedes `before`, exactly as the REST route composes them.
    cursor,
    before: cursor == null ? before : undefined,
  };
  // A filter this tier cannot express is the CALLER's error, distinct from an
  // unreachable tier -- the reader returns null for both, so the two are told
  // apart here rather than reported as one.
  const invalid = chainEventsQueryError(query);
  if (invalid) {
    throwToolError(
      "invalid_params",
      `Argument \`${invalid}\` is not a usable value for this feed.`,
    );
  }
  const page = await loadChainEventsColdTier(ctx.env, query, network);
  if (!page) {
    throwToolError(
      "tier_unavailable",
      "The all-events tier could not answer this query. A filter may be " +
        "unusable, or the lakehouse may be unreachable; try again shortly.",
    );
  }
  return {
    count: page.count,
    next_before: page.next_before,
    next_cursor: page.next_cursor,
    events: page.events,
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

/**
 * Chain-activity aggregate (pallet.method event distribution) over the most
 * recent N blocks -- the stats sibling of `loadChainEventsFeed` above, reading
 * the same lakehouse table REST's /api/v1/chain-events/stats does.
 *
 * "Most recent" means the most recent that network's decode lane has published,
 * which is why the reader resolves the window's top from the watermark rather
 * than from a constant (#8700).
 */
export async function loadChainActivity(
  ctx: DataApiMcpContext,
  blocks: number,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): Promise<{ window_blocks: unknown; groups: unknown; activity: unknown[] }> {
  await enforceDataRateLimit(ctx);
  const stats = await loadChainEventsStatsColdTier(ctx.env, blocks, network);
  if (!stats) {
    throwToolError(
      "tier_unavailable",
      "The all-events tier could not answer this aggregate. Try again shortly.",
    );
  }
  return {
    window_blocks: stats.window_blocks,
    groups: stats.groups,
    activity: stats.activity,
  };
}

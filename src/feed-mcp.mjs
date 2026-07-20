// Changelog-feed loader for MCP parity on GET /api/v1/feeds/* (#5592). Reuses
// the exact item builders + filters the REST feed route uses (src/feeds.mjs)
// so `get_feed` never diverges from what an RSS/Atom/JSON Feed reader would
// see -- it just returns the items as plain JSON instead of a feed document,
// since JSON is the natural shape for a tool response (RSS/Atom are XML feed-
// reader formats, not something an agent calls a tool to get).
//
// The incidents source is injected as `deps.loadIncidents(ctx)` rather than
// read here directly -- get_global_incidents already sources the identical
// cross-subnet incident ledger via the MCP module's own deps-injected
// observed_at (mcp-server.mjs's mcpObservedAt), and this reuses that exact
// wiring instead of a second path that would bypass the module's
// injected-KV convention (see mcp-server.mjs's header comment).

import {
  FEED_MAX_ITEMS,
  filterByTag,
  filterSince,
  filterUntil,
  gapsItems,
  incidentItems,
  parseSinceParam,
  registryItems,
  sortAndCap,
} from "./feeds.mjs";
import { loadChangelog } from "./changelog-mcp.mjs";

export const FEED_KINDS = ["registry", "incidents", "gaps", "subnet"];
const ENRICHMENT_QUEUE_ARTIFACT = "/metagraph/review/enrichment-queue.json";

export function feedMcpError(code, message) {
  const error = new Error(message);
  error.toolError = true;
  error.code = code;
  return error;
}

export function requireKind(args) {
  const value = args?.kind;
  if (typeof value !== "string" || !FEED_KINDS.includes(value)) {
    throw feedMcpError(
      "invalid_params",
      `Argument \`kind\` is required and must be one of: ${FEED_KINDS.join(", ")}.`,
    );
  }
  return value;
}

// `netuid` is required for kind "subnet" (mirrors /api/v1/feeds/subnets/{netuid})
// and meaningless for the other three kinds, which have no per-subnet REST
// variant -- reject it there rather than silently ignoring a param the caller
// thinks is doing something.
export function resolveNetuid(args, kind) {
  const value = args?.netuid;
  if (kind === "subnet") {
    if (!Number.isInteger(value) || value < 0) {
      throw feedMcpError(
        "invalid_params",
        "Argument `netuid` is required and must be a non-negative integer when kind is `subnet`.",
      );
    }
    return value;
  }
  if (value !== undefined && value !== null) {
    throw feedMcpError(
      "invalid_params",
      "Argument `netuid` is only used when kind is `subnet`.",
    );
  }
  return null;
}

// Same strict ISO-8601 contract as the REST feed's ?since=/?until= (a bare
// calendar date for `until` is inclusive of the whole UTC day).
export function optionalTimestampMs(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw feedMcpError(
      "invalid_params",
      `Argument \`${key}\` must be an ISO-8601 date or date-time string.`,
    );
  }
  const ms = parseSinceParam(value, { endOfDay: key === "until" });
  if (Number.isNaN(ms)) {
    throw feedMcpError(
      "invalid_params",
      `Argument \`${key}\` must be an ISO-8601 date or date-time, e.g. 2026-06-01 or 2026-06-01T00:00:00Z.`,
    );
  }
  return ms;
}

export function optionalTag(args) {
  const value = args?.tag;
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw feedMcpError("invalid_params", "Argument `tag` must be a string.");
  }
  return value;
}

export function resolveLimit(args) {
  const value = args?.limit;
  if (value === undefined || value === null) return FEED_MAX_ITEMS;
  if (!Number.isInteger(value) || value < 1) {
    throw feedMcpError(
      "invalid_params",
      `Argument \`limit\` must be an integer between 1 and ${FEED_MAX_ITEMS}.`,
    );
  }
  return Math.min(value, FEED_MAX_ITEMS);
}

// A missing/unreadable changelog degrades to an empty registry feed, same as
// the REST route's readData -- get_feed's "what changed" framing is about the
// feed being empty, not the tool erroring out from under an agent.
async function loadChangelogForFeed(ctx) {
  return loadChangelog(ctx).catch(() => null);
}

async function loadGapsQueueForFeed(ctx, { readArtifact } = {}) {
  const read = readArtifact ?? ctx.readArtifact;
  const result = await read(ctx.env, ENRICHMENT_QUEUE_ARTIFACT);
  return result?.ok ? result.data : null;
}

export async function loadFeedItems(ctx, args, deps = {}) {
  const kind = requireKind(args);
  const netuid = resolveNetuid(args, kind);
  const tag = optionalTag(args);
  const sinceMs = optionalTimestampMs(args, "since");
  const untilMs = optionalTimestampMs(args, "until");
  const limit = resolveLimit(args);

  let items;
  if (kind === "registry") {
    items = registryItems(await loadChangelogForFeed(ctx));
  } else if (kind === "incidents") {
    items = incidentItems(await deps.loadIncidents(ctx));
  } else if (kind === "gaps") {
    items = gapsItems(await loadGapsQueueForFeed(ctx, deps));
  } else {
    const [changelog, incidents] = await Promise.all([
      loadChangelogForFeed(ctx),
      deps.loadIncidents(ctx),
    ]);
    items = [
      ...registryItems(changelog, netuid),
      ...incidentItems(incidents, netuid),
    ];
  }

  items = filterByTag(items, tag);
  items = filterSince(items, sinceMs);
  items = filterUntil(items, untilMs);
  items = sortAndCap(items, limit);

  return {
    kind,
    netuid,
    filters: {
      tag,
      since: args?.since ?? null,
      until: args?.until ?? null,
      limit,
    },
    returned: items.length,
    items,
  };
}

export const GET_FEED_INSTRUCTIONS =
  'Use get_feed for "what changed" / changelog discovery -- registry changes, ' +
  "operational incidents, coverage gaps, or one subnet's combined feed, each as " +
  "chronological items with an id/url/title/summary/timestamp/tags, filterable " +
  "by tag/since/until (mirrors the JSON Feed variant of GET /api/v1/feeds/*), ";

export const GET_FEED_MCP_TOOL = {
  name: "get_feed",
  title: "Get changelog feed items",
  description:
    'Fetch registry "what changed" items as structured JSON: registry changes ' +
    "(subnets/artifacts/coverage added, removed, renamed, or updated), " +
    "operational incidents (surface downtime), coverage gaps (ranked " +
    "enrichment targets), or one subnet's combined registry+incidents feed. " +
    "Each item has an id, url, title, summary, timestamp, and tags. Filter by " +
    "tag, and narrow the window with since/until (ISO-8601); page with limit " +
    '(1-50). Use this for incremental "what\'s new since I last checked" ' +
    "polling instead of re-fetching and diffing the full registry. Mirrors the " +
    "JSON Feed variant of GET /api/v1/feeds/registry, /api/v1/feeds/incidents, " +
    "/api/v1/feeds/gaps, and /api/v1/feeds/subnets/{netuid}.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: FEED_KINDS,
        description:
          "Which feed to fetch. `subnet` requires netuid and combines that " +
          "subnet's registry changes + incidents.",
      },
      netuid: {
        type: "integer",
        description:
          "Subnet netuid. Required when kind is `subnet`, unused otherwise.",
        minimum: 0,
      },
      tag: {
        type: "string",
        description:
          "Optional tag filter, e.g. incident, coverage, added, removed, renamed.",
      },
      since: {
        type: "string",
        description:
          "Optional ISO-8601 date or date-time lower bound, e.g. 2026-06-01 or 2026-06-01T00:00:00Z.",
      },
      until: {
        type: "string",
        description:
          "Optional ISO-8601 date or date-time upper bound (a bare date is inclusive of the whole day).",
      },
      limit: {
        type: "integer",
        description: `Max items to return (1-${FEED_MAX_ITEMS}, default ${FEED_MAX_ITEMS}).`,
        minimum: 1,
        maximum: FEED_MAX_ITEMS,
      },
    },
    required: ["kind"],
    additionalProperties: false,
  },
};

const NULLABLE_STRING = { type: ["string", "null"] };
const NULLABLE_INT = { type: ["integer", "null"] };

export const GET_FEED_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["kind", "returned", "items"],
  properties: {
    kind: { type: "string", enum: FEED_KINDS },
    netuid: NULLABLE_INT,
    filters: {
      type: "object",
      additionalProperties: true,
      properties: {
        tag: NULLABLE_STRING,
        since: NULLABLE_STRING,
        until: NULLABLE_STRING,
        limit: { type: "integer" },
      },
    },
    returned: { type: "integer" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: true,
        required: ["id", "url", "title", "summary", "timestamp", "tags"],
        properties: {
          id: { type: "string" },
          url: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          timestamp: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

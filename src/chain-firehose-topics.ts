// The chain-firehose topic vocabulary, as a LEAF module.
//
// ## Why these two sets do not live in workers/chain-firehose-hub.ts
//
// They did, and `src/alert-triggers.ts` imported CHAIN_FIREHOSE_TABLES from
// there to validate a subscription's `table_filter`. That single constant
// import dragged the whole Durable Object into every bundle that touches
// alert-triggers -- and the hub imports `src/graphql.ts` for the subscription
// schema, which imports `src/mcp-server.ts`, which imports `workers/api.ts`.
//
// Measured 2026-08-10 (#10238): `metagraphed-data-api` therefore bundled the
// entire MCP server (697 KiB), all of GraphQL (388 KiB) and the main Worker
// (352 KiB) to check four strings, and its module init ran ~600 ms against
// Cloudflare's ~400 ms STARTUP CPU limit. Deploys failed with
// `code: 10021 Script startup exceeded CPU time limit` -- non-deterministically,
// because a Worker at the edge of that limit passes or fails with the load on
// the validating host. Cutting this edge and one other took data-api to
// 377 KiB gzip and ~220 ms.
//
// A VOCABULARY IS NOT AN IMPLEMENTATION. Four topic names have no reason to be
// reachable only through a WebSocket fan-out Durable Object; keeping them here
// means a validator can ask "is this a real topic" without importing a server.

/**
 * Every topic the firehose accepts.
 *
 * Matched the retired `notify_chain_firehose()` Postgres trigger (#9426) -- the
 * only four tables it ever fired `table:` for. `account_events` (#4984
 * prerequisite) carries netuid/hotkey/coldkey/amount_tao directly, unlike the
 * other three, because the alerter's trigger conditions need those columns
 * without a per-event round-trip.
 */
export const CHAIN_FIREHOSE_TABLES: ReadonlySet<string> = new Set([
  "blocks",
  "extrinsics",
  "chain_events",
  "account_events",
]);

/**
 * The subset that actually has a producer today.
 *
 * #9583: of the four topics above only `blocks` is published. The box-side relay
 * that fed all four died with Postgres (#9426), and the head poller that
 * replaced it (#204) publishes the blocks lane alone -- decoding the other three
 * needs runtime metadata, which is the Containers indexer's job (#209), and a
 * Worker faking them from undecoded bytes would serve wrong data.
 *
 * A topic filter is still ACCEPTED for all four, so a producer arriving later
 * does not require a client change. But a subscriber asking only for
 * unpublished topics gets a well-formed stream that never emits, which is
 * indistinguishable from a quiet chain -- so the hub says so once, at connect.
 */
export const CHAIN_FIREHOSE_PUBLISHED_TABLES: ReadonlySet<string> = new Set([
  "blocks",
]);

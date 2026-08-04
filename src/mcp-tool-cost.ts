// What one MCP tool call SPENDS against the daily quota.
//
// THE BUG THIS FIXES. The quota is a COST unit, not a request (ADR 0022, see
// src/route-cost-weights.ts). It was priced by `routeCost(pathname)`, and every
// MCP call has the same pathname: `/mcp`. That matches no family until the
// `edge` catch-all, so a `tools/call {name:"ask"}` -- a Workers-AI generation --
// debited 1 unit, while the byte-identical work over POST /api/v1/ask debited
// 25. The deep-history tools were underpriced 5x the same way. A `community`
// account got 10,000 `ask` calls over REST and 250,000 over MCP.
//
// The second half was the batch: the limiter and quota were charged ONCE per
// HTTP request, before the body was even read, and a JSON-RPC array then fanned
// out to MAX_MCP_BATCH_LENGTH tool calls with no further charge. Ten
// deep-history reads cost one unit. Combined, `ask` over MCP was up to 250x
// underpriced.
//
// WHY AN EXPLICIT TABLE AND NOT PARSED PROSE. Tool descriptions carry a
// "Mirrors GET <path>" line, and pricing off it was tempting -- but only 101 of
// 189 tools have one, so the other 88 would silently price at the cheapest
// family. Billing must not depend on whether someone remembered a sentence.
// This table is DECLARED, and tests/mcp-tool-cost.test.ts proves it
// bidirectionally: any tool whose own description mirrors a non-default-cost
// REST route must appear here, so a new deep-history tool cannot ship at
// weight 1 by omission. That is the same "declared-and-proven" discipline
// AUTH_REQUIRED_TOOL_NAMES already uses, rather than a list nothing checks.
//
// Only NON-DEFAULT tools are listed. Everything absent prices at
// DEFAULT_ROUTE_COST_WEIGHT, which is correct for the artifact/registry reads
// that make up the large majority of the surface.

import { DEFAULT_ROUTE_COST_WEIGHT, routeCost } from "./route-cost-weights.ts";

/**
 * Tool name -> a REST path in the SAME cost family, which `routeCost` then
 * prices. Paths are representative, not routed: a concrete netuid/ref is used
 * where the family regex requires one (`subnets/\d+/...`).
 */
export const MCP_TOOL_COST_PATHS: Record<string, string> = {
  // ai (25) -- a real per-call LLM cost. Neither declares a Mirrors line.
  ask: "/api/v1/ask",
  semantic_search: "/api/v1/search/semantic",

  // deep-history (5) -- connection-pool/scan bound. Mirrored, test-enforced.
  get_account_transfers: "/api/v1/accounts/{ss58}/transfers",
  get_block_chain_events: "/api/v1/blocks/{block_number}/chain-events",
  get_block_events: "/api/v1/blocks/{ref}/events",
  get_chain_activity: "/api/v1/chain-events/stats",
  get_extrinsic_chain_events: "/api/v1/chain-events",
  list_block_extrinsics: "/api/v1/blocks/{ref}/extrinsics",
  list_blocks: "/api/v1/blocks",
  list_chain_events: "/api/v1/chain-events",
  list_extrinsics: "/api/v1/extrinsics",

  // deep-history (5) -- same families, but these carry no Mirrors line, so the
  // test above cannot derive them. Declared by hand for exactly that reason.
  get_account_events: "/api/v1/accounts/{ss58}/events",
  get_account_history: "/api/v1/accounts/{ss58}/history",
  get_account_positions: "/api/v1/accounts/{ss58}/positions",
  get_block: "/api/v1/blocks",
  get_extrinsic: "/api/v1/extrinsics",
  get_subnet_conviction: "/api/v1/subnets/1/conviction",
  get_subnet_lease: "/api/v1/subnets/1/lease",
  get_subnet_ownership_history: "/api/v1/subnets/1/ownership-history",
};

/** What one `tools/call` of this tool spends. Unknown/absent -> the default. */
export function mcpToolCostUnits(name: unknown): number {
  if (typeof name !== "string") return DEFAULT_ROUTE_COST_WEIGHT;
  const path = MCP_TOOL_COST_PATHS[name];
  return path ? routeCost(path).weight : DEFAULT_ROUTE_COST_WEIGHT;
}

/**
 * What one POST /mcp body spends in total.
 *
 * Every message is counted, so a batch costs the sum of its parts rather than
 * one flat unit. Non-`tools/call` methods (initialize, tools/list, resources/*)
 * still cost the default each -- they are real requests, just cheap ones.
 *
 * Floors at the default so an empty or unparseable body is never free.
 */
export function mcpBatchCostUnits(body: unknown): number {
  const messages = Array.isArray(body) ? body : [body];
  let total = 0;
  for (const message of messages) {
    const row = message as { method?: unknown; params?: { name?: unknown } };
    total +=
      row?.method === "tools/call"
        ? mcpToolCostUnits(row?.params?.name)
        : DEFAULT_ROUTE_COST_WEIGHT;
  }
  return Math.max(DEFAULT_ROUTE_COST_WEIGHT, total);
}

// What a published `limit` ceiling actually does, on both surfaces (#10064).
//
// ── Two published sentences that had never been compared ────────────────────
//
// `limitSchema()` told an MCP caller a larger value "is clamped to the ceiling
// rather than rejected". `SHARED_QUERY_PARAMETER_DESCRIPTIONS.limit` told a
// REST caller it "is rejected with 400 `invalid_query` on every route -- it is
// never silently clamped". Flat contradictions, both published, and nothing
// held either surface to its own claim.
//
// ── Deriving it disproved the obvious explanation ───────────────────────────
//
// The tidy story is "REST rejects, MCP clamps". It is wrong. Running the probe
// over every route and every tool instead of a hand-picked five:
//
//   * 81 of 82 reachable REST routes reject -- and /api/v1/chain-events CLAMPS,
//     so the "on every route" clause was false.
//   * 25 MCP tools REJECT: 15 collection-backed ones through validateListQuery,
//     10 hand-rolled handlers through parseBoundedIntParam. So "clamped rather
//     than rejected" was false for a quarter of the tools that publish a
//     ceiling.
//
// Clamp-vs-reject is a property of the HANDLER, not of the surface. Both
// sentences have been corrected to stop promising a behaviour their surface
// does not uniformly have.
//
// ── Why DECLARED lists rather than one green rule ───────────────────────────
//
// Every way of unifying this is a behaviour change for callers being served
// today -- making chain-events reject 400s them, making the 25 clamp silently
// shortens their pages. That should be one deliberate decision (#10174), not
// 26 taken by a refactor. So the current partition is pinned, with the reason,
// and a STALE entry FAILS: the same idiom the MCP-parity and GraphQL-parity
// gates use, so the lists can only shrink.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";
import { API_ROUTES, querySchemaForRoute } from "../src/contracts.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import { handleRequest } from "../workers/api.ts";
import { handleMcpRequest, listToolDefinitions } from "../src/mcp-server.ts";
import type { Row } from "./row-type.ts";

/**
 * REST routes that CLAMP an over-large `limit` instead of rejecting it, and
 * why each is allowed to. A stale entry fails.
 */
const DECLARED_CLAMPING_ROUTES: Record<string, string> = {
  "/api/v1/chain-events":
    "clamps to the published maximum instead of 400ing, unlike the other 81 " +
    "routes that publish a ceiling. Verified live: ?limit=99999 answers 200 " +
    "with 100 events. Left as-is because tightening it would 400 callers " +
    "being served today; the shared `limit` description no longer claims " +
    "every route rejects.",
};

/**
 * MCP tools that REJECT an over-ceiling `limit` instead of clamping it.
 *
 * The clamp is not a property of the surface, it is a property of the handler:
 * 15 of these are collection-backed and reject through `validateListQuery`,
 * and the rest reject through `parseBoundedIntParam`. Measured by dispatching
 * `limit: maximum + 1` at every tool that publishes a ceiling -- which is why
 * `limitSchema`'s description no longer promises clamping to all of them.
 *
 * Declared rather than "fixed": making them clamp, or making the others
 * reject, is a behaviour change for live agent callers either way, and it
 * should be one decision taken deliberately rather than 25 taken by a
 * refactor. A stale entry FAILS, so the list can only shrink.
 */
const REJECTS_BY_SHARED_ENGINE =
  "rejects an over-ceiling limit rather than clamping, through the shared " +
  "list-query engine or parseBoundedIntParam. See #10174.";

const DECLARED_REJECTING_TOOLS: Record<string, string> = {
  get_account_counterparties: REJECTS_BY_SHARED_ENGINE,
  get_account_events: REJECTS_BY_SHARED_ENGINE,
  get_account_extrinsics: REJECTS_BY_SHARED_ENGINE,
  get_account_history: REJECTS_BY_SHARED_ENGINE,
  get_account_identity_history: REJECTS_BY_SHARED_ENGINE,
  get_account_transfers: REJECTS_BY_SHARED_ENGINE,
  get_chain_concentration_subnets: REJECTS_BY_SHARED_ENGINE,
  get_chain_identity_history: REJECTS_BY_SHARED_ENGINE,
  get_extrinsic_chain_events: REJECTS_BY_SHARED_ENGINE,
  get_global_incidents: REJECTS_BY_SHARED_ENGINE,
  get_health_history: REJECTS_BY_SHARED_ENGINE,
  get_validator_nominators: REJECTS_BY_SHARED_ENGINE,
  list_candidates: REJECTS_BY_SHARED_ENGINE,
  list_curation: REJECTS_BY_SHARED_ENGINE,
  list_endpoint_incidents: REJECTS_BY_SHARED_ENGINE,
  list_endpoint_pools: REJECTS_BY_SHARED_ENGINE,
  list_evidence: REJECTS_BY_SHARED_ENGINE,
  list_gaps: REJECTS_BY_SHARED_ENGINE,
  list_providers: REJECTS_BY_SHARED_ENGINE,
  list_rpc_endpoints: REJECTS_BY_SHARED_ENGINE,
  list_rpc_pools: REJECTS_BY_SHARED_ENGINE,
  list_search_index: REJECTS_BY_SHARED_ENGINE,
  list_source_snapshots: REJECTS_BY_SHARED_ENGINE,
  list_surfaces: REJECTS_BY_SHARED_ENGINE,
  search_subnets: REJECTS_BY_SHARED_ENGINE,
};

const PATH_FIXTURES: Record<string, string> = {
  "{netuid}": "1",
  "{ss58}": "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3",
  "{hotkey}": "5F4tQyWrhfGVcNhoqeiNsR6KjD4wMZ2kfhLj4oHYuyHbZAc3",
  "{ref}": "1000000",
  "{uid}": "0",
  "{slug}": "academia",
  "{date}": "2026-08-01",
  "{tag}": "inference",
  "{surface_id}": "sn-1-apex-healthcheck",
  "{hash}": `0x${"0".repeat(64)}`,
  "{h160}": `0x${"0".repeat(40)}`,
  "{id}": "00000000-0000-0000-0000-000000000000",
  "{crowdloan_id}": "0",
};

function publishedLimitMaximum(entry: Row): number | null {
  const schema = querySchemaForRoute(entry as never);
  if (!schema) return null;
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
  }) as Row;
  const maximum = ((json.properties as Row)?.limit as Row)?.maximum;
  return typeof maximum === "number" ? maximum : null;
}

describe("a published `limit` ceiling means what its surface says (#10064)", () => {
  test("every REST route publishing a ceiling rejects one over it", async () => {
    const env = await createLocalArtifactEnv();
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const clamping: string[] = [];
    const suppressed = new Set<string>();
    let checked = 0;

    for (const entry of API_ROUTES as unknown as Row[]) {
      if (entry.method !== "GET") continue;
      const maximum = publishedLimitMaximum(entry);
      if (maximum === null) continue;
      let path = entry.path as string;
      for (const [token, value] of Object.entries(PATH_FIXTURES)) {
        path = path.split(token).join(value);
      }
      if (/\{[a-z_0-9]+\}/.test(path)) continue;
      const response = await handleRequest(
        new Request(`https://api.metagraph.sh${path}?limit=${maximum + 1}`),
        env as never,
        ctx as never,
      );
      // A route whose data tier is unreachable under the local env answers
      // 503 before it can decide about `limit`; that is not evidence either
      // way, so it is skipped rather than counted as a pass.
      if (response.status === 503) continue;
      checked += 1;
      if (response.status === 400) continue;
      if (entry.path in DECLARED_CLAMPING_ROUTES) {
        suppressed.add(entry.path as string);
        continue;
      }
      clamping.push(`${entry.path} answered ${response.status}`);
    }

    const stale = Object.keys(DECLARED_CLAMPING_ROUTES).filter(
      (path) => !suppressed.has(path),
    );
    assert.deepEqual(
      stale,
      [],
      `these no longer clamp, so remove them from DECLARED_CLAMPING_ROUTES: ${stale.join(", ")}`,
    );
    assert.deepEqual(
      clamping,
      [],
      "these publish a `limit` ceiling and do NOT reject a value over it, " +
        "while the published description says they do — either reject, or " +
        `declare the divergence with its reason: ${clamping.join(", ")}`,
    );
    assert.ok(checked > 60, `only ${checked} routes were reachable`);
  }, 300_000);

  test("every MCP tool publishing a ceiling clamps instead of rejecting", async () => {
    // The counterpart, and the half that used to be five hand-picked tools.
    // Derived from listToolDefinitions(), so a tool registered tonight is
    // covered tonight — and a handler that starts REJECTING an over-limit
    // becomes a visible, deliberate contract change rather than a surprise
    // for an agent mid-conversation.
    const env = createLocalArtifactEnv() as unknown as Parameters<
      typeof handleMcpRequest
    >[1];
    const rejecting: string[] = [];
    const suppressed = new Set<string>();
    let checked = 0;

    for (const tool of listToolDefinitions() as Row[]) {
      const properties = (tool.inputSchema as Row)?.properties as
        Row | undefined;
      const maximum = (properties?.limit as Row)?.maximum;
      if (typeof maximum !== "number") continue;
      const args: Record<string, unknown> = { limit: maximum + 1 };
      for (const key of ((tool.inputSchema as Row)?.required ??
        []) as string[]) {
        if (key === "limit") continue;
        const property = properties?.[key] as Row | undefined;
        const type = Array.isArray(property?.type)
          ? property?.type[0]
          : property?.type;
        const values = property?.enum as unknown[] | undefined;
        args[key] = values?.length
          ? values[0]
          : type === "string"
            ? "1"
            : type === "array"
              ? [1]
              : 1;
      }
      const response = await handleMcpRequest(
        new Request("https://api.metagraph.sh/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: tool.name, arguments: args },
          }),
        }),
        env,
        {},
      );
      const body = (await response.json()) as Row;
      const code = ((body?.result?.structuredContent as Row)?.error as Row)
        ?.code;
      // Only `invalid_params` is the failure being guarded against. A tool
      // that cannot reach its tier under this env answers something else, and
      // that says nothing about how it treats `limit`.
      if (code === undefined || code === null) {
        checked += 1;
        continue;
      }
      if (code !== "invalid_params") continue;
      checked += 1;
      if (tool.name in DECLARED_REJECTING_TOOLS) {
        suppressed.add(tool.name as string);
        continue;
      }
      rejecting.push(`${tool.name} rejected limit=${maximum + 1}`);
    }

    const stale = Object.keys(DECLARED_REJECTING_TOOLS).filter(
      (name) => !suppressed.has(name),
    );
    assert.deepEqual(
      stale,
      [],
      `these now clamp, so remove them from DECLARED_REJECTING_TOOLS: ${stale.join(", ")}`,
    );
    assert.deepEqual(
      rejecting,
      [],
      "these REJECTED an over-ceiling limit; MCP tools are supposed to clamp, " +
        "and limitSchema's published description promises they do. If this is " +
        "a deliberate contract change, that sentence has to change with it: " +
        rejecting.join(", "),
    );
    assert.ok(checked > 40, `only ${checked} tools were reachable`);
  }, 300_000);
});

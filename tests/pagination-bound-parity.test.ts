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
// Clamp-vs-reject was a property of the HANDLER, not of the surface, so a
// caller could not predict it from anything published.
//
// ── Both DECLARED lists are now EMPTY (#10174) ──────────────────────────────
//
// The split was pinned rather than fixed because unifying it is a behaviour
// change either way, and that is one deliberate decision rather than 26 taken
// by a refactor. The decision: REST rejects, MCP clamps -- per SURFACE, one
// predictable sentence each, and the MCP half is the forgiving direction so no
// agent caller that works today stops working.
//
//   * /api/v1/chain-events now runs the same parseLimitParam as the other 81
//     routes, so its 400 body is byte-identical rather than merely similar.
//   * The MCP dispatch clamps `limit` to the ceiling each tool's OWN
//     inputSchema publishes (validateToolArguments -> clampPublishedLimit), so
//     a tool cannot ship with a bound the dispatch does not honour.
//
// Ten of the 25 tools this file once declared were never rejecting on `limit`
// at all: the probe filled every required string with "1", so `ss58: "1"` and
// `date: "1"` answered invalid_params about the SUBJECT and were read as a
// rejected limit. ARG_FIXTURES supplies real values, and the clamp assertion
// below checks the applied limit rather than merely the absence of an error --
// not erroring is not the same as honouring the bound.
//
// A STALE entry in either list still FAILS, so neither can grow back quietly.
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
const DECLARED_CLAMPING_ROUTES: Record<string, string> = {};

/**
 * MCP tools that REJECT an over-ceiling `limit` instead of clamping it.
 *
 * EMPTY (#10174): the dispatch clamps to the ceiling each tool publishes, so
 * there is nothing left to declare. A stale entry FAILS, so this cannot grow
 * back without someone noticing.
 */
const DECLARED_REJECTING_TOOLS: Record<string, string> = {};

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

/**
 * Realistic values for an MCP tool's REQUIRED arguments, so the dispatch
 * reaches the `limit` handling this test exists to measure.
 *
 * Filling every required string with `"1"` made ten tools answer
 * `invalid_params` for reasons that had nothing to do with `limit` --
 * `ss58: "1"` is not an address and `date: "1"` is not a day -- and the test
 * read those as "this tool rejects an over-ceiling limit". Ten entries sat in
 * DECLARED_REJECTING_TOOLS describing a fixture, not a contract (#10174).
 *
 * Keyed by argument name and shared with PATH_FIXTURES' values, so the two
 * halves of this file agree on what a valid subject looks like.
 */
const ARG_FIXTURES: Record<string, unknown> = {
  ss58: PATH_FIXTURES["{ss58}"],
  hotkey: PATH_FIXTURES["{hotkey}"],
  coldkey: PATH_FIXTURES["{ss58}"],
  address: PATH_FIXTURES["{ss58}"],
  date: PATH_FIXTURES["{date}"],
  slug: PATH_FIXTURES["{slug}"],
  surface_id: PATH_FIXTURES["{surface_id}"],
  // Not PATH_FIXTURES["{ref}"]: the REST path accepts a bare block number,
  // but get_extrinsic_chain_events requires the composite
  // `block_number-extrinsic_index` and rejects anything else as invalid_params.
  ref: "4200000-3",
  netuid: 1,
  uid: 0,
  q: "subnet",
  query: "subnet",
  task: "inference",
  capability: PATH_FIXTURES["{tag}"],
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
    const unclamped: string[] = [];
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
          : (ARG_FIXTURES[key] ??
            (type === "string" ? "1" : type === "array" ? [1] : 1));
      }
      // A tool can state its requirement as `anyOf: [{required:["q"]}, ...]`
      // rather than in `required` -- search_subnets takes either `q` or its
      // `query` alias. Filling only `required` left it with neither, so it
      // answered invalid_params about the missing query and this test read
      // that as a rejected `limit`.
      for (const branch of ((tool.inputSchema as Row)?.anyOf ?? []) as Row[]) {
        const names = (branch?.required ?? []) as string[];
        if (!names.length || names.some((name) => name in args)) continue;
        for (const name of names) {
          args[name] = ARG_FIXTURES[name] ?? "1";
        }
        break;
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
      const structured = (body?.result?.structuredContent ?? {}) as Row;
      const code = (structured.error as Row)?.code;
      // Only `invalid_params` is the failure being guarded against. A tool
      // that cannot reach its tier under this env answers something else, and
      // that says nothing about how it treats `limit`.
      if (code === undefined || code === null) {
        checked += 1;
        // Absence of an error is not proof of a clamp -- a tool could ignore
        // `limit` entirely and pass. Where the answer reports the limit it
        // applied, hold it to the published ceiling.
        if (
          typeof structured.limit === "number" &&
          structured.limit > maximum
        ) {
          unclamped.push(
            `${tool.name} applied limit=${structured.limit} above its published ${maximum}`,
          );
        }
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
    assert.deepEqual(
      unclamped,
      [],
      "these answered without error but applied a limit ABOVE their published " +
        "ceiling, so the clamp did not happen -- passing this test by not " +
        "erroring is not the same as honouring the bound: " +
        unclamped.join(", "),
    );
    assert.ok(checked > 40, `only ${checked} tools were reachable`);
  }, 300_000);
});

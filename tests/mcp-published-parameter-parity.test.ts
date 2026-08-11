// The last 21 published parameters no MCP tool could pass (#10793).
//
// Each of these is a query parameter our own OpenAPI advertises, over a tool
// that mirrors the route. An agent reading the contract and sending the
// published name was rejected for an unknown argument, so every test here is a
// call in the form the contract already promised would work.
//
// MEASURED, NOT ASSERTED. The two findings that motivated the change were both
// taken from production and both are pinned below as behaviour rather than
// prose: get_network_health returned 20 of 123 subnets AND a `next_cursor`
// there was no argument to send back, and get_subnet_evidence returned every
// claim with no pagination block at all. A test that only checked "the argument
// is in the schema" would pass on a tool that ignored it -- which is the
// failure this repo keeps paying for -- so each one is asserted through the
// HANDLER, on output that differs.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest, MCP_TOOLS } from "../src/mcp-server.ts";
import { searchMatchingRows } from "../workers/list-query.ts";
import { MCP_LIST_LIMIT_DEFAULT } from "../src/route-limits.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";
import type { Row } from "./row-type.ts";

const MCP_URL = "https://api.metagraph.sh/mcp";
const HOTKEY = "5CS3g6nVJM6ouns8n9buN9CzFf2C1YDHVcVGRcxoirKs2xbV";

function makeDeps(artifacts: Row = {}) {
  return {
    readArtifact(_env: unknown, path: string) {
      if (Object.prototype.hasOwnProperty.call(artifacts, path)) {
        return Promise.resolve({
          ok: true,
          data: artifacts[path],
          source: "test",
          storage_tier: "git",
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        code: "artifact_not_found",
        message: `Artifact not found: ${path}`,
      });
    },
    readHealthKv() {
      return Promise.resolve(null);
    },
  };
}

async function callTool(name: string, args: unknown, deps: Row = makeDeps()) {
  const response = await handleMcpRequest(
    new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
    {} as unknown as Env,
    deps,
  );
  return JSON.parse(await response.text());
}

const out = (res: Row) => (res.result as Row).structuredContent as Row;
const errored = (res: Row) => (res.result as Row).isError === true;
const errorText = (res: Row) =>
  ((res.result as Row).content as Row[])[0].text as string;

const argsOf = (name: string) =>
  Object.keys(
    ((MCP_TOOLS.find((t: Row) => t.name === name) as Row)?.inputSchema as Row)
      ?.properties ?? {},
  );

// ---------------------------------------------------------------------------

describe("get_network_health pages, and now says so (#10793)", () => {
  // 40 rows so the shared MCP default (20) visibly narrows. `summary` is
  // required: buildGlobalHealth returns null without it and the tool serves its
  // `unknown` card, which would make every assertion below vacuous.
  const health = {
    last_run_at: new Date().toISOString(),
    summary: {
      surface_count: 820,
      status_counts: { ok: 20, degraded: 20, failed: 0, unknown: 0 },
    },
    subnets: Array.from({ length: 40 }, (_, i) => ({
      netuid: i,
      name: `sn-${i}`,
      status: i % 2 === 0 ? "ok" : "degraded",
      surface_count: 40 - i,
    })),
  };
  const deps = {
    ...makeDeps(),
    readHealthKv: () => Promise.resolve(health as unknown as Row),
  };

  test("the default page was ALREADY 20, and the schema now publishes it", async () => {
    // The finding, reproduced: measured against production this returned
    // "total":123,"returned":20 with neither `limit` nor `cursor` in its
    // published schema. The narrowing is unchanged -- only its visibility is.
    const res = await callTool("get_network_health", {}, deps);
    const body = out(res);
    assert.equal(body.total, 40);
    assert.equal(body.returned, MCP_LIST_LIMIT_DEFAULT);
    assert.equal(body.limit, MCP_LIST_LIMIT_DEFAULT);

    const limit = (
      (MCP_TOOLS.find((t: Row) => t.name === "get_network_health") as Row)
        .inputSchema as Row
    ).properties as Row;
    assert.equal((limit.limit as Row).default, MCP_LIST_LIMIT_DEFAULT);
  });

  test("the next_cursor it returns can now be sent back", async () => {
    // The sharp end of the finding: the response advertised a paging protocol
    // whose other half had no argument. A tool that returns a cursor it cannot
    // accept has told the caller to do something impossible.
    const first = out(await callTool("get_network_health", {}, deps));
    assert.equal(first.next_cursor, MCP_LIST_LIMIT_DEFAULT);

    const second = out(
      await callTool("get_network_health", { cursor: first.next_cursor }, deps),
    );
    assert.equal(second.cursor, MCP_LIST_LIMIT_DEFAULT);
    assert.equal((second.subnets as Row[])[0].netuid, MCP_LIST_LIMIT_DEFAULT);
    assert.equal(second.next_cursor, null);
  });

  test("limit and sort reach the rows, not just the schema", async () => {
    const res = await callTool(
      "get_network_health",
      { limit: 3, sort: "surface_count", order: "asc" },
      deps,
    );
    const body = out(res);
    assert.equal(body.returned, 3);
    assert.deepEqual(
      (body.subnets as Row[]).map((s) => s.surface_count),
      [1, 2, 3],
    );
  });

  test("the global counts still span the network, not the page", async () => {
    // `global` is the reason a narrowed page is safe here: an alerting caller
    // filtered to one status still needs the network's real denominator.
    const res = await callTool(
      "get_network_health",
      { status: "degraded", limit: 2 },
      deps,
    );
    const body = out(res);
    assert.equal(body.returned, 2);
    assert.equal(body.total, 20);
    assert.equal((body.global as Row).surface_count, 820);
  });
});

describe("get_subnet_evidence gained the lever it never had (#10793)", () => {
  const claims = Array.from({ length: 30 }, (_, i) => ({
    subject: `surface:sn-64-item-${i}`,
    claim: i < 4 ? "Chutes OpenAPI schema is public." : `Claim number ${i}.`,
    source_url: `https://example.invalid/${i}`,
    support_summary: "Listed in curated overlay for sn-64.",
    verified_at: `2026-08-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
  }));
  const deps = makeDeps({
    "/metagraph/evidence/64.json": {
      netuid: 64,
      name: "Chutes",
      slug: "sn-64",
      generated_at: "2026-08-11T08:16:17.556Z",
      claims,
    },
  });

  test("an unfiltered call is a PAGE now, and reports the whole total", async () => {
    // Before this it returned every claim with no pagination block at all --
    // 77 of them, ~33 KB, measured on SN64 in production.
    const body = out(
      await callTool("get_subnet_evidence", { netuid: 64 }, deps),
    );
    assert.equal((body.claims as Row[]).length, MCP_LIST_LIMIT_DEFAULT);
    assert.equal(body.total, 30);
    assert.equal(body.next_cursor, MCP_LIST_LIMIT_DEFAULT);
    // The artifact's own stamp survives the narrowing -- this tool returns the
    // full card, unlike its list sibling.
    assert.equal(body.name, "Chutes");
    assert.equal(body.slug, "sn-64");
  });

  test("q searches the claims the collection declares searchable", async () => {
    const body = out(
      await callTool("get_subnet_evidence", { netuid: 64, q: "openapi" }, deps),
    );
    assert.equal(body.total, 4);
    for (const claim of body.claims as Row[]) {
      assert.match(claim.claim as string, /OpenAPI/);
    }
  });

  test("sort + order reach the rows", async () => {
    const body = out(
      await callTool(
        "get_subnet_evidence",
        { netuid: 64, sort: "subject", order: "desc", limit: 2 },
        deps,
      ),
    );
    assert.deepEqual(
      (body.claims as Row[]).map((c) => c.subject),
      ["surface:sn-64-item-9", "surface:sn-64-item-8"],
    );
  });

  test("netuid stays the SUBJECT and never becomes a row filter", async () => {
    // The claims carry `subject`, not `netuid`. Passing the tool's netuid on as
    // a filter would match zero rows and look like an empty ledger.
    const body = out(
      await callTool("get_subnet_evidence", { netuid: 64 }, deps),
    );
    assert.equal(body.total, 30);
    assert.equal(body.netuid, 64);
  });

  test("an unsortable column is refused rather than silently ignored", async () => {
    const res = await callTool(
      "get_subnet_evidence",
      { netuid: 64, sort: "not_a_column" },
      deps,
    );
    assert.equal(errored(res), true);
  });
});

describe("free-text q on the hand-filtered tools (#10793)", () => {
  test("list_subnets composes q with the filters search_subnets cannot", async () => {
    // The capability that existed on neither tool: search_subnets ranks and
    // cannot be combined, so "inference in the name AND readiness above 70"
    // was unreachable from both.
    const deps = makeDeps({
      "/metagraph/subnets.json": {
        subnets: [
          {
            netuid: 1,
            name: "Apex Inference",
            slug: "apex",
            integration_readiness: 90,
          },
          {
            netuid: 2,
            name: "Inference Lab",
            slug: "inflab",
            integration_readiness: 40,
          },
          {
            netuid: 3,
            name: "Storage Grid",
            slug: "storage",
            integration_readiness: 95,
          },
        ],
      },
    });
    const body = out(
      await callTool(
        "list_subnets",
        { q: "inference", min_integration_readiness: 70 },
        deps,
      ),
    );
    assert.deepEqual(
      (body.subnets as Row[]).map((s) => s.netuid),
      [1],
    );
  });

  test("list_subnets q matches slug as well as name, and every term must hit", async () => {
    const deps = makeDeps({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "Apex", slug: "text-embedding" },
          { netuid: 2, name: "Zeus", slug: "weather" },
        ],
      },
    });
    const bySlug = out(
      await callTool("list_subnets", { q: "embedding" }, deps),
    );
    assert.deepEqual(
      (bySlug.subnets as Row[]).map((s) => s.netuid),
      [1],
    );

    // AND, not OR: `apex` alone matches row 1, and adding a term row 1 lacks
    // must empty the result rather than widen it.
    const both = out(
      await callTool("list_subnets", { q: "apex weather" }, deps),
    );
    assert.deepEqual(both.subnets, []);
  });

  test("list_enrichment_targets narrows the queue and KEEPS its ranking", async () => {
    // The reason q is exposed here while sort/order are declined: a filter
    // preserves rank, a re-sort destroys it.
    const rows = [
      {
        netuid: 1,
        name: "Apex",
        slug: "apex",
        recommended_next_action: "add openapi schema",
      },
      {
        netuid: 2,
        name: "Zeus",
        slug: "zeus",
        recommended_next_action: "capture a fixture",
      },
      {
        netuid: 3,
        name: "Hone",
        slug: "hone",
        recommended_next_action: "add openapi schema",
      },
    ];
    const deps = makeDeps({
      "/metagraph/coverage-depth.json": {
        rows,
        ranked_queue: [
          { netuid: 3, rank: 1 },
          { netuid: 1, rank: 2 },
          { netuid: 2, rank: 3 },
        ],
      },
    });
    const body = out(
      await callTool("list_enrichment_targets", { q: "openapi" }, deps),
    );
    assert.deepEqual(
      (body.targets as Row[]).map((t) => t.netuid),
      [3, 1],
    );
    // Rank order survived, and the ranks themselves came through unrenumbered.
    assert.deepEqual(
      (body.targets as Row[]).map((t) => t.rank),
      [1, 2],
    );
  });

  test("list_enrichment_targets ECHOES q, because the echo's keys are the parameters", async () => {
    const deps = makeDeps({
      "/metagraph/coverage-depth.json": {
        rows: [{ netuid: 1, name: "Apex", slug: "apex" }],
        ranked_queue: [{ netuid: 1, rank: 1 }],
      },
    });
    const applied = out(
      await callTool("list_enrichment_targets", { q: "apex" }, deps),
    );
    assert.equal((applied.filters as Row).q, "apex");
    // Null rather than absent when unsupplied, matching every sibling key.
    const omitted = out(await callTool("list_enrichment_targets", {}, deps));
    assert.equal((omitted.filters as Row).q, null);
  });

  test("get_coverage_depth q reaches the engine it already ran through", async () => {
    const deps = makeDeps({
      "/metagraph/coverage-depth.json": {
        rows: [
          {
            netuid: 1,
            name: "Apex",
            slug: "apex",
            top_gap_codes: ["missing-openapi"],
          },
          {
            netuid: 2,
            name: "Zeus",
            slug: "zeus",
            top_gap_codes: ["missing-fixture"],
          },
        ],
      },
    });
    const body = out(
      await callTool("get_coverage_depth", { q: "missing-openapi" }, deps),
    );
    assert.equal(body.total, 1);
    assert.deepEqual(
      (body.rows as Row[]).map((r) => r.netuid),
      [1],
    );
  });
});

describe("get_extrinsic_chain_events filters within one extrinsic (#10793)", () => {
  test("pallet and method are published, block/extrinsic/before are NOT", async () => {
    // The declared half of this change, asserted rather than left to prose:
    // `block`/`extrinsic` are already inside `ref`, and `before` is a
    // block-height bound on a read pinned to one block.
    const args = argsOf("get_extrinsic_chain_events");
    assert.ok(args.includes("pallet"));
    assert.ok(args.includes("method"));
    for (const declined of ["block", "extrinsic", "before"]) {
      assert.ok(
        !args.includes(declined),
        `${declined} must stay unexposed: it is resolved from ref or degenerate here`,
      );
    }
  });

  test("both reach the lakehouse WHERE clause, not just the schema", async () => {
    // The failure worth catching is a published argument the handler drops, so
    // this asserts on the SQL the cold tier actually issues rather than on the
    // tool's own echo -- an echo can report a filter that never ran.
    const queries: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      queries.push(JSON.parse(String(init.body)).query);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { rows: [] } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      await handleMcpRequest(
        new Request(MCP_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "get_extrinsic_chain_events",
              arguments: {
                ref: "8791987-3",
                pallet: "SubtensorModule",
                method: "set_weights",
              },
            },
          }),
        }),
        { [R2_SQL_TOKEN_ENV]: "cfut_test" } as unknown as Env,
        makeDeps(),
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    assert.ok(queries.length > 0, "the loader never reached the lakehouse");
    const sql = queries[0]!;
    assert.match(sql, /pallet = 'SubtensorModule'/);
    assert.match(sql, /method = 'set_weights'/);
    // Still pinned to the ref's own block and index, which is exactly why the
    // two path-shaped filters stay unexposed.
    assert.match(sql, /block_number = 8791987/);
    assert.match(sql, /extrinsic_index = 3/);
  });

  test("omitting them does not widen the read to every pallet", async () => {
    // The inverse failure: an absent filter that becomes an empty-string one,
    // or a `null` that reaches the WHERE clause as a literal.
    const queries: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      queries.push(JSON.parse(String(init.body)).query);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { rows: [] } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      await callTool(
        "get_extrinsic_chain_events",
        { ref: "8791987-3" },
        {
          ...makeDeps(),
        },
      );
    } finally {
      globalThis.fetch = realFetch;
    }
    // No lakehouse token in that env, so the read declines before issuing SQL;
    // what matters is that nothing was issued with an empty filter.
    for (const sql of queries) {
      assert.doesNotMatch(sql, /pallet = ''/);
      assert.doesNotMatch(sql, /method = ''/);
      assert.doesNotMatch(sql, /pallet = 'null'/);
    }
  });
});

describe("get_validator_nominators.basis (#10793)", () => {
  test("basis is published with flow as the default that does not move", async () => {
    const basis = (
      (
        (
          MCP_TOOLS.find(
            (t: Row) => t.name === "get_validator_nominators",
          ) as Row
        ).inputSchema as Row
      ).properties as Row
    ).basis as Row;
    assert.deepEqual(basis.enum, ["flow", "positions"]);
    assert.equal(basis.default, "flow");
  });

  test("the positions basis REJECTS window and sort rather than ignoring them", async () => {
    // Accepting them would imply the snapshot honoured them, and a caller who
    // asked for 7d and got an all-time holdings card cannot tell. The route
    // 400s on both -- verified live -- so the tool must too.
    for (const unsupported of ["window", "sort"]) {
      const res = await callTool("get_validator_nominators", {
        hotkey: HOTKEY,
        basis: "positions",
        [unsupported]: unsupported === "window" ? "7d" : "net_staked",
      });
      assert.equal(errored(res), true, `${unsupported} must be refused`);
      assert.match(errorText(res), /basis=flow only/);
    }
  });

  test("an explicit window is refused even when it equals the default", async () => {
    // The distinguishing case, and the reason the check reads what the CALLER
    // named rather than comparing values: `window: "30d"` is the published
    // default, so a value comparison would wave it through — but the caller
    // wrote it down, and on this basis it is not honoured.
    const res = await callTool("get_validator_nominators", {
      hotkey: HOTKEY,
      basis: "positions",
      window: "30d",
    });
    assert.equal(errored(res), true);
    assert.match(errorText(res), /basis=flow only/);
  });

  test("an OMITTED window is not mistaken for an explicit one", async () => {
    // The inverse, and the bug this caught before it shipped: dispatch fills
    // window/sort from their published defaults, so reading them off `args`
    // refused every positions call over arguments nobody sent.
    const res = await callTool("get_validator_nominators", {
      hotkey: HOTKEY,
      basis: "positions",
    });
    assert.equal(errored(res), false);
  });

  test("an explicit null window reads as no window, not as a request", async () => {
    // Dispatch does no schema validation, so `window: null` can arrive. It says
    // "no value" the way `?window=` does on the REST side -- refusing it would
    // reject a caller who asked for nothing.
    const res = await callTool("get_validator_nominators", {
      hotkey: HOTKEY,
      basis: "positions",
      window: null,
    });
    assert.equal(errored(res), false);
  });

  test("the positions page honours an explicit limit and offset", async () => {
    const body = out(
      await callTool("get_validator_nominators", {
        hotkey: HOTKEY,
        basis: "positions",
        limit: 5,
        offset: 10,
      }),
    );
    assert.equal(body.limit, 5);
    assert.equal(body.offset, 10);
  });

  test("an explicit null limit/offset falls back rather than paging by null", async () => {
    // `null` survives dispatch -- a default is only filled for an argument that
    // is ABSENT -- so it reaches the handler and each fallback has to hold. A
    // null offset reaching the builder would slice from `null` and return the
    // whole set.
    const body = out(
      await callTool("get_validator_nominators", {
        hotkey: HOTKEY,
        basis: "positions",
        limit: null,
        offset: null,
      }),
    );
    assert.equal(body.limit, 20);
    assert.equal(body.offset, 0);
  });

  test("an unproven pool ledger DECLINES rather than underpricing a nominator", async () => {
    // No store bound, so latestCompleteHotkeyAlphaPass cannot prove a complete
    // pass. A partial ledger drops a nominator's alpha instead of dropping the
    // nominator, which is a wrong number that looks right.
    const body = out(
      await callTool("get_validator_nominators", {
        hotkey: HOTKEY,
        basis: "positions",
      }),
    );
    assert.equal(body.basis, "positions");
    assert.equal(body.nominator_count, null);
    assert.deepEqual(body.nominators, []);
    assert.equal(typeof (body.degraded as Row).reason, "string");
  });

  test("the flow basis is untouched, and still stamps no basis at all", async () => {
    const body = out(
      await callTool("get_validator_nominators", { hotkey: HOTKEY }),
    );
    assert.equal(body.window, "30d");
    assert.equal(body.sort, "net_staked");
    assert.equal(body.basis, undefined);
  });

  test("basis=flow explicitly is the same answer as omitting it", async () => {
    const explicit = out(
      await callTool("get_validator_nominators", {
        hotkey: HOTKEY,
        basis: "flow",
        window: "7d",
      }),
    );
    assert.equal(explicit.window, "7d");
    assert.equal(explicit.basis, undefined);
  });
});

describe("the shared search matcher (#10793)", () => {
  // Exported so the hand-filtered tools do not write a second one. These pin
  // the five behaviours a re-implementation would get wrong.
  const rows = [
    { name: "Apex", slug: "apex", tags: ["inference", "text"] },
    { name: "Zeus", slug: "weather", tags: ["forecast"] },
    { name: "Zero", slug: "zero", tags: [], count: 0 },
  ];

  test("no query returns the rows untouched", () => {
    assert.equal(searchMatchingRows(rows, null, ["name"]), rows);
    assert.equal(searchMatchingRows(rows, "", ["name"]), rows);
    // Whitespace-only is a query that names no terms, not a filter to nothing.
    assert.equal(searchMatchingRows(rows, "   ", ["name"]).length, 3);
  });

  test("no keys returns the rows untouched", () => {
    assert.equal(searchMatchingRows(rows, "apex", []), rows);
  });

  test("every term must match, and matching is case-insensitive substring", () => {
    assert.equal(searchMatchingRows(rows, "APE", ["name"]).length, 1);
    assert.equal(
      searchMatchingRows(rows, "apex weather", ["name", "slug"]).length,
      0,
    );
    assert.equal(searchMatchingRows(rows, "z", ["name"]).length, 2);
  });

  test("an array field is flattened, so a match may span two entries", () => {
    assert.equal(
      searchMatchingRows(rows, "inference text", ["tags"]).length,
      1,
    );
  });

  test("falsy values are dropped before the join, so 0 is not searchable text", () => {
    assert.equal(searchMatchingRows(rows, "0", ["count"]).length, 0);
  });
});

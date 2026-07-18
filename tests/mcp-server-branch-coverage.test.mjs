import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleMcpRequest, MAX_MCP_BODY_BYTES } from "../src/mcp-server.mjs";

const MCP_URL = "https://api.metagraph.sh/mcp";

// Fresh prober run time for live KV fixtures — resolveLiveHealth/economics
// freshness windows reject anything older than ~25 min.
const FRESH_RUN = new Date(Date.now() - 60_000).toISOString();

// Build injectable deps with controlled artifact + KV responses (mirror helper).
function makeDeps(artifacts = {}, kv = {}) {
  return {
    readArtifact(_env, path) {
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
    readHealthKv(_env, key) {
      return Promise.resolve(
        Object.prototype.hasOwnProperty.call(kv, key) ? kv[key] : null,
      );
    },
  };
}

async function rpc(
  payload,
  { deps = makeDeps(), env = {}, method = "POST", headers } = {},
) {
  const request = new Request(MCP_URL, {
    method,
    headers: headers || { "content-type": "application/json" },
    body: method === "POST" ? JSON.stringify(payload) : undefined,
  });
  const response = await handleMcpRequest(request, env, deps);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

function callTool(name, args, opts) {
  return rpc(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
    opts,
  );
}

// A minimal AI env whose vector query returns the given subnet netuids in order;
// `aiInput` flags an input-validation error that runAi maps to invalid_params.
function aiEnvWithMatches(netuids, { embedError, vectorError } = {}) {
  return {
    METAGRAPH_ENABLE_AI: "true",
    AI: {
      run(_model, input) {
        if (input?.text) {
          if (embedError) return Promise.reject(embedError);
          const n = Array.isArray(input.text) ? input.text.length : 1;
          return Promise.resolve({
            data: Array.from({ length: n }, () => new Array(1024).fill(0.02)),
          });
        }
        return Promise.resolve({ response: "answer [1]." });
      },
    },
    VECTORIZE: {
      query() {
        if (vectorError) return Promise.reject(vectorError);
        return Promise.resolve({
          matches: netuids.map((n, i) => ({
            id: `subnet:${n}`,
            score: 0.9 - i * 0.01,
            metadata: {
              type: "subnet",
              netuid: n,
              slug: `sn-${n}`,
              title: `Subnet ${n}`,
              subtitle: "summary",
            },
          })),
        });
      },
    },
  };
}

// ── coverageDepthTarget / coverageDepthMatches fallbacks ───────────
describe("list_enrichment_targets — row fallback + filter branches", () => {
  // A scorecard row missing every optional field exercises the `|| []`, `?? 0`,
  // `|| {}`, and `|| null` defaults in coverageDepthTarget, and a row whose
  // top_gaps/top_gap_codes are absent exercises coverageDepthMatches defaults.
  const sparseScorecard = {
    generated_at: "2026-06-01T00:00:00Z",
    coverage_depth_version: 2,
    rows: [
      {
        netuid: 42,
        slug: "sparse",
        name: "Sparse",
        tier: "needs-evidence",
        score: 5,
        priority_score: 9,
        agent_status: "blocked",
        blocker_level: "missing-data",
        // No top_gap_codes, no top_gaps, no recommended_next_action, no dimensions.
      },
    ],
    ranked_queue: [{ rank: 1, netuid: 42 }],
  };

  test("maps a row with no optional fields to schema-stable defaults", async () => {
    const res = await callTool(
      "list_enrichment_targets",
      {},
      { deps: makeDeps({ "/metagraph/coverage-depth.json": sparseScorecard }) },
    );
    const out = res.body.result.structuredContent;
    const target = out.targets[0];
    assert.equal(target.netuid, 42);
    assert.equal(target.rank, 1);
    // top_gap_codes || [], top_gaps || [], recommended_next_action || null.
    assert.deepEqual(target.top_gap_codes, []);
    assert.deepEqual(target.top_gaps, []);
    assert.equal(target.recommended_next_action, null);
    // dimensions defaults: counts ?? 0, arrays/objects || [] / {}.
    assert.equal(target.dimensions.callable_service_count, 0);
    assert.deepEqual(target.dimensions.service_kinds, []);
    assert.equal(target.dimensions.schema_service_count, 0);
    assert.equal(target.dimensions.schema_missing_count, 0);
    assert.equal(target.dimensions.fixture_available_count, 0);
    assert.deepEqual(target.dimensions.fixture_status_counts, {});
    assert.equal(target.dimensions.example_count, 0);
    assert.equal(target.dimensions.sdk_count, 0);
    assert.equal(target.dimensions.candidate_operational_count, 0);
    assert.equal(target.dimensions.official_surface_count, 0);
    assert.equal(target.dimensions.provider_claimed_surface_count, 0);
    // Echoes generated_at + version from the scorecard.
    assert.equal(out.generated_at, "2026-06-01T00:00:00Z");
    assert.equal(out.coverage_depth_version, 2);
  });

  test("maps top_gaps entries to {code,severity,field,next_action}", async () => {
    const deps = makeDeps({
      "/metagraph/coverage-depth.json": {
        rows: [
          {
            netuid: 7,
            slug: "g",
            name: "G",
            tier: "machine-usable",
            score: 50,
            priority_score: 60,
            agent_status: "callable",
            blocker_level: "none",
            top_gap_codes: ["missing-schema"],
            top_gaps: [
              {
                code: "missing-schema",
                severity: "needs-review",
                field: "schemas",
                next_action: "capture schema",
              },
            ],
            recommended_next_action: "capture schema",
            dimensions: {
              callable_service_count: 2,
              service_kinds: ["openapi"],
              fixture_status_counts: { ok: 1 },
            },
          },
        ],
        ranked_queue: [{ rank: 1, netuid: 7 }],
      },
    });
    const res = await callTool("list_enrichment_targets", {}, { deps });
    const gap = res.body.result.structuredContent.targets[0].top_gaps[0];
    assert.deepEqual(gap, {
      code: "missing-schema",
      severity: "needs-review",
      field: "schemas",
      next_action: "capture schema",
    });
  });

  test("tier + severity filters exclude a non-matching row", async () => {
    const deps = makeDeps({
      "/metagraph/coverage-depth.json": {
        rows: [
          {
            netuid: 7,
            slug: "g",
            name: "G",
            tier: "machine-usable",
            score: 50,
            priority_score: 60,
            agent_status: "callable",
            blocker_level: "none",
            top_gap_codes: ["missing-schema"],
            top_gaps: [{ code: "missing-schema", severity: "needs-review" }],
          },
        ],
        ranked_queue: [{ rank: 1, netuid: 7 }],
      },
    });
    // tier filter mismatches → coverageDepthMatches returns false on the tier arm.
    const wrongTier = await callTool(
      "list_enrichment_targets",
      { tier: "agent-ready" },
      { deps },
    );
    assert.equal(wrongTier.body.result.structuredContent.returned, 0);

    // severity filter mismatches → false on the severity .some() arm.
    const wrongSeverity = await callTool(
      "list_enrichment_targets",
      { severity: "hard" },
      { deps },
    );
    assert.equal(wrongSeverity.body.result.structuredContent.returned, 0);

    // Matching tier + severity passes both arms.
    const ok = await callTool(
      "list_enrichment_targets",
      { tier: "machine-usable", severity: "needs-review" },
      { deps },
    );
    assert.equal(ok.body.result.structuredContent.returned, 1);
  });

  test("rejects a malformed gap_code with invalid_params", async () => {
    // optionalGapCode rejects an uppercase/space code (not /^[a-z0-9-]+$/).
    const res = await callTool(
      "list_enrichment_targets",
      { gap_code: "Bad Code!" },
      { deps: makeDeps({ "/metagraph/coverage-depth.json": sparseScorecard }) },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /gap_code/);
  });

  test("scorecard with no rows/ranked_queue returns empty targets", async () => {
    // rows not array → []; ranked_queue not array → []; null generated_at/version.
    const res = await callTool(
      "list_enrichment_targets",
      {},
      { deps: makeDeps({ "/metagraph/coverage-depth.json": {} }) },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.total_rows, 0);
    assert.equal(out.queue_count, 0);
    assert.equal(out.returned, 0);
    assert.equal(out.generated_at, null);
    assert.equal(out.coverage_depth_version, null);
  });

  test("a ranked_queue entry with no scorecard row falls back to the entry itself", async () => {
    // rowsByNetuid has no row for netuid 5, so the queue entry (which carries a
    // netuid) is used as the row; entries without an integer netuid are filtered.
    const deps = makeDeps({
      "/metagraph/coverage-depth.json": {
        rows: [],
        ranked_queue: [
          { rank: 1, netuid: 5, tier: "hard-blocked", score: 1 },
          { rank: 2 }, // no netuid → filtered out
        ],
      },
    });
    const res = await callTool("list_enrichment_targets", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.returned, 1);
    assert.equal(out.targets[0].netuid, 5);
    assert.equal(out.targets[0].rank, 1);
  });

  test("netuid filter returns that subnet's row with rank null, errors when absent", async () => {
    const deps = makeDeps({
      "/metagraph/coverage-depth.json": sparseScorecard,
    });
    const row = await callTool(
      "list_enrichment_targets",
      { netuid: 42 },
      { deps },
    );
    assert.equal(row.body.result.structuredContent.targets[0].netuid, 42);
    assert.equal(row.body.result.structuredContent.targets[0].rank, null);

    const missing = await callTool(
      "list_enrichment_targets",
      { netuid: 999 },
      { deps },
    );
    assert.equal(missing.body.result.isError, true);
    assert.match(missing.body.result.content[0].text, /No coverage-depth/);
  });
});

// ── search_subnets / list_subnets filter fallbacks ─
describe("search + list filter/fallback branches", () => {
  test("search_subnets skips a doc whose tokens is not an array", async () => {
    // scoreDocument's `Array.isArray(doc.tokens) ? doc.tokens : []` false arm,
    // and the docs `Array.isArray(index.documents)` guard.
    const deps = makeDeps({
      "/metagraph/search.json": {
        documents: [
          {
            type: "subnet",
            netuid: 1,
            slug: "a",
            title: "Alpha",
            subtitle: "alpha sub",
            tokens: "not-an-array",
          },
        ],
      },
    });
    const res = await callTool("search_subnets", { query: "alpha" }, { deps });
    const out = res.body.result.structuredContent;
    // Still scores via name/slug; tokens default to [].
    assert.equal(out.results[0].netuid, 1);
  });

  test("search_subnets returns empty when documents is not an array", async () => {
    const deps = makeDeps({ "/metagraph/search.json": { documents: null } });
    const res = await callTool("search_subnets", { query: "x" }, { deps });
    assert.equal(res.body.result.structuredContent.total, 0);
  });

  test("list_subnets returns empty subnets when the index has no array", async () => {
    // `Array.isArray(index.subnets) ? index.subnets : []` false arm.
    const deps = makeDeps({ "/metagraph/subnets.json": { subnets: null } });
    const res = await callTool("list_subnets", {}, { deps });
    assert.equal(res.body.result.structuredContent.total, 0);
  });

  test("list_subnets status + subnet_type filters coerce missing fields", async () => {
    // Rows with no status / subnet_type exercise String(... || "") on the false
    // side of each filter; the matching row passes both.
    const deps = makeDeps({
      "/metagraph/subnets.json": {
        subnets: [
          {
            netuid: 1,
            name: "A",
            status: "active",
            subnet_type: "application",
          },
          { netuid: 2, name: "B" }, // no status, no subnet_type
        ],
      },
    });
    const byStatus = await callTool(
      "list_subnets",
      { status: "active" },
      { deps },
    );
    assert.equal(byStatus.body.result.structuredContent.total, 1);
    assert.equal(byStatus.body.result.structuredContent.subnets[0].netuid, 1);

    const byType = await callTool(
      "list_subnets",
      { subnet_type: "application" },
      { deps },
    );
    assert.equal(byType.body.result.structuredContent.total, 1);
  });

  test("list_subnets maps a row missing slug/name/scores to nulls", async () => {
    // The mapper fallbacks: slug ?? null, title ?? null, non-number readiness /
    // surface_count → null.
    const deps = makeDeps({
      "/metagraph/subnets.json": {
        subnets: [
          {
            netuid: 3,
            integration_readiness: "high",
            surface_count: "many",
          },
        ],
      },
    });
    const res = await callTool("list_subnets", {}, { deps });
    const sub = res.body.result.structuredContent.subnets[0];
    assert.equal(sub.slug, null);
    assert.equal(sub.title, null);
    assert.equal(sub.integration_readiness, null);
    assert.equal(sub.surface_count, null);
  });
});

// ── find_subnets_by_capability sort tie-breaks ────────────────────
describe("find_subnets_by_capability — sort tie-break arms", () => {
  test("equal scores tie-break by integration_readiness then callable_count", async () => {
    // Two subnets with the same keyword score force the secondary comparator
    // (integration_readiness) and, when equal, the tertiary (callable_count).
    const deps = makeDeps({
      "/metagraph/agent-catalog.json": {
        subnets: [
          {
            netuid: 1,
            slug: "data-a",
            name: "data",
            categories: ["data"],
            service_kinds: ["subnet-api"],
            callable_count: 2,
            integration_readiness: 50,
          },
          {
            netuid: 2,
            slug: "data-b",
            name: "data",
            categories: ["data"],
            service_kinds: ["subnet-api"],
            callable_count: 9,
            integration_readiness: 90,
          },
          {
            netuid: 3,
            slug: "data-c",
            name: "data",
            categories: ["data"],
            service_kinds: ["subnet-api"],
            callable_count: 4,
            integration_readiness: 90,
          },
        ],
      },
    });
    const res = await callTool(
      "find_subnets_by_capability",
      { capability: "data" },
      { deps },
    );
    const order = res.body.result.structuredContent.results.map(
      (r) => r.netuid,
    );
    // 2 and 3 share readiness 90 → callable_count desc (9 then 4); 1 last.
    assert.deepEqual(order, [2, 3, 1]);
  });
});

// ── window / board default + profiles fallback ─
describe("analytics tools — default windows + profiles fallback", () => {
  test("get_registry_leaderboards falls back to [] when profiles is absent", async () => {
    // `(...).profiles || []` false arm: a profiles.json with no `profiles` key.
    const deps = makeDeps({
      "/metagraph/profiles.json": {},
      "/metagraph/economics.json": { subnets: [] },
    });
    const res = await callTool(
      "get_registry_leaderboards",
      { limit: 3 },
      { deps },
    );
    assert.equal(res.body.result.isError, false);
    assert.ok(typeof res.body.result.structuredContent.boards === "object");
  });

  test("compare_subnets falls back to [] when profiles is absent", async () => {
    const deps = makeDeps({
      "/metagraph/profiles.json": {},
      "/metagraph/economics.json": { subnets: [] },
    });
    const res = await callTool(
      "compare_subnets",
      { netuids: [1], dimensions: ["structure"] },
      { deps },
    );
    assert.equal(res.body.result.isError, false);
    assert.deepEqual(res.body.result.structuredContent.requested_netuids, [1]);
  });

  test("get_global_incidents defaults to the 7d window when omitted", async () => {
    // args.window === undefined skips the invalid-params guard; default "7d".
    const res = await callTool(
      "get_global_incidents",
      {},
      { deps: makeDeps({}, { "health:meta": { last_run_at: FRESH_RUN } }) },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.window, "7d");
    assert.equal(out.observed_at, FRESH_RUN);
  });
});

// ── mcpObservedAt readHealthKv-missing ─────────────────────────────────
describe("mcpObservedAt — readHealthKv missing returns null observed_at", () => {
  test("get_subnet_uptime reports observed_at null when no readHealthKv dep", async () => {
    // ctx.readHealthKv is undefined → mcpObservedAt returns null immediately.
    const depsNoKvFn = {
      readArtifact() {
        return Promise.resolve({ ok: true, data: {} });
      },
    };
    const res = await callTool(
      "get_subnet_uptime",
      { netuid: 7 },
      { deps: depsNoKvFn },
    );
    assert.equal(res.body.result.structuredContent.observed_at, null);
  });
});

// ── loadEconomicsSubnetRows R2 fallback ────────────────────────────────
describe("find_subnet_opportunities + leaderboards — economics R2 fallback", () => {
  test("get_registry_leaderboards tolerates economics blob with no subnets array", async () => {
    // `Array.isArray(blob?.subnets) ? blob.subnets : []` false arm.
    const deps = makeDeps({
      "/metagraph/profiles.json": { profiles: [] },
      "/metagraph/economics.json": {},
    });
    const res = await callTool("get_registry_leaderboards", {}, { deps });
    assert.equal(res.body.result.isError, false);
  });
});

// ── get_economics — list-query + tier fallbacks ─────────────────────────
describe("get_economics — branch coverage", () => {
  const ECON_ROW = {
    netuid: 7,
    name: "Allways",
    slug: "allways",
    emission_share: 1,
    registration_allowed: true,
  };
  const ECON_BLOB = {
    contract_version: "test-contract",
    captured_at: FRESH_RUN,
    schema_version: 1,
    summary: { with_economics_count: 1, subnet_count: 1 },
    subnets: [ECON_ROW],
  };

  test("tolerates economics blob with no subnets array", async () => {
    const deps = makeDeps(
      {
        "/metagraph/economics.json": { captured_at: FRESH_RUN, summary: null },
      },
      {},
    );
    const res = await callTool("get_economics", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.source, "r2-fallback");
    assert.deepEqual(out.subnets, []);
    assert.equal(out.summary, null);
  });

  test("rejects malformed fields list from list-query validation", async () => {
    const res = await callTool(
      "get_economics",
      { fields: "netuid,9invalid" },
      {
        deps: makeDeps({ "/metagraph/economics.json": ECON_BLOB }, {}),
        env: {},
      },
    );
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /fields must be a comma-separated/,
    );
  });
});

// ── get_network_health — global operational rollup ──────────────────────
describe("get_network_health — branch coverage", () => {
  test("serves unknown when ctx has no METAGRAPH_HEALTH_DB binding", async () => {
    const res = await callTool("get_network_health", {}, { env: {} });
    const out = res.body.result.structuredContent;
    assert.equal(res.body.result.isError, false);
    assert.equal(out.health_source, "unavailable");
    assert.equal(out.global.surface_count, 0);
  });

  test("overlays live KV when health:current is present", async () => {
    const deps = makeDeps(
      {},
      {
        "health:current": {
          last_run_at: FRESH_RUN,
          summary: { surface_count: 3, status_counts: { ok: 3 } },
          subnets: [{ netuid: 1, status: "ok" }],
        },
      },
    );
    const res = await callTool("get_network_health", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.health_source, "live-cron-prober");
    assert.equal(out.global.surface_count, 3);
    assert.equal(out.subnets[0].netuid, 1);
  });
});

// ── get_coverage — registry coverage artifact ─────────────────────────────
describe("get_coverage — branch coverage", () => {
  test("surfaces non-not_found artifact failures", async () => {
    const deps = {
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
      readHealthKv: async () => null,
    };
    const res = await callTool("get_coverage", {}, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /artifact_timeout/);
    assert.match(res.body.result.content[0].text, /coverage\.json/);
  });
});

// ── list_curation — curation artifact list ────────────────────────────────
describe("list_curation — branch coverage", () => {
  test("surfaces non-not_found artifact failures", async () => {
    const deps = {
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
      readHealthKv: async () => null,
    };
    const res = await callTool("list_curation", {}, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /artifact_timeout/);
    assert.match(res.body.result.content[0].text, /curation\.json/);
  });
});

// ── list_gaps — gaps artifact list ────────────────────────────────────────
describe("list_gaps — branch coverage", () => {
  test("surfaces non-not_found artifact failures", async () => {
    const deps = {
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
      readHealthKv: async () => null,
    };
    const res = await callTool("list_gaps", {}, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /artifact_timeout/);
    assert.match(res.body.result.content[0].text, /gaps\.json/);
  });
});

// ── list_endpoint_pools — endpoint pool artifact list ─────────────────────
describe("list_endpoint_pools — branch coverage", () => {
  test("surfaces non-not_found artifact failures", async () => {
    const deps = {
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
      readHealthKv: async () => null,
    };
    const res = await callTool("list_endpoint_pools", {}, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /artifact_timeout/);
    assert.match(res.body.result.content[0].text, /endpoint-pools\.json/);
  });
});

// ── list_endpoint_incidents — endpoint incident artifact list ─────────────
describe("list_endpoint_incidents — branch coverage", () => {
  test("surfaces non-not_found artifact failures", async () => {
    const deps = {
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
      readHealthKv: async () => null,
    };
    const res = await callTool("list_endpoint_incidents", {}, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /artifact_timeout/);
    assert.match(res.body.result.content[0].text, /endpoint-incidents\.json/);
  });
});

// ── get_contracts — contracts artifact ────────────────────────────────────
describe("get_contracts — branch coverage", () => {
  test("surfaces non-not_found artifact failures", async () => {
    const deps = {
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
      readHealthKv: async () => null,
    };
    const res = await callTool("get_contracts", {}, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /artifact_timeout/);
    assert.match(res.body.result.content[0].text, /contracts\.json/);
  });
});

// ── list_search_index — search index artifact list ────────────────────────
describe("list_search_index — branch coverage", () => {
  test("surfaces non-not_found artifact failures", async () => {
    const deps = {
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
      readHealthKv: async () => null,
    };
    const res = await callTool("list_search_index", {}, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /artifact_timeout/);
    assert.match(res.body.result.content[0].text, /search-index\.json/);
  });
});

// ── get_agent_resources — AI-resources artifact ───────────────────────────
describe("get_agent_resources — branch coverage", () => {
  test("surfaces non-not_found artifact failures", async () => {
    const deps = {
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
      readHealthKv: async () => null,
    };
    const res = await callTool("get_agent_resources", {}, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /artifact_timeout/);
    assert.match(res.body.result.content[0].text, /agent-resources\.json/);
  });

  test("maps a null artifact payload to not_found", async () => {
    const deps = {
      readArtifact: async () => ({ ok: true, data: null }),
      readHealthKv: async () => null,
    };
    const res = await callTool("get_agent_resources", {}, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(
      res.body.result.content[0].text,
      /unavailable in this environment/,
    );
  });
});

// ── list_subnet_apis fallbacks ────────────────────────────
describe("list_subnet_apis — detail fallback fields", () => {
  test("falls back to the requested netuid + empty services when detail is bare", async () => {
    // detail.netuid ?? netuid, services not array → 0, data.services || [].
    const deps = makeDeps({ "/metagraph/agent-catalog/7.json": {} });
    const res = await callTool("list_subnet_apis", { netuid: 7 }, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.netuid, 7);
    assert.equal(out.service_count, 0);
    assert.deepEqual(out.services, []);
    assert.equal(out.operational_observed_at, null);
    assert.equal(out.health_source, "unavailable");
  });
});

// ── get_best_rpc_endpoint helpers ────────────────────────────────
describe("get_best_rpc_endpoint — dedupe, scoring + field fallbacks", () => {
  test("dedupes by id keeping the best score and maps absent fields to null", async () => {
    // Two pools share endpoint 'a' (one ineligible, one eligible higher score)
    // and a lower-score 'a' so the `(score||0) > (existing.score||0)` arm fires.
    // 'b' carries no url/provider/kind/score/latency → each `?? null` fallback.
    const deps = makeDeps({
      "/metagraph/rpc/pools.json": {
        pools: {
          0: {
            endpoints: [
              {
                id: "a",
                url: "wss://a.example",
                score: 10,
                pool_eligible: true,
                latency_ms: 50,
              },
              { id: "b", pool_eligible: true },
              { id: "c", pool_eligible: false, score: 99 },
            ],
          },
          1: {
            endpoints: [
              {
                id: "a",
                url: "wss://a-better.example",
                score: 80,
                pool_eligible: true,
                latency_ms: 40,
              },
            ],
          },
        },
      },
    });
    const res = await callTool("get_best_rpc_endpoint", { limit: 5 }, { deps });
    const out = res.body.result.structuredContent;
    // 'a' deduped (best score 80) + 'b'; 'c' ineligible. live_health false.
    assert.equal(out.eligible_count, 2);
    assert.equal(out.live_health, false);
    const a = out.endpoints.find((e) => e.id === "a");
    assert.equal(a.url, "wss://a-better.example");
    assert.equal(a.score, 80);
    const b = out.endpoints.find((e) => e.id === "b");
    assert.equal(b.url, null);
    assert.equal(b.provider, null);
    assert.equal(b.kind, null);
    assert.equal(b.score, null);
    assert.equal(b.latency_ms, null);
    // Network is always finney; layer defaults to bittensor-base.
    assert.equal(b.network, "finney");
    assert.equal(b.layer, "bittensor-base");
  });

  test("sorts equal-score endpoints by ascending latency (Infinity for missing)", async () => {
    // Two eligible same-score endpoints: the one with a latency sorts before the
    // one without (?? Infinity). Exercises the latency tie-break comparator arm.
    const deps = makeDeps({
      "/metagraph/rpc/pools.json": {
        pools: {
          0: {
            endpoints: [
              { id: "slow", score: 5, pool_eligible: true },
              { id: "fast", score: 5, pool_eligible: true, latency_ms: 12 },
            ],
          },
        },
      },
    });
    const res = await callTool("get_best_rpc_endpoint", {}, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.endpoints[0].id, "fast");
  });

  test("tolerates a pool whose endpoints field is absent", async () => {
    // overlaid.endpoints || [] false arm: a pool object with no endpoints array.
    const deps = makeDeps({
      "/metagraph/rpc/pools.json": { pools: { 0: {} } },
    });
    const res = await callTool("get_best_rpc_endpoint", {}, { deps });
    assert.equal(res.body.result.structuredContent.eligible_count, 0);
  });
});

// ── how_do_i_call snippet / fixture branches ───────────────
describe("how_do_i_call — snippet fallback + fixture content-type branches", () => {
  test("falls back to stored snippets when generateServiceSnippets returns nothing", async () => {
    // A service with no base_url makes generateServiceSnippets return null, so
    // `|| s.snippets` is used; with neither it becomes null.
    const deps = makeDeps({
      "/metagraph/agent-catalog/7.json": {
        netuid: 7,
        name: "Data",
        slug: "sn-7",
        integration_readiness: 70,
        services: [
          {
            surface_id: "sn-7-api",
            kind: "subnet-api",
            capability: "Data API",
            base_url: null,
            auth_required: false,
            auth_schemes: [],
            schema_artifact: null,
            schema_url: null,
            eligibility: { callable: true },
            snippets: { curl: "stored-curl" },
            fixture: {
              artifact_path: "/metagraph/fixtures/sn-7-api.json",
              captured_at: "2026-06-18T00:00:00Z",
              response: { status: 200, content_type: "application/json" },
            },
          },
        ],
      },
    });
    const res = await callTool("how_do_i_call", { netuid: 7 }, { deps });
    const svc = res.body.result.structuredContent.services[0];
    // generateServiceSnippets(null base_url) → null → falls back to stored.
    assert.deepEqual(svc.snippets, { curl: "stored-curl" });
    // fixture available branch: response_status + content_type read.
    assert.equal(svc.fixture.available, true);
    assert.equal(svc.fixture.response_status, 200);
    assert.equal(svc.fixture.content_type, "application/json");
  });

  test("a fixture with no response object yields null status/content_type", async () => {
    // s.fixture.response?.status ?? null and content_type ?? null false arms.
    const deps = makeDeps({
      "/metagraph/agent-catalog/7.json": {
        netuid: 7,
        name: "Data",
        slug: "sn-7",
        integration_readiness: 70,
        services: [
          {
            surface_id: "sn-7-api",
            kind: "subnet-api",
            capability: "Data API",
            base_url: "https://api.data.io",
            auth_required: false,
            auth_schemes: [],
            schema_artifact: null,
            schema_url: null,
            eligibility: { callable: true },
            fixture: { artifact_path: "/p.json", captured_at: "2026-06-18" },
          },
        ],
      },
    });
    const res = await callTool("how_do_i_call", { netuid: 7 }, { deps });
    const fx = res.body.result.structuredContent.services[0].fixture;
    assert.equal(fx.available, true);
    assert.equal(fx.response_status, null);
    assert.equal(fx.content_type, null);
  });
});

// ── verify_integration — surface resolution ─────────────────────────────────
describe("verify_integration — surface resolution branches", () => {
  test("tolerates an operational-surfaces artifact with no surfaces array", async () => {
    // `Array.isArray(catalog?.surfaces) ? catalog.surfaces : []` false arm.
    const deps = makeDeps({ "/metagraph/operational-surfaces.json": {} });
    const res = await callTool("verify_integration", { netuid: 5 }, { deps });
    assert.equal(res.body.result.isError, true);
  });
});

// ── resource cursor + uri parsing ───────────────────────────────
describe("resources — cursor decode + uri parsing edge arms", () => {
  test("resources/list ignores a non-numeric cursor (decodes to 0)", async () => {
    // decodeResourceCursor: a non-integer cursor → 0, so page one is returned.
    const subnets = Array.from({ length: 3 }, (_, i) => ({
      netuid: i,
      name: `SN${i}`,
    }));
    const deps = makeDeps({ "/metagraph/subnets.json": { subnets } });
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "resources/list",
        params: { cursor: "not-a-number" },
      },
      { deps },
    );
    const uris = res.body.result.resources.map((r) => r.uri);
    assert.ok(uris.includes("metagraph://subnet/0"));
  });

  test("resources/read rejects a metagraph uri with no slash after the type", async () => {
    // parseResourceUri: rest.indexOf('/') < 0 → null → invalid_params.
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "resources/read",
      params: { uri: "metagraph://justtype" },
    });
    assert.equal(res.body.error.code, -32602);
  });
});

// ── prompts/get argument default ──────────────────────────────────────
describe("prompts/get — arguments default to empty object", () => {
  test("a prompt invoked with no arguments object reports the missing required arg", async () => {
    // params.arguments is undefined → `|| {}`; the required arg is then missing.
    const res = await rpc({
      jsonrpc: "2.0",
      id: 1,
      method: "prompts/get",
      params: { name: "integrate_with_subnet" },
    });
    assert.equal(res.body.error.code, -32602);
    assert.match(res.body.error.message, /Missing required prompt argument/);
  });
});

// ── callTool unknown-tool + arguments default ─────────────────────────
describe("tools/call — arguments default + unknown tool", () => {
  test("a tools/call with no arguments object still runs the handler", async () => {
    // params.arguments undefined → `|| {}`; registry_summary needs no args.
    const res = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "registry_summary" },
      },
      { deps: makeDeps({ "/metagraph/registry-summary.json": { ok: 1 } }) },
    );
    assert.equal(res.body.result.isError, false);
    assert.equal(res.body.result.structuredContent.ok, 1);
  });
});

// ── dispatch notification short-circuits for each method ─────────
describe("dispatchMessage — notification arms across methods", () => {
  test("resources/templates/list, resources/read, prompts/list, prompts/get as notifications return 202", async () => {
    // Each `isNotification ? null : ...` true arm — no id on an otherwise-valid
    // method drops the message (no response object), so the batch yields 202.
    for (const message of [
      { jsonrpc: "2.0", method: "resources/templates/list" },
      {
        jsonrpc: "2.0",
        method: "resources/read",
        params: { uri: "metagraph://subnet/7" },
      },
      { jsonrpc: "2.0", method: "prompts/list" },
      {
        jsonrpc: "2.0",
        method: "prompts/get",
        params: { name: "integrate_with_subnet", arguments: { netuid: 7 } },
      },
      { jsonrpc: "2.0", method: "tools/call", params: { name: "ping" } },
    ]) {
      const res = await rpc(message);
      assert.equal(res.status, 202, `${message.method} as notification → 202`);
    }
  });
});

// ── rate limiter + body-size guards ─────────────────────────────
describe("handleMcpRequest — rate limiter success + content-length guard", () => {
  test("the RPC_RATE_LIMITER fallback allows the request when success is true", async () => {
    // enforceMcpRateLimit: env.MCP_RATE_LIMITER absent → RPC_RATE_LIMITER used;
    // success: true → returns null (no 429) and the request proceeds.
    let seenKey;
    const env = {
      RPC_RATE_LIMITER: {
        async limit({ key }) {
          seenKey = key;
          return { success: true };
        },
      },
    };
    const res = await rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { env });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.result, {});
    assert.equal(typeof seenKey, "string");
  });

  test("a request whose content-length exceeds the cap is rejected with 413", async () => {
    // contentLength > MAX_MCP_BODY_BYTES short-circuits before reading the body.
    const request = new Request(MCP_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(64 * 1024 + 1),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    const response = await handleMcpRequest(request, {}, makeDeps());
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.error.code, -32600);
  });

  test("malformed Content-Length values are rejected with 400 before any body read", async () => {
    // Strict decimal-integer grammar — Number() coercion must not accept these.
    for (const value of ["", " ", "abc", "1.5", "0x10", "1e3", "-1"]) {
      const request = new Request(MCP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": value,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      const response = await handleMcpRequest(request, {}, makeDeps());
      assert.equal(
        response.status,
        400,
        `content-length=${JSON.stringify(value)}`,
      );
      const body = await response.json();
      assert.equal(body.error.code, -32600);
      assert.match(body.error.message, /Invalid Content-Length/);
    }
  });

  test("an oversized streamed body without Content-Length is rejected mid-read", async () => {
    // Chunked / stream bodies omit Content-Length; the reader must cancel once
    // the running byte count exceeds MAX_MCP_BODY_BYTES instead of buffering.
    const oversized = "x".repeat(MAX_MCP_BODY_BYTES + 1);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      },
    });
    const request = new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    });
    assert.equal(request.headers.get("content-length"), null);
    const response = await handleMcpRequest(request, {}, makeDeps());
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(body.error.code, -32600);
    assert.match(body.error.message, /too large/);
  });
});

// ── resolveNetuid index fallback ───────────────────────────────────────
describe("resolveNetuid — subnets index array fallback", () => {
  test("how_do_i_call resolves a slug when subnets.json has no array", async () => {
    // `Array.isArray(index.subnets) ? index.subnets : []` false arm → no match.
    const deps = makeDeps({
      "/metagraph/subnets.json": { subnets: null },
    });
    const res = await callTool("how_do_i_call", { subnet: "ghost" }, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /No subnet matches/);
  });
});

// ── extra targeted arms ──────────────────────────────────────────────────────
describe("AI tools — runAi re-throws a non-input AI fault", () => {
  test("semantic_search wraps a Vectorize rejection as an internal error", async () => {
    // semanticSearch rejects with a plain (non-aiInput) Error → runAi re-throws
    // → callTool's internal-error path (sanitized isError, code internal_error).
    const env = aiEnvWithMatches([1], {
      vectorError: new Error("vectorize exploded"),
    });
    const res = await callTool("semantic_search", { query: "images" }, { env });
    assert.equal(res.body.result.isError, true);
    assert.equal(
      res.body.result.structuredContent.error.code,
      "internal_error",
    );
    assert.ok(!JSON.stringify(res.body).includes("vectorize exploded"));
  });
});

describe("find_subnet_for_task — keyword callability filter arms", () => {
  test("keyword ranking drops a non-callable scored doc and tie-breaks equal scores by netuid", async () => {
    // doc 9 scores>0 but is NOT in the catalog (dropped → isCallable false arm);
    // docs 2 and 1 score equally and are callable → the sort comparator's
    // `b.relevance - a.relevance || a.netuid - b.netuid` exercises BOTH arms:
    // the relevance term (vs the dropped/other doc) and the netuid tie-break.
    const equalToken = ["dataword"];
    const deps = makeDeps({
      "/metagraph/search.json": {
        documents: [
          {
            type: "subnet",
            netuid: 2,
            slug: "sn-2",
            title: "Two",
            subtitle: "x",
            tokens: equalToken,
          },
          {
            type: "subnet",
            netuid: 1,
            slug: "sn-1",
            title: "One",
            subtitle: "x",
            tokens: equalToken,
          },
          {
            type: "subnet",
            netuid: 9,
            slug: "sn-9",
            title: "Nine",
            subtitle: "x",
            tokens: equalToken,
          },
        ],
      },
      "/metagraph/agent-catalog.json": {
        subnets: [
          {
            netuid: 1,
            name: "One",
            slug: "sn-1",
            categories: [],
            integration_readiness: 80,
            callable_count: 1,
            service_kinds: ["openapi"],
            base_url: "https://one.io",
            health: "operational",
          },
          {
            netuid: 2,
            name: "Two",
            slug: "sn-2",
            categories: [],
            integration_readiness: 80,
            callable_count: 1,
            service_kinds: ["openapi"],
            base_url: "https://two.io",
            health: "operational",
          },
        ],
      },
    });
    const res = await callTool(
      "find_subnet_for_task",
      { task: "dataword" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.discovery, "keyword");
    assert.equal(out.count, 2);
    // Equal relevance → ascending netuid tie-break: 1 then 2; 9 dropped.
    assert.deepEqual(
      out.results.map((r) => r.netuid),
      [1, 2],
    );
  });
});

describe("list_enrichment_targets — gap_code + severity matcher arms", () => {
  const scorecard = {
    rows: [
      {
        netuid: 7,
        slug: "g",
        name: "G",
        tier: "machine-usable",
        score: 50,
        priority_score: 60,
        agent_status: "callable",
        blocker_level: "none",
        top_gap_codes: ["missing-fixture"],
        top_gaps: [{ code: "missing-fixture", severity: "missing-data" }],
      },
    ],
    ranked_queue: [{ rank: 1, netuid: 7 }],
  };

  test("a matching gap_code passes the includes() arm; a non-matching one fails it", async () => {
    const deps = makeDeps({ "/metagraph/coverage-depth.json": scorecard });
    const hit = await callTool(
      "list_enrichment_targets",
      { gap_code: "missing-fixture" },
      { deps },
    );
    assert.equal(hit.body.result.structuredContent.returned, 1);

    const miss = await callTool(
      "list_enrichment_targets",
      { gap_code: "missing-schema" },
      { deps },
    );
    assert.equal(miss.body.result.structuredContent.returned, 0);
  });

  test("gap_code/severity filters default absent code/gap lists to [] before matching", async () => {
    // A row with NO top_gap_codes and NO top_gaps: the gapCode filter hits the
    // `(row.top_gap_codes || [])` [] fallback and the severity filter hits
    // the `(row.top_gaps || [])` [] fallback. Both exclude the row.
    const deps = makeDeps({
      "/metagraph/coverage-depth.json": {
        rows: [
          {
            netuid: 7,
            slug: "bare",
            name: "Bare",
            tier: "machine-usable",
            score: 50,
            priority_score: 60,
            agent_status: "callable",
            blocker_level: "none",
          },
        ],
        ranked_queue: [{ rank: 1, netuid: 7 }],
      },
    });
    const byCode = await callTool(
      "list_enrichment_targets",
      { gap_code: "missing-fixture" },
      { deps },
    );
    assert.equal(byCode.body.result.structuredContent.returned, 0);

    const bySeverity = await callTool(
      "list_enrichment_targets",
      { severity: "missing-data" },
      { deps },
    );
    assert.equal(bySeverity.body.result.structuredContent.returned, 0);
  });

  test("a matching severity passes the some() arm", async () => {
    const deps = makeDeps({ "/metagraph/coverage-depth.json": scorecard });
    const hit = await callTool(
      "list_enrichment_targets",
      { severity: "missing-data" },
      { deps },
    );
    assert.equal(hit.body.result.structuredContent.returned, 1);
  });

  test("a ranked_queue entry with no rank field maps rank to null", async () => {
    // entry.rank ?? null right arm.
    const deps = makeDeps({
      "/metagraph/coverage-depth.json": {
        rows: [
          {
            netuid: 7,
            slug: "g",
            name: "G",
            tier: "machine-usable",
            score: 50,
            priority_score: 60,
            agent_status: "callable",
            blocker_level: "none",
          },
        ],
        ranked_queue: [{ netuid: 7 }], // no rank
      },
    });
    const res = await callTool("list_enrichment_targets", {}, { deps });
    assert.equal(res.body.result.structuredContent.targets[0].rank, null);
  });
});

describe("find_subnets_by_capability — catalog subnets fallback", () => {
  test("tolerates an agent-catalog with no subnets array", async () => {
    // `Array.isArray(catalog.subnets) ? catalog.subnets : []` false arm.
    const deps = makeDeps({
      "/metagraph/agent-catalog.json": { subnets: null },
    });
    const res = await callTool(
      "find_subnets_by_capability",
      { capability: "data" },
      { deps },
    );
    assert.equal(res.body.result.structuredContent.total, 0);
  });
});

describe("get_best_rpc_endpoint — keep-existing + comparator arms", () => {
  test("dedupes scoreless duplicates and orders equal/scoreless endpoints by latency", async () => {
    // 'a': two scoreless eligible instances — the second does NOT beat the first
    //  (both `score || 0` → 0, not >), so the keep-existing arm fires and
    //  both `score || 0` fallbacks are exercised in the comparator.
    // 'd' (no score, latency 5) vs 'a' (no score, latency 20): the latency
    //  tie-break with `?? Infinity` orders 'd' first.
    // 'e' (no score, no latency → Infinity) sorts last.
    const deps = makeDeps({
      "/metagraph/rpc/pools.json": {
        pools: {
          0: {
            endpoints: [
              {
                id: "a",
                url: "wss://a.example",
                pool_eligible: true,
                latency_ms: 20,
              },
              {
                id: "d",
                url: "wss://d.example",
                pool_eligible: true,
                latency_ms: 5,
              },
              { id: "e", url: "wss://e.example", pool_eligible: true },
            ],
          },
          1: {
            endpoints: [
              {
                id: "a",
                url: "wss://a-dupe.example",
                pool_eligible: true,
                latency_ms: 1,
              },
            ],
          },
        },
      },
    });
    const res = await callTool("get_best_rpc_endpoint", { limit: 5 }, { deps });
    const out = res.body.result.structuredContent;
    assert.equal(out.eligible_count, 3);
    // Scoreless 'a' kept its first instance (url unchanged).
    const a = out.endpoints.find((e) => e.id === "a");
    assert.equal(a.url, "wss://a.example");
    // Equal (zero) score → latency asc: d(5) before a before e(Infinity).
    assert.deepEqual(
      out.endpoints.map((e) => e.id),
      ["d", "a", "e"],
    );
  });
});

describe("how_do_i_call — snippets fall through to null", () => {
  test("a callable service with no base_url and no stored snippets yields snippets null", async () => {
    // generateServiceSnippets(null) → null, no s.snippets → `|| null` final arm.
    const deps = makeDeps({
      "/metagraph/agent-catalog/7.json": {
        netuid: 7,
        name: "Data",
        slug: "sn-7",
        integration_readiness: 70,
        services: [
          {
            surface_id: "sn-7-api",
            kind: "subnet-api",
            capability: "Data API",
            base_url: null,
            auth_required: false,
            auth_schemes: [],
            schema_artifact: null,
            schema_url: null,
            eligibility: { callable: true },
          },
        ],
      },
    });
    const res = await callTool("how_do_i_call", { netuid: 7 }, { deps });
    assert.equal(res.body.result.structuredContent.services[0].snippets, null);
  });
});

// ── rankSubnetsForTask keyword docs fallback ───────────────────────────
describe("rankSubnetsForTask — keyword docs array fallback", () => {
  test("find_subnet_for_task tolerates a search index with no documents array", async () => {
    // `Array.isArray(index.documents) ? index.documents : []` false arm.
    const deps = makeDeps({
      "/metagraph/search.json": { documents: null },
      "/metagraph/agent-catalog.json": {
        subnets: [
          {
            netuid: 1,
            name: "One",
            slug: "sn-1",
            categories: [],
            integration_readiness: 80,
            callable_count: 1,
            service_kinds: ["openapi"],
            base_url: "https://one.io",
            health: "operational",
          },
        ],
      },
    });
    const res = await callTool(
      "find_subnet_for_task",
      { task: "anything" },
      { deps },
    );
    const out = res.body.result.structuredContent;
    assert.equal(out.discovery, "keyword");
    assert.equal(out.count, 0);
    assert.match(out.note, /No callable subnet/);
  });
});

// ── get_changelog — changelog artifact ────────────────────────────────────
describe("get_changelog — branch coverage", () => {
  test("surfaces non-not_found artifact failures", async () => {
    const deps = {
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
      readHealthKv: async () => null,
    };
    const res = await callTool("get_changelog", {}, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /artifact_timeout/);
    assert.match(res.body.result.content[0].text, /changelog\.json/);
  });
});

// ── get_adapter — adapter snapshot artifact ───────────────────────────────
describe("get_adapter — branch coverage", () => {
  test("surfaces non-not_found artifact failures", async () => {
    const deps = {
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
      readHealthKv: async () => null,
    };
    const res = await callTool("get_adapter", { slug: "gittensor" }, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /artifact_timeout/);
    assert.match(res.body.result.content[0].text, /adapters\/gittensor\.json/);
  });
});

// ── get_build — build summary artifact ────────────────────────────────────
describe("get_build — branch coverage", () => {
  test("surfaces non-not_found artifact failures", async () => {
    const deps = {
      readArtifact: async () => ({
        ok: false,
        code: "artifact_timeout",
      }),
      readHealthKv: async () => null,
    };
    const res = await callTool("get_build", {}, { deps });
    assert.equal(res.body.result.isError, true);
    assert.match(res.body.result.content[0].text, /artifact_timeout/);
    assert.match(res.body.result.content[0].text, /build-summary\.json/);
  });
});

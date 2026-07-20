import assert from "node:assert/strict";
import { Blob } from "node:buffer";
import {
  buildSchema,
  getIntrospectionQuery,
  parse,
  subscribe,
  validate,
} from "graphql";
import { describe, test } from "vitest";
import {
  FIELD_COMPLEXITY,
  GRAPHQL_MAX_BODY_BYTES,
  GRAPHQL_MAX_COMPLEXITY,
  GRAPHQL_MAX_DEPTH,
  GRAPHQL_MAX_QUERY_BYTES,
  GRAPHQL_SUBSCRIPTION_CONTEXT_KEY,
  SDL,
  handleGraphQLRequest,
  maxComplexityRule,
  maxDepthRule,
  schema as chainEventsSchema,
} from "../src/graphql.mjs";
import { LEADERBOARD_BOARDS } from "../src/health-serving.mjs";
import { CHAIN_PROMETHEUS_WINDOWS } from "../src/chain-prometheus.mjs";
import { CHAIN_SIGNERS_SORTS } from "../src/chain-query-loaders.mjs";
import { CHAIN_DEREGISTRATIONS_WINDOWS } from "../src/chain-deregistrations.mjs";
import { CHAIN_REGISTRATIONS_WINDOWS } from "../src/chain-registrations.mjs";
import { CHAIN_AXON_REMOVALS_WINDOWS } from "../src/chain-axon-removals.mjs";
import { handleRequest } from "../workers/api.mjs";
import { resolveClientIp, DAY_MS } from "../workers/config.mjs";
import {
  KV_ECONOMICS_CURRENT,
  KV_HEALTH_CURRENT,
  KV_HEALTH_META,
  KV_HEALTH_RPC_POOL,
} from "../src/kv-keys.mjs";

// Minimal fake env — no R2 or ASSETS, so readArtifact always returns ok:false.
const emptyEnv = {};

async function gql(query, env = emptyEnv, extras = {}) {
  const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, ...extras }),
  });
  const res = await handleGraphQLRequest(req, env);
  return { status: res.status, body: await res.json() };
}

// Inject synthetic artifacts (R2) and optional live KV tiers (health:current,
// economics:current — the fresh sources REST prefers) into a fake env. `reads`/
// `kvReads` record per-key access counts so tests can prove per-request read
// memoization. GraphQL source paths are R2-only; fixtures are keyed by full
// artifact path, e.g. "/metagraph/subnets.json". `kv` maps KV keys to values.
function fixtureEnv(fixtures = {}, { reads, kv, kvReads } = {}) {
  const env = {
    METAGRAPH_R2_LATEST_PREFIX: "latest/",
    METAGRAPH_ARCHIVE: {
      async get(key) {
        if (reads) reads.set(key, (reads.get(key) || 0) + 1);
        const path = "/metagraph/" + key.replace(/^latest\//, "");
        const data = fixtures[path];
        return data === undefined
          ? null
          : {
              async json() {
                return data;
              },
            };
      },
    },
  };
  if (kv) {
    env.METAGRAPH_CONTROL = {
      async get(key) {
        if (kvReads) kvReads.set(key, (kvReads.get(key) || 0) + 1);
        return Object.hasOwn(kv, key) ? kv[key] : null;
      },
    };
  }
  return env;
}

describe("handleGraphQLRequest — method guard", () => {
  test("GET publishes the SDL document (discoverability)", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql");
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/graphql/);
    assert.equal(res.headers.get("allow"), "GET, POST");
    const sdl = await res.text();
    // The published shape advertises the broadened graph + its relationships.
    assert.ok(sdl.includes("type Query"));
    assert.ok(sdl.includes("opportunity_boards"));
    assert.ok(sdl.includes("type Subnet"));
    assert.ok(sdl.includes("health: SubnetHealth"));
  });

  test("an unsupported method (PUT) returns 405 advertising GET, POST", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "PUT",
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.ok(body.errors[0].message.includes("POST"));
    assert.equal(res.headers.get("allow"), "GET, POST");
  });
});

describe("handleRequest — GraphQL routing", () => {
  test("POST /api/v1/graphql reaches the GraphQL handler", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "{ __typename }" }),
    });
    const res = await handleRequest(req, emptyEnv, {});
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("allow"), null);
    assert.deepEqual(await res.json(), { data: { __typename: "Query" } });
  });

  test("OPTIONS /api/v1/graphql advertises GET + POST for CORS preflight", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "OPTIONS",
      }),
      emptyEnv,
      {},
    );
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "GET, POST, OPTIONS",
    );
  });

  test("GET /api/v1/graphql through the router returns the SDL", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql"),
      emptyEnv,
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /application\/graphql/);
    assert.ok((await res.text()).includes("type Query"));
  });
});

describe("handleGraphQLRequest — request validation", () => {
  test("non-JSON body returns 400", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(body.errors[0].message.includes("JSON"));
  });

  test("oversized Content-Length is rejected before reading the body", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(GRAPHQL_MAX_BODY_BYTES + 1),
      },
      body: JSON.stringify({ query: "{ __typename }" }),
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.ok(body.errors[0].message.includes("body"));
  });

  test("oversized streaming body without Content-Length is rejected", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Blob([" ".repeat(GRAPHQL_MAX_BODY_BYTES + 1)]).stream(),
      duplex: "half",
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.ok(body.errors[0].message.includes("body"));
  });

  test("oversized GraphQL query is rejected before parsing", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: `# ${"x".repeat(GRAPHQL_MAX_QUERY_BYTES)}\n{ __typename }`,
      }),
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 413);
    const body = await res.json();
    assert.ok(body.errors[0].message.includes("query"));
  });

  test("missing query field returns 400", async () => {
    const { status, body } = await gql(undefined);
    assert.equal(status, 400);
    assert.ok(body.errors[0].message.includes("query"));
  });

  test("empty query string returns 400", async () => {
    const { status, body } = await gql("   ");
    assert.equal(status, 400);
    assert.ok(body.errors[0].message.includes("query"));
  });

  test("syntax error in query returns 400", async () => {
    const { status, body } = await gql("{ subnets { ");
    assert.equal(status, 400);
    assert.ok(body.errors.length > 0);
  });
});

describe("handleGraphQLRequest — validation rules", () => {
  test("unknown field name returns 400", async () => {
    const { status, body } = await gql("{ nonExistentField }");
    assert.equal(status, 400);
    assert.ok(body.errors.length > 0);
  });

  test("depth exceeded returns DEPTH_LIMIT_EXCEEDED extension", async () => {
    // Build a query that nests past the limit. With max depth 7, we need 8 levels.
    // subnets.items counts as depth 1, then we'd need 7 more nesting levels.
    // Since we only have depth-2 types, force it via aliases repeating subnets.
    // Actually build an artificially deep introspection-style query.
    const deep =
      "{ " +
      "subnets { items { ".repeat(GRAPHQL_MAX_DEPTH + 1) +
      "netuid" +
      " } }".repeat(GRAPHQL_MAX_DEPTH + 1) +
      " }";
    const { status, body } = await gql(deep);
    assert.equal(status, 400);
    const ext = body.errors.find(
      (e) => e.extensions?.code === "DEPTH_LIMIT_EXCEEDED",
    );
    assert.ok(
      ext,
      `expected DEPTH_LIMIT_EXCEEDED, got: ${JSON.stringify(body.errors)}`,
    );
  });

  test("standard introspection query is accepted over POST", async () => {
    // The full getIntrospectionQuery() is intrinsically deeper/wider than the
    // data limits; exempting the schema-only __schema/__type roots keeps it
    // working for tooling (GraphiQL/Apollo/codegen) as the contract promises.
    const { status, body } = await gql(getIntrospectionQuery());
    assert.equal(
      status,
      200,
      `introspection must not be rejected, got: ${JSON.stringify(body.errors)}`,
    );
    assert.ok(body.data?.__schema?.types?.length > 0);
  });

  test("introspection exemption does not let sibling data fields bypass depth", async () => {
    // A query that pairs __schema with an over-deep real data selection must
    // still be rejected on the data portion — the exemption is scoped to the
    // schema-only meta-field subtree, not the whole operation.
    const deepData =
      "subnets { items { ".repeat(GRAPHQL_MAX_DEPTH + 1) +
      "netuid" +
      " } }".repeat(GRAPHQL_MAX_DEPTH + 1);
    const { status, body } = await gql(
      `{ __schema { queryType { name } } ${deepData} }`,
    );
    assert.equal(status, 400);
    assert.ok(
      body.errors.find((e) => e.extensions?.code === "DEPTH_LIMIT_EXCEEDED"),
      `expected DEPTH_LIMIT_EXCEEDED, got: ${JSON.stringify(body.errors)}`,
    );
  });

  test("complexity counts fields inside named fragments (no spread bypass)", async () => {
    // Moving the whole selection into a fragment must NOT bypass the limit: the
    // spread is transparent, so its fields are counted at the operation level.
    const fields = Array.from(
      { length: GRAPHQL_MAX_COMPLEXITY + 1 },
      (_, i) => `t${i}: __typename`,
    ).join(" ");
    const q = `query { ...Big } fragment Big on Query { ${fields} }`;
    const { status, body } = await gql(q);
    assert.equal(status, 400);
    const ext = body.errors.find(
      (e) => e.extensions?.code === "COMPLEXITY_LIMIT_EXCEEDED",
    );
    assert.ok(
      ext,
      `expected COMPLEXITY_LIMIT_EXCEEDED, got: ${JSON.stringify(body.errors)}`,
    );
  });

  test("depth counts nesting inside named fragments (no spread bypass)", async () => {
    // Deep nesting hidden inside a fragment must still be counted. Without
    // following the spread, the operation's selection set is just `...Big` and
    // counts as depth 0, bypassing the limit.
    const nested =
      "subnets { items { ".repeat(GRAPHQL_MAX_DEPTH + 1) +
      "netuid" +
      " } }".repeat(GRAPHQL_MAX_DEPTH + 1);
    const q = `query { ...Big } fragment Big on Query { ${nested} }`;
    const { status, body } = await gql(q);
    assert.equal(status, 400);
    const ext = body.errors.find(
      (e) => e.extensions?.code === "DEPTH_LIMIT_EXCEEDED",
    );
    assert.ok(
      ext,
      `expected DEPTH_LIMIT_EXCEEDED, got: ${JSON.stringify(body.errors)}`,
    );
  });

  test("validation memoizes repeated named fragment spreads", async () => {
    const fragments = ["fragment F0 on Query { __typename }"];
    for (let i = 1; i <= 20; i += 1) {
      fragments.push(`fragment F${i} on Query { ...F${i - 1} ...F${i - 1} }`);
    }
    const q = `query { ...F20 } ${fragments.join(" ")}`;
    const { status, body } = await gql(q);
    assert.equal(status, 400);
    const ext = body.errors.find(
      (e) => e.extensions?.code === "COMPLEXITY_LIMIT_EXCEEDED",
    );
    assert.ok(
      ext,
      `expected COMPLEXITY_LIMIT_EXCEEDED, got: ${JSON.stringify(body.errors)}`,
    );
  });

  test("inline fragments are transparent for complexity (no over-count)", async () => {
    // Exactly at the limit, wrapped in a type-conditional inline fragment. The
    // inline fragment is not a field, so this must pass — counting it would
    // over-measure (51) and wrongly reject a query identical to its inlined form.
    const fields = Array.from(
      { length: GRAPHQL_MAX_COMPLEXITY },
      (_, i) => `t${i}: __typename`,
    ).join(" ");
    const inlineFrag = await gql(`query { ... on Query { ${fields} } }`);
    assert.equal(
      inlineFrag.status,
      200,
      `inline-fragment query should match its inlined form: ${JSON.stringify(inlineFrag.body.errors)}`,
    );
    // Same fields without the inline fragment also pass — equal measurement.
    const plain = await gql(`query { ${fields} }`);
    assert.equal(plain.status, 200);
    // One field over the limit is still rejected through the inline fragment.
    const over = await gql(
      `query { ... on Query { ${fields} t_extra: __typename } }`,
    );
    assert.equal(over.status, 400);
    assert.ok(
      over.body.errors.find(
        (e) => e.extensions?.code === "COMPLEXITY_LIMIT_EXCEEDED",
      ),
    );
  });

  test("maxDepthRule treats inline fragments transparently", () => {
    // `{ a { b { c } } }` is depth 2 (a->1, b->2; c is a scalar leaf). Wrapping
    // the selection in an inline fragment must NOT add a level — otherwise the
    // inline form measures depth 3 and is wrongly rejected at limit 2.
    const depthSchema = buildSchema(
      `type Query { a: A } type A { b: B } type B { c: Int }`,
    );
    const plain = parse("{ a { b { c } } }");
    const inline = parse("{ ... on Query { a { b { c } } } }");
    assert.equal(validate(depthSchema, plain, [maxDepthRule(2)]).length, 0);
    assert.equal(
      validate(depthSchema, inline, [maxDepthRule(2)]).length,
      0,
      "inline-wrapped query must measure the same depth as its inlined form",
    );
    // Transparency is not a free pass: limit 1 still rejects both equally.
    assert.equal(validate(depthSchema, plain, [maxDepthRule(1)]).length, 1);
    assert.equal(validate(depthSchema, inline, [maxDepthRule(1)]).length, 1);
  });

  test("complexity exceeded returns COMPLEXITY_LIMIT_EXCEEDED extension", async () => {
    // GRAPHQL_MAX_COMPLEXITY is 50. Build a query with many fields by using
    // inline fragments or repeating aliases to exceed the limit.
    const fields = Array.from(
      { length: GRAPHQL_MAX_COMPLEXITY + 1 },
      (_, i) => `f${i}: subnets { items { netuid } }`,
    ).join(" ");
    const { status, body } = await gql(`{ ${fields} }`);
    assert.equal(status, 400);
    const ext = body.errors.find(
      (e) => e.extensions?.code === "COMPLEXITY_LIMIT_EXCEEDED",
    );
    assert.ok(
      ext,
      `expected COMPLEXITY_LIMIT_EXCEEDED, got: ${JSON.stringify(body.errors)}`,
    );
  });
});

describe("handleGraphQLRequest — introspection", () => {
  test("introspection query succeeds and includes Query type", async () => {
    const { status, body } = await gql("{ __schema { queryType { name } } }");
    assert.equal(status, 200);
    assert.equal(body.data.__schema.queryType.name, "Query");
  });

  test("__type on Subnet returns defined fields", async () => {
    const { status, body } = await gql(
      '{ __type(name: "Subnet") { fields { name } } }',
    );
    assert.equal(status, 200);
    const names = body.data.__type.fields.map((f) => f.name);
    assert.ok(names.includes("netuid"), `expected netuid, got: ${names}`);
    assert.ok(names.includes("name"), `expected name, got: ${names}`);
  });
});

describe("handleGraphQLRequest — resolvers (cold store)", () => {
  test("subnets returns empty list when artifact not found", async () => {
    const { status, body } = await gql(
      "{ subnets { items { netuid } total } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnets, { items: [], total: 0 });
  });

  test("subnet returns null when artifact not found", async () => {
    const { status, body } = await gql("{ subnet(netuid: 1) { netuid name } }");
    assert.equal(status, 200);
    assert.equal(body.data.subnet, null);
  });

  test("providers returns empty list when artifact not found", async () => {
    const { status, body } = await gql(
      "{ providers { items { id name } total } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.providers, { items: [], total: 0 });
  });

  test("provider returns null when artifact not found", async () => {
    const { status, body } = await gql('{ provider(id: "acme") { id name } }');
    assert.equal(status, 200);
    assert.equal(body.data.provider, null);
  });

  test("economics returns empty list when artifact not found", async () => {
    const { status, body } = await gql(
      "{ economics { subnets { netuid } total } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.economics, { subnets: [], total: 0 });
  });
});

describe("handleGraphQLRequest — resolvers (injected data)", () => {
  test("subnets resolves items and total from fixture data", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "Alpha", slug: "alpha" },
          { netuid: 2, name: "Beta", slug: "beta" },
        ],
      },
    });
    const { status, body } = await gql(
      "{ subnets { items { netuid name slug } total } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 2);
    assert.equal(body.data.subnets.items[0].netuid, 1);
    assert.equal(body.data.subnets.items[1].name, "Beta");
  });

  test("subnets pagination: limit and next_cursor", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A", slug: "a" },
          { netuid: 2, name: "B", slug: "b" },
          { netuid: 3, name: "C", slug: "c" },
        ],
      },
    });
    const { status, body } = await gql(
      "{ subnets(limit: 2) { items { netuid } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.items.length, 2);
    assert.equal(body.data.subnets.next_cursor, "2");
    assert.equal(body.data.subnets.total, 3);
  });

  test("subnets limit:0 falls back to the default page (not clamped up to 1)", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A", slug: "a" },
          { netuid: 2, name: "B", slug: "b" },
          { netuid: 3, name: "C", slug: "c" },
        ],
      },
    });
    for (const limit of [0, -5]) {
      const { status, body } = await gql(
        `{ subnets(limit: ${limit}) { items { netuid } total } }`,
        env,
      );
      assert.equal(status, 200);
      assert.equal(body.data.subnets.items.length, 3, `limit:${limit}`);
      assert.equal(body.data.subnets.total, 3);
    }
  });

  test("subnets filters by netuid", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A", slug: "a" },
          { netuid: 2, name: "B", slug: "b" },
          { netuid: 3, name: "C", slug: "c" },
        ],
      },
    });
    const { status, body } = await gql(
      "{ subnets(netuid: 2) { items { netuid name } total } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 1);
    assert.deepEqual(body.data.subnets.items, [{ netuid: 2, name: "B" }]);
  });

  test("subnets filters by status (case-insensitive)", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A", slug: "a", status: "active" },
          { netuid: 2, name: "B", slug: "b", status: "inactive" },
          { netuid: 3, name: "C", slug: "c", status: "active" },
        ],
      },
    });
    const { status, body } = await gql(
      '{ subnets(status: "Active") { items { netuid } total } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 2);
    assert.deepEqual(
      body.data.subnets.items.map((row) => row.netuid),
      [1, 3],
    );
  });

  test("subnets filters exclude rows missing the filtered field", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A", slug: "a", status: "active" },
          { netuid: 2, name: "B", slug: "b" },
        ],
      },
    });
    const { status, body } = await gql(
      '{ subnets(status: "active") { items { netuid } total } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 1);
    assert.deepEqual(body.data.subnets.items, [{ netuid: 1 }]);
  });

  test("subnets filters by domain via derived_categories", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          {
            netuid: 1,
            name: "A",
            slug: "a",
            categories: ["inference"],
          },
          {
            netuid: 2,
            name: "B",
            slug: "b",
            derived_categories: ["training"],
          },
          {
            netuid: 3,
            name: "C",
            slug: "c",
            categories: ["other"],
          },
        ],
      },
    });
    const { status, body } = await gql(
      '{ subnets(domain: "training") { items { netuid } total } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 1);
    assert.deepEqual(body.data.subnets.items, [{ netuid: 2 }]);
  });

  test("subnet resolves a single subnet by netuid", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets/7.json": {
        netuid: 7,
        name: "Tao Subnet",
        slug: "tao",
      },
    });
    const { status, body } = await gql(
      "{ subnet(netuid: 7) { netuid name slug } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnet.netuid, 7);
    assert.equal(body.data.subnet.name, "Tao Subnet");
  });

  test("subnet backfills the list-only computed metrics the detail artifact omits", async () => {
    // The detail artifact omits integration_readiness/official_surface_count/
    // gap_count/first_party, which only the list artifact computes. Without the
    // backfill the single-subnet path returns them null while `subnets` does not.
    const env = fixtureEnv({
      "/metagraph/subnets/7.json": {
        netuid: 7,
        name: "Detail Name",
        slug: "x",
      },
      "/metagraph/subnets.json": {
        subnets: [
          {
            netuid: 7,
            name: "List Name",
            integration_readiness: 86,
            official_surface_count: 0,
            gap_count: 0,
            first_party: false,
          },
        ],
      },
    });
    const { status, body } = await gql(
      `{ subnet(netuid: 7) {
        name
        integration_readiness
        official_surface_count
        gap_count
        first_party
      } }`,
      env,
    );
    assert.equal(status, 200);
    const s = body.data.subnet;
    assert.equal(s.integration_readiness, 86);
    assert.equal(s.official_surface_count, 0);
    assert.equal(s.gap_count, 0);
    assert.equal(s.first_party, false);
    // The detail artifact stays authoritative for identity on shared keys.
    assert.equal(s.name, "Detail Name");
  });

  test("providers normalises missing netuids to empty array", async () => {
    const env = fixtureEnv({
      "/metagraph/providers.json": {
        providers: [{ id: "acme", name: "Acme" }],
      },
    });
    const { status, body } = await gql(
      "{ providers { items { id netuids } total } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.providers.items[0].netuids, []);
  });

  test("provider resolves a valid slug id from the store", async () => {
    const env = fixtureEnv({
      "/metagraph/providers/acme-1.0.json": { id: "acme-1.0", name: "Acme" },
    });
    const { status, body } = await gql(
      '{ provider(id: "acme-1.0") { id name } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.provider.name, "Acme");
  });

  test("provider rejects a traversal/invalid id without reading any artifact", async () => {
    // The id is interpolated into the artifact path and the static-asset tier
    // collapses "../", so an unvalidated id could escape the providers/
    // namespace. The resolver must reject a non-slug id BEFORE touching storage.
    let reads = 0;
    const env = {
      METAGRAPH_R2_LATEST_PREFIX: "latest/",
      METAGRAPH_ARCHIVE: {
        async get() {
          reads += 1;
          return null;
        },
      },
    };
    for (const id of ["../subnets", "../../economics", "a/b", "foo bar", ""]) {
      const { status, body } = await gql(
        `{ provider(id: ${JSON.stringify(id)}) { id name } }`,
        env,
      );
      assert.equal(status, 200, id);
      assert.equal(body.data.provider, null, id);
    }
    assert.equal(reads, 0, "no artifact read should happen for an invalid id");
  });

  test("economics returns subnet economics list", async () => {
    const env = fixtureEnv({
      "/metagraph/economics.json": {
        subnets: [
          { netuid: 1, name: "Root", emission_share: 0.05, miner_count: 10 },
        ],
      },
    });
    const { status, body } = await gql(
      "{ economics { total subnets { netuid name emission_share miner_count } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.economics.total, 1);
    assert.equal(body.data.economics.subnets[0].netuid, 1);
    assert.equal(body.data.economics.subnets[0].emission_share, 0.05);
  });

  test("economics exposes the network-value summary rollup (#6641)", async () => {
    const env = fixtureEnv({
      "/metagraph/economics.json": {
        subnets: [{ netuid: 1, name: "Alpha", emission_share: 1 }],
        summary: {
          subnet_count: 1,
          with_economics_count: 1,
          total_stake_tao: "1000.000000000",
          total_validators: 9,
          total_miners: 200,
          registration_open_count: 1,
          total_root_value_tao: "500.000000000",
          total_alpha_value_tao: "40.000000000",
          total_network_value_tao: "540.000000000",
        },
      },
    });
    const { status, body } = await gql(
      `{ economics { summary {
          total_root_value_tao total_alpha_value_tao total_network_value_tao
          subnet_count
        } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.economics.summary, {
      total_root_value_tao: "500.000000000",
      total_alpha_value_tao: "40.000000000",
      total_network_value_tao: "540.000000000",
      subnet_count: 1,
    });
  });

  test("economics.summary is null when the source artifact has none", async () => {
    const env = fixtureEnv({
      "/metagraph/economics.json": {
        subnets: [{ netuid: 1, name: "Alpha" }],
      },
    });
    const { status, body } = await gql(
      "{ economics { summary { subnet_count } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.economics.summary, null);
  });
});

describe("handleGraphQLRequest — error envelope is never cacheable", () => {
  const post = (env) =>
    handleGraphQLRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: "{ subnets { items { netuid } total } }",
        }),
      }),
      env,
    );

  test("a clean POST keeps the success cache directive", async () => {
    const res = await post(emptyEnv);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(
      res.headers.get("cache-control"),
      "public, max-age=60, stale-while-revalidate=300",
    );
  });

  // A thrown artifact read surfaces in result.errors while execute() stays 200:
  // readR2 parses the body outside its try/catch, so the rejection propagates.
  test("a populated result.errors switches to no-store", async () => {
    const env = {
      METAGRAPH_R2_LATEST_PREFIX: "latest/",
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            async json() {
              throw new Error("corrupt artifact body");
            },
          };
        },
      },
    };
    const res = await post(env);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok(body.errors?.length > 0);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });
});

describe("maxDepthRule / maxComplexityRule exports", () => {
  test("GRAPHQL_MAX_DEPTH is a positive integer", () => {
    assert.ok(Number.isInteger(GRAPHQL_MAX_DEPTH) && GRAPHQL_MAX_DEPTH > 0);
  });

  test("GRAPHQL_MAX_COMPLEXITY is a positive integer", () => {
    assert.ok(
      Number.isInteger(GRAPHQL_MAX_COMPLEXITY) && GRAPHQL_MAX_COMPLEXITY > 0,
    );
  });

  test("maxDepthRule returns a function", () => {
    assert.equal(typeof maxDepthRule(5), "function");
  });

  test("maxComplexityRule returns a function", () => {
    assert.equal(typeof maxComplexityRule(10), "function");
  });
});

describe("handleGraphQLRequest — coverage edge cases", () => {
  // Fragment definitions are non-operation nodes that depth/complexity rules
  // must skip over (def.kind !== "OperationDefinition").
  test("query with named operation and fragment definition succeeds", async () => {
    const q = `
      fragment SubnetFields on Subnet { netuid name }
      query GetSubnet { subnet(netuid: 1) { ...SubnetFields } }
    `;
    const { status, body } = await gql(q);
    assert.equal(status, 200);
    assert.ok("subnet" in body.data);
  });

  // Cursor not found in items → start stays 0 (no crash).
  test("subnets with an unresolvable cursor returns first page", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A" },
          { netuid: 2, name: "B" },
        ],
      },
    });
    const { status, body } = await gql(
      '{ subnets(cursor: "999") { items { netuid } total } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.items.length, 2);
  });

  // Data keys missing from artifact (subnets array absent → empty list).
  test("subnets artifact without subnets key returns empty list", async () => {
    const env = fixtureEnv({ "/metagraph/subnets.json": {} });
    const { status, body } = await gql("{ subnets { total } }", env);
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 0);
  });

  // Providers artifact without providers key → empty list.
  test("providers artifact without providers key returns empty list", async () => {
    const env = fixtureEnv({ "/metagraph/providers.json": {} });
    const { status, body } = await gql("{ providers { total } }", env);
    assert.equal(status, 200);
    assert.equal(body.data.providers.total, 0);
  });

  // Provider artifact with netuids present → returned as-is.
  test("provider artifact with netuids returns them", async () => {
    const env = fixtureEnv({
      "/metagraph/providers/acme.json": {
        id: "acme",
        name: "Acme Corp",
        netuids: [1, 7],
      },
    });
    const { status, body } = await gql(
      '{ provider(id: "acme") { netuids } }',
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.provider.netuids, [1, 7]);
  });
});

// Security hardening (#1: GraphQL must run through the rate limiter). GraphQL is
// POST-only and fans out into artifact reads, so it shares the strict RPC
// limiter binding. A counting limiter that allows the first N keyed hits and
// denies the rest models the Cloudflare binding closely enough to prove the
// gate fires on /api/v1/graphql.
function countingRateLimiterEnv(limit, extra = {}) {
  const counts = new Map();
  return {
    ...extra,
    RPC_RATE_LIMITER: {
      limit({ key }) {
        const next = (counts.get(key) || 0) + 1;
        counts.set(key, next);
        return Promise.resolve({ success: next <= limit });
      },
    },
  };
}

const gqlPost = (env, headers = {}) =>
  handleRequest(
    new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ query: "{ __typename }" }),
    }),
    env,
    {},
  );

describe("handleRequest — GraphQL rate limiting (#security)", () => {
  test("N requests within the window pass, the N+1 returns 429", async () => {
    const N = 3;
    const env = countingRateLimiterEnv(N);
    // The first N requests are under the limit and reach the handler (200).
    for (let i = 0; i < N; i += 1) {
      const res = await gqlPost(env);
      assert.equal(res.status, 200, `request ${i + 1} should pass`);
    }
    // The N+1th request is over the limit -> 429 from the GraphQL gate.
    const limited = await gqlPost(env);
    assert.equal(limited.status, 429);
    const body = await limited.json();
    assert.equal(body.error.code, "graphql_rate_limited");
    assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal(limited.headers.get("x-ratelimit-remaining"), "0");
  });

  test("no limiter binding (local/CI) lets GraphQL through", async () => {
    // emptyEnv has no RPC_RATE_LIMITER; the gate must no-op, not 429.
    const res = await gqlPost(emptyEnv);
    assert.equal(res.status, 200);
  });

  test("a WebSocket upgrade bypasses the rate limiter entirely, even with an already-exhausted budget", async () => {
    const env = countingRateLimiterEnv(0); // every check() would fail
    let forwarded = false;
    env.CHAIN_FIREHOSE_HUB = {
      idFromName: () => "global",
      get: () => ({
        fetch: () => {
          forwarded = true;
          return new Response(null, { status: 200 });
        },
      }),
    };
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        headers: { upgrade: "websocket" },
      }),
      env,
      {},
    );
    assert.equal(res.status, 200);
    assert.equal(forwarded, true);
  });
});

describe("client IP resolution — x-forwarded-for is not trusted (#security)", () => {
  test("resolveClientIp ignores x-forwarded-for, uses cf-connecting-ip only", () => {
    const sameCf = (xff) =>
      resolveClientIp(
        new Request("https://api.metagraph.sh/api/v1/graphql", {
          method: "POST",
          headers: {
            "cf-connecting-ip": "203.0.113.7",
            "x-forwarded-for": xff,
          },
        }),
      );
    // Two forged XFF values, same trusted cf-connecting-ip -> identical key.
    assert.equal(sameCf("1.1.1.1"), sameCf("9.9.9.9"));
    assert.equal(sameCf("1.1.1.1"), "203.0.113.7");
  });

  test("absent cf-connecting-ip falls back to a fixed bucket, not the XFF header", () => {
    const key = resolveClientIp(
      new Request("https://api.metagraph.sh/api/v1/graphql", {
        method: "POST",
        headers: { "x-forwarded-for": "attacker-controlled" },
      }),
    );
    assert.equal(key, "anonymous");
    assert.notEqual(key, "attacker-controlled");
  });

  test("two forged x-forwarded-for share ONE rate-limit bucket (2nd is limited)", async () => {
    // limit=1: the first request from cf-connecting-ip 203.0.113.7 passes; a
    // second request with the SAME cf-connecting-ip but a DIFFERENT forged
    // x-forwarded-for must be counted in the same bucket -> 429. If the forged
    // header were honored it would mint a fresh bucket and wrongly pass.
    const env = countingRateLimiterEnv(1);
    const first = await gqlPost(env, {
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "10.0.0.1",
    });
    assert.equal(first.status, 200);
    const second = await gqlPost(env, {
      "cf-connecting-ip": "203.0.113.7",
      "x-forwarded-for": "10.0.0.2",
    });
    assert.equal(second.status, 429);
    assert.equal((await second.json()).error.code, "graphql_rate_limited");
  });
});

// --- Broadened registry coverage --------------------------------------------

describe("graphql — broadened Subnet + nested relationships", () => {
  test("subnet detail serves bundled surfaces/endpoints from one read; economics loads lazily", async () => {
    const reads = new Map();
    const env = fixtureEnv(
      {
        // The real detail artifact has no economics key (REST overlays it live),
        // but it does bundle surfaces/endpoints.
        "/metagraph/subnets/7.json": {
          subnet: {
            netuid: 7,
            name: "Allways",
            slug: "allways",
            categories: ["inference"],
            status: "active",
            integration_readiness: 80,
          },
          surfaces: [{ id: "s1", netuid: 7, kind: "subnet-api", status: "ok" }],
          endpoints: [{ id: "e1", netuid: 7, status: "ok", kind: "rpc" }],
        },
        "/metagraph/economics.json": {
          subnets: [{ netuid: 7, emission_share: 0.12, open_slots: 4 }],
        },
      },
      { reads },
    );
    const { status, body } = await gql(
      `{ subnet(netuid: 7) {
          netuid name slug categories status integration_readiness
          economics { netuid emission_share open_slots }
          surfaces { id kind status }
          endpoints { id kind status }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const s = body.data.subnet;
    assert.equal(s.netuid, 7);
    assert.equal(s.name, "Allways");
    assert.deepEqual(s.categories, ["inference"]);
    assert.equal(s.integration_readiness, 80);
    assert.equal(s.economics.emission_share, 0.12);
    assert.equal(s.surfaces[0].kind, "subnet-api");
    assert.equal(s.endpoints[0].id, "e1");
    // surfaces/endpoints came from the detail artifact (never read separately);
    // economics is not in it, so it loads lazily — once.
    assert.equal(reads.get("latest/subnets/7.json"), 1);
    assert.equal(reads.get("latest/economics.json"), 1);
    assert.equal(reads.has("latest/surfaces.json"), false);
    assert.equal(reads.has("latest/endpoints.json"), false);
  });

  test("subnet.health resolves from the live health snapshot by netuid", async () => {
    const env = fixtureEnv(
      {
        "/metagraph/subnets/7.json": { subnet: { netuid: 7, name: "Allways" } },
      },
      {
        kv: {
          [KV_HEALTH_CURRENT]: {
            subnets: [
              { netuid: 7, status: "ok", ok_count: 3, surface_count: 3 },
              { netuid: 8, status: "failed", ok_count: 0 },
            ],
          },
        },
      },
    );
    const { status, body } = await gql(
      "{ subnet(netuid: 7) { netuid health { status ok_count surface_count } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnet.health.status, "ok");
    assert.equal(body.data.subnet.health.ok_count, 3);
  });

  test("list items resolve economics/health by netuid, reading each source once (memoized)", async () => {
    const reads = new Map();
    const kvReads = new Map();
    const env = fixtureEnv(
      {
        "/metagraph/subnets.json": {
          subnets: [
            { netuid: 1, name: "A" },
            { netuid: 2, name: "B" },
          ],
        },
        "/metagraph/economics.json": {
          subnets: [
            { netuid: 1, emission_share: 0.1 },
            { netuid: 2, emission_share: 0.2 },
          ],
        },
      },
      {
        reads,
        kvReads,
        kv: {
          [KV_HEALTH_CURRENT]: {
            subnets: [
              { netuid: 1, status: "ok" },
              { netuid: 2, status: "degraded" },
            ],
          },
        },
      },
    );
    const { status, body } = await gql(
      "{ subnets { items { netuid economics { emission_share } health { status } } total } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 2);
    assert.equal(body.data.subnets.items[0].economics.emission_share, 0.1);
    assert.equal(body.data.subnets.items[1].health.status, "degraded");
    // Two items, but the economics source and the live health snapshot are each
    // resolved exactly once.
    assert.equal(reads.get("latest/economics.json"), 1);
    assert.equal(kvReads.get(KV_HEALTH_CURRENT), 1);
  });

  test("provider.subnets resolves the provider's netuids to full subnet nodes", async () => {
    const env = fixtureEnv({
      "/metagraph/providers/acme.json": {
        provider: { id: "acme", name: "Acme", netuids: [2, 1] },
      },
      "/metagraph/subnets.json": {
        subnets: [
          { netuid: 1, name: "A", slug: "a" },
          { netuid: 2, name: "B", slug: "b" },
        ],
      },
    });
    const { status, body } = await gql(
      '{ provider(id: "acme") { id netuids subnets { netuid name } } }',
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.provider.netuids, [2, 1]);
    // Order follows the provider's netuids list.
    assert.equal(body.data.provider.subnets[0].netuid, 2);
    assert.equal(body.data.provider.subnets[1].name, "A");
  });

  test("provider.endpoints returns the provider's full baked endpoint list", async () => {
    const env = fixtureEnv({
      "/metagraph/providers/acme.json": {
        provider: { id: "acme", name: "Acme", netuids: [] },
      },
      "/metagraph/providers/acme/endpoints.json": {
        endpoints: [
          { id: "acme-e1", kind: "rpc", status: "ok", netuid: 1 },
          { id: "acme-e2", kind: "subnet-api", status: "degraded", netuid: 2 },
        ],
      },
    });
    const { status, body } = await gql(
      '{ provider(id: "acme") { id endpoints { id kind status netuid } } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.provider.endpoints.length, 2);
    assert.deepEqual(body.data.provider.endpoints[0], {
      id: "acme-e1",
      kind: "rpc",
      status: "ok",
      netuid: 1,
    });
    assert.equal(body.data.provider.endpoints[1].id, "acme-e2");
  });

  test("provider.endpoints degrades to an empty list when the artifact is absent", async () => {
    const env = fixtureEnv({
      "/metagraph/providers/acme.json": {
        provider: { id: "acme", name: "Acme", netuids: [] },
      },
      // no /metagraph/providers/acme/endpoints.json fixture
    });
    const { status, body } = await gql(
      '{ provider(id: "acme") { id endpoints { id } } }',
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.provider.endpoints, []);
  });
});

describe("graphql — surfaces / endpoints / health roots", () => {
  test("surfaces filters by netuid and paginates", async () => {
    const env = fixtureEnv({
      "/metagraph/surfaces.json": {
        surfaces: [
          { id: "s1", netuid: 1, kind: "subnet-api" },
          { id: "s2", netuid: 2, kind: "rpc" },
          { id: "s3", netuid: 1, kind: "sse" },
        ],
      },
    });
    const filtered = await gql(
      "{ surfaces(netuid: 1) { items { id netuid } total } }",
      env,
    );
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.surfaces.total, 2);
    assert.ok(filtered.body.data.surfaces.items.every((s) => s.netuid === 1));

    const paged = await gql(
      "{ surfaces(limit: 1) { items { id } total next_cursor } }",
      env,
    );
    assert.equal(paged.body.data.surfaces.items.length, 1);
    assert.equal(paged.body.data.surfaces.total, 3);
    assert.equal(paged.body.data.surfaces.next_cursor, "s1");
  });

  test("endpoints filters by netuid", async () => {
    const env = fixtureEnv({
      "/metagraph/endpoints.json": {
        endpoints: [
          { id: "e1", netuid: 5, status: "ok" },
          { id: "e2", netuid: 6, status: "failed" },
        ],
      },
    });
    const { status, body } = await gql(
      "{ endpoints(netuid: 6) { items { id status netuid } total } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.endpoints.total, 1);
    assert.equal(body.data.endpoints.items[0].id, "e2");
  });

  test("endpoints paginate, falling back to surface_id for the cursor when id is absent", async () => {
    const env = fixtureEnv({
      "/metagraph/endpoints.json": {
        endpoints: [
          { surface_id: "x1", netuid: 1, status: "ok" }, // no id → cursor uses surface_id
          { id: "e2", netuid: 2, status: "failed" },
        ],
      },
    });
    const first = await gql(
      "{ endpoints(limit: 1) { items { status } total next_cursor } }",
      env,
    );
    assert.equal(first.body.data.endpoints.total, 2);
    assert.equal(first.body.data.endpoints.next_cursor, "x1");
    const second = await gql(
      '{ endpoints(limit: 1, cursor: "x1") { items { id } } }',
      env,
    );
    assert.equal(second.body.data.endpoints.items[0].id, "e2");
  });

  test("health lifts the live rollup and exposes per-subnet summaries", async () => {
    const env = fixtureEnv(
      {},
      {
        kv: {
          [KV_HEALTH_CURRENT]: {
            summary: { status: "degraded", ok_count: 40, surface_count: 50 },
            subnets: [
              { netuid: 1, status: "ok" },
              { netuid: 2, status: "failed" },
            ],
          },
        },
      },
    );
    const { status, body } = await gql(
      "{ health { status ok_count surface_count health_source subnets { netuid status } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.health.status, "degraded");
    assert.equal(body.data.health.ok_count, 40);
    assert.equal(body.data.health.health_source, "live-cron-prober");
    assert.equal(body.data.health.subnets.length, 2);
    assert.equal(body.data.health.subnets[1].status, "failed");
  });

  test("health returns null when the live store is cold", async () => {
    const { status, body } = await gql("{ health { status } }", emptyEnv);
    assert.equal(status, 200);
    assert.equal(body.data.health, null);
  });
});

// #6985: GraphQL parity for endpoint-pools/rpc-pools/endpoint-incidents, reusing
// list_endpoint_pools'/list_rpc_pools'/list_endpoint_incidents' own loaders
// unchanged (same filter/sort/page + error behavior as REST and MCP) rather than
// a GraphQL-only reimplementation.
describe("graphql — endpoint_pools / rpc_pools / endpoint_incidents", () => {
  const POOLS_BLOB = {
    generated_at: "2026-07-01T00:00:00.000Z",
    notes: "test",
    pools: [
      {
        id: "finney-rpc",
        kind: "subtensor-rpc",
        eligible_count: 2,
        endpoint_count: 5,
      },
      {
        id: "finney-wss",
        kind: "subtensor-wss",
        eligible_count: 8,
        endpoint_count: 10,
      },
      {
        id: "finney-archive",
        kind: "archive",
        eligible_count: 0,
        endpoint_count: 3,
      },
    ],
  };

  const INCIDENTS_BLOB = {
    generated_at: "2026-07-01T00:00:00.000Z",
    notes: ["probe-derived only"],
    summary: { incident_count: 2, active_count: 2 },
    incidents: [
      {
        id: "incident-a",
        endpoint_id: "a",
        netuid: 7,
        kind: "subnet-api",
        provider: "allways",
        status: "failed",
        severity: "critical",
        state: "active",
      },
      {
        id: "incident-b",
        endpoint_id: "b",
        netuid: 31,
        kind: "openapi",
        provider: "candles",
        status: "degraded",
        severity: "warning",
        state: "active",
      },
    ],
  };

  test("endpoint_pools filters by kind and paginates", async () => {
    const env = fixtureEnv({ "/metagraph/endpoint-pools.json": POOLS_BLOB });
    const filtered = await gql(
      '{ endpoint_pools(kind: "archive") { pools total } }',
      env,
    );
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.endpoint_pools.total, 1);
    assert.equal(
      filtered.body.data.endpoint_pools.pools[0].id,
      "finney-archive",
    );

    const paged = await gql(
      "{ endpoint_pools(limit: 1) { pools total returned next_cursor } }",
      env,
    );
    assert.equal(paged.body.data.endpoint_pools.pools.length, 1);
    assert.equal(paged.body.data.endpoint_pools.total, 3);
    assert.equal(paged.body.data.endpoint_pools.returned, 1);
    assert.ok(paged.body.data.endpoint_pools.next_cursor != null);
  });

  test("endpoint_pools surfaces an invalid kind as a GraphQL error, not a silent default", async () => {
    const env = fixtureEnv({ "/metagraph/endpoint-pools.json": POOLS_BLOB });
    const { body } = await gql(
      '{ endpoint_pools(kind: "bogus") { total } }',
      env,
    );
    assert.ok(body.errors?.length);
  });

  test("endpoint_pools surfaces a cold/missing artifact as a GraphQL error, matching REST/MCP", async () => {
    const { body } = await gql("{ endpoint_pools { total } }", emptyEnv);
    assert.ok(body.errors?.length);
    assert.equal(body.data, null);
  });

  test("rpc_pools returns the same pools[] row shape via its own artifact", async () => {
    const env = fixtureEnv({ "/metagraph/rpc/pools.json": POOLS_BLOB });
    const { status, body } = await gql(
      '{ rpc_pools(sort: "eligible_count", order: "desc") { pools total } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.rpc_pools.total, 3);
    assert.equal(body.data.rpc_pools.pools[0].id, "finney-wss");
  });

  test("rpc_pools applies the live 15-minute cron eligibility overlay before filtering", async () => {
    const env = fixtureEnv(
      { "/metagraph/rpc/pools.json": POOLS_BLOB },
      {
        kv: {
          [KV_HEALTH_RPC_POOL]: {
            endpoints: [],
            last_run_at: "2026-07-20T12:00:00.000Z",
          },
        },
      },
    );
    const { body } = await gql(
      "{ rpc_pools { source operational_observed_at } }",
      env,
    );
    assert.equal(body.data.rpc_pools.source, "live-cron-prober");
    assert.equal(
      body.data.rpc_pools.operational_observed_at,
      "2026-07-20T12:00:00.000Z",
    );
  });

  test("rpc_pools leaves source/operational_observed_at null with no live overlay", async () => {
    const env = fixtureEnv({ "/metagraph/rpc/pools.json": POOLS_BLOB });
    const { body } = await gql(
      "{ rpc_pools { source operational_observed_at } }",
      env,
    );
    assert.equal(body.data.rpc_pools.source, null);
    assert.equal(body.data.rpc_pools.operational_observed_at, null);
  });

  test("endpoint_incidents filters by severity and netuid", async () => {
    const env = fixtureEnv({
      "/metagraph/endpoint-incidents.json": INCIDENTS_BLOB,
    });
    const { status, body } = await gql(
      '{ endpoint_incidents(severity: "critical") { incidents total summary } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.endpoint_incidents.total, 1);
    assert.equal(body.data.endpoint_incidents.incidents[0].id, "incident-a");
    assert.equal(body.data.endpoint_incidents.summary.incident_count, 2);

    const byNetuid = await gql(
      "{ endpoint_incidents(netuid: 31) { incidents total } }",
      env,
    );
    assert.equal(byNetuid.body.data.endpoint_incidents.total, 1);
    assert.equal(
      byNetuid.body.data.endpoint_incidents.incidents[0].id,
      "incident-b",
    );
  });

  test("endpoint_incidents surfaces an invalid severity as a GraphQL error", async () => {
    const env = fixtureEnv({
      "/metagraph/endpoint-incidents.json": INCIDENTS_BLOB,
    });
    const { body } = await gql(
      '{ endpoint_incidents(severity: "bogus") { total } }',
      env,
    );
    assert.ok(body.errors?.length);
  });

  test("FIELD_COMPLEXITY weights all three new fields like their sibling relationship fields", () => {
    for (const field of ["endpoint_pools", "rpc_pools", "endpoint_incidents"]) {
      assert.equal(FIELD_COMPLEXITY[field], 5, `${field} should be weighted`);
    }
  });
});

// #6986: GraphQL parity for source-snapshots, reusing list_source_snapshots'
// own loader unchanged (same filter/sort/page + error behavior as REST and
// MCP) rather than a GraphQL-only reimplementation.
describe("graphql — source_snapshots", () => {
  const SNAPSHOTS_BLOB = {
    generated_at: "2026-07-01T00:00:00.000Z",
    schema_version: 1,
    summary: { source_count: 2 },
    sources: [
      {
        id: "chain-events",
        kind: "db",
        path: "chain_events",
        record_count: 100,
        input_hash: "abc",
      },
      {
        id: "economics",
        kind: "kv",
        path: "economics.json",
        record_count: 50,
        input_hash: "def",
      },
    ],
  };

  test("filters by keyword across id/kind/path and paginates", async () => {
    const env = fixtureEnv({
      "/metagraph/source-snapshots.json": SNAPSHOTS_BLOB,
    });
    const filtered = await gql(
      '{ source_snapshots(q: "chain") { sources total generated_at } }',
      env,
    );
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.source_snapshots.total, 1);
    assert.equal(
      filtered.body.data.source_snapshots.sources[0].id,
      "chain-events",
    );
    assert.equal(
      filtered.body.data.source_snapshots.generated_at,
      "2026-07-01T00:00:00.000Z",
    );

    const paged = await gql(
      "{ source_snapshots(limit: 1) { sources total returned next_cursor } }",
      env,
    );
    assert.equal(paged.body.data.source_snapshots.sources.length, 1);
    assert.equal(paged.body.data.source_snapshots.total, 2);
    assert.equal(paged.body.data.source_snapshots.returned, 1);
    assert.ok(paged.body.data.source_snapshots.next_cursor != null);
  });

  test("sorts by record_count and exposes summary/schema_version", async () => {
    const env = fixtureEnv({
      "/metagraph/source-snapshots.json": SNAPSHOTS_BLOB,
    });
    const { status, body } = await gql(
      '{ source_snapshots(sort: "record_count", order: "desc") { sources summary schema_version } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.source_snapshots.sources[0].id, "chain-events");
    assert.equal(body.data.source_snapshots.summary.source_count, 2);
    assert.equal(body.data.source_snapshots.schema_version, "1");
  });

  test("surfaces an invalid sort as a GraphQL error, not a silent default", async () => {
    const env = fixtureEnv({
      "/metagraph/source-snapshots.json": SNAPSHOTS_BLOB,
    });
    const { body } = await gql(
      '{ source_snapshots(sort: "bogus") { total } }',
      env,
    );
    assert.ok(body.errors?.length);
  });

  test("surfaces a cold/missing artifact as a GraphQL error, matching REST/MCP", async () => {
    const { body } = await gql("{ source_snapshots { total } }", emptyEnv);
    assert.ok(body.errors?.length);
    assert.equal(body.data, null);
  });

  test("FIELD_COMPLEXITY weights it like its sibling relationship fields", () => {
    assert.equal(FIELD_COMPLEXITY.source_snapshots, 5);
  });
});

// #7170: GraphQL parity for changelog/contracts/health-history, reusing the same
// loaders MCP get_changelog/get_contracts/get_health_history already call (same
// artifact read + error behavior as REST and MCP) rather than a GraphQL-only
// reimplementation.
describe("graphql — changelog", () => {
  const CHANGELOG_BLOB = {
    generated_at: "2026-07-01T00:00:00.000Z",
    source: "publish",
    notes: ["one", "two"],
    summary: { artifacts_changed: 3, subnets_changed: 1 },
    artifacts: { added: ["adapters.json"], modified: [], removed: [] },
    subnets: { added: [], removed: [], renamed: ["sn-7"] },
    coverage_delta: { surfaces: 4 },
  };

  test("serves the baked changelog artifact verbatim", async () => {
    const env = fixtureEnv({ "/metagraph/changelog.json": CHANGELOG_BLOB });
    const { status, body } = await gql(
      "{ changelog { generated_at source notes summary artifacts subnets coverage_delta } }",
      env,
    );
    assert.equal(status, 200);
    const changelog = body.data.changelog;
    assert.equal(changelog.generated_at, "2026-07-01T00:00:00.000Z");
    assert.equal(changelog.source, "publish");
    assert.deepEqual(changelog.notes, ["one", "two"]);
    assert.equal(changelog.summary.artifacts_changed, 3);
    assert.deepEqual(changelog.artifacts.added, ["adapters.json"]);
    assert.deepEqual(changelog.subnets.renamed, ["sn-7"]);
    assert.equal(changelog.coverage_delta.surfaces, 4);
  });

  test("surfaces a cold/missing artifact as a GraphQL error, matching REST/MCP", async () => {
    const { body } = await gql("{ changelog { generated_at } }", emptyEnv);
    assert.ok(body.errors?.length);
    assert.equal(body.data.changelog, null);
  });

  test("FIELD_COMPLEXITY weights it like its sibling relationship fields", () => {
    assert.equal(FIELD_COMPLEXITY.changelog, 5);
  });
});

describe("graphql — contracts", () => {
  const CONTRACTS_BLOB = {
    schema_version: 2,
    contract_version: "abc123",
    generated_at: "2026-07-01T00:00:00.000Z",
    name: "metagraph",
    base_path: "/metagraph",
    primary_domain: "api.metagraph.sh",
    openapi_url: "https://api.metagraph.sh/openapi.json",
    type_definitions_url: "https://api.metagraph.sh/types.d.ts",
    notes: ["read-only"],
    artifacts: [
      { path: "/metagraph/subnets.json", tier: "r2", schema_ref: "subnets" },
      {
        path: "/metagraph/changelog.json",
        tier: "r2",
        schema_ref: "changelog",
      },
    ],
  };

  test("serves the baked contracts artifact verbatim", async () => {
    const env = fixtureEnv({ "/metagraph/contracts.json": CONTRACTS_BLOB });
    const { status, body } = await gql(
      "{ contracts { schema_version contract_version generated_at name base_path primary_domain openapi_url type_definitions_url notes artifacts } }",
      env,
    );
    assert.equal(status, 200);
    const contracts = body.data.contracts;
    assert.equal(contracts.schema_version, 2);
    assert.equal(contracts.contract_version, "abc123");
    assert.equal(contracts.name, "metagraph");
    assert.equal(contracts.base_path, "/metagraph");
    assert.equal(contracts.primary_domain, "api.metagraph.sh");
    assert.equal(
      contracts.openapi_url,
      "https://api.metagraph.sh/openapi.json",
    );
    assert.deepEqual(contracts.notes, ["read-only"]);
    assert.equal(contracts.artifacts.length, 2);
    assert.equal(contracts.artifacts[0].path, "/metagraph/subnets.json");
  });

  test("surfaces a cold/missing artifact as a GraphQL error, matching REST/MCP", async () => {
    const { body } = await gql("{ contracts { schema_version } }", emptyEnv);
    assert.ok(body.errors?.length);
    assert.equal(body.data.contracts, null);
  });

  test("FIELD_COMPLEXITY weights it like its sibling relationship fields", () => {
    assert.equal(FIELD_COMPLEXITY.contracts, 5);
  });
});

describe("graphql — health_history", () => {
  const SURFACE_ROW = {
    netuid: 7,
    surface_id: "sn-7-example",
    kind: "openapi",
    provider: "allways",
    status: "ok",
    classification: "live",
    latency_ms: 120,
  };
  const HISTORY_BLOB = {
    date: "2026-07-01",
    summary: { incident_count: 0, surface_count: 2 },
    surfaces: [
      SURFACE_ROW,
      {
        ...SURFACE_ROW,
        netuid: 1,
        surface_id: "sn-1-example",
        latency_ms: 300,
      },
    ],
  };

  test("serves a dated snapshot and paginates its surfaces", async () => {
    const env = fixtureEnv({
      "/metagraph/health/history/2026-07-01.json": HISTORY_BLOB,
    });
    const { status, body } = await gql(
      '{ health_history(date: "2026-07-01") { date summary surfaces total returned limit cursor next_cursor } }',
      env,
    );
    assert.equal(status, 200);
    const history = body.data.health_history;
    assert.equal(history.date, "2026-07-01");
    assert.equal(history.summary.surface_count, 2);
    assert.equal(history.total, 2);
    assert.equal(history.surfaces.length, 2);

    const paged = await gql(
      '{ health_history(date: "2026-07-01", limit: 1) { surfaces total returned next_cursor } }',
      env,
    );
    assert.equal(paged.body.data.health_history.surfaces.length, 1);
    assert.equal(paged.body.data.health_history.total, 2);
    assert.equal(paged.body.data.health_history.returned, 1);
    assert.ok(paged.body.data.health_history.next_cursor != null);
  });

  test("filters surfaces by netuid and sorts by latency", async () => {
    const env = fixtureEnv({
      "/metagraph/health/history/2026-07-01.json": HISTORY_BLOB,
    });
    const filtered = await gql(
      '{ health_history(date: "2026-07-01", netuid: 1) { total surfaces } }',
      env,
    );
    assert.equal(filtered.body.data.health_history.total, 1);
    assert.equal(
      filtered.body.data.health_history.surfaces[0].surface_id,
      "sn-1-example",
    );

    const sorted = await gql(
      '{ health_history(date: "2026-07-01", sort: "latency_ms", order: "desc") { surfaces sort order } }',
      env,
    );
    assert.equal(sorted.body.data.health_history.surfaces[0].netuid, 1);
    assert.equal(sorted.body.data.health_history.sort, "latency_ms");
    assert.equal(sorted.body.data.health_history.order, "desc");
  });

  test("an invalid date is a GraphQL error, not a silent default", async () => {
    const env = fixtureEnv({
      "/metagraph/health/history/2026-07-01.json": HISTORY_BLOB,
    });
    const { body } = await gql(
      '{ health_history(date: "not-a-day") { total } }',
      env,
    );
    assert.ok(body.errors?.length);
    assert.equal(body.data, null);
  });

  test("an unsupported filter is a GraphQL error, not a silent default", async () => {
    const env = fixtureEnv({
      "/metagraph/health/history/2026-07-01.json": HISTORY_BLOB,
    });
    const { body } = await gql(
      '{ health_history(date: "2026-07-01", status: "alive") { total } }',
      env,
    );
    assert.ok(body.errors?.length);
  });

  test("surfaces a missing snapshot as a GraphQL error, matching REST/MCP", async () => {
    const env = fixtureEnv({
      "/metagraph/health/history/2026-07-01.json": HISTORY_BLOB,
    });
    const { body } = await gql(
      '{ health_history(date: "2026-07-02") { total } }',
      env,
    );
    assert.ok(body.errors?.length);
    assert.equal(body.data, null);
  });

  test("FIELD_COMPLEXITY weights it like its sibling relationship fields", () => {
    assert.equal(FIELD_COMPLEXITY.health_history, 5);
  });
});

// #6992: GraphQL parity for profiles, reusing list_profiles' own loader
// unchanged (same filter/sort/page + error behavior as REST and MCP) rather
// than a GraphQL-only reimplementation.
describe("graphql — profiles", () => {
  const PROFILE_ROW = {
    netuid: 7,
    slug: "allways",
    name: "Allways",
    completeness_score: 82,
    curation_level: "machine-verified",
    review_state: "verified",
    confidence: "high",
    profile_level: "operational",
    surface_count: 5,
  };

  const PROFILES_BLOB = {
    captured_at: "2026-06-20T00:00:00Z",
    profiles: [
      PROFILE_ROW,
      {
        ...PROFILE_ROW,
        netuid: 1,
        slug: "alpha",
        name: "Alpha",
        completeness_score: 60,
        confidence: "medium",
      },
    ],
  };

  test("filters by netuid and paginates", async () => {
    const env = fixtureEnv({ "/metagraph/profiles.json": PROFILES_BLOB });
    const filtered = await gql(
      "{ profiles(netuid: 7) { profiles total captured_at } }",
      env,
    );
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.data.profiles.total, 1);
    assert.equal(filtered.body.data.profiles.profiles[0].slug, "allways");
    assert.equal(
      filtered.body.data.profiles.captured_at,
      "2026-06-20T00:00:00Z",
    );

    const paged = await gql(
      "{ profiles(limit: 1) { profiles total returned next_cursor } }",
      env,
    );
    assert.equal(paged.body.data.profiles.profiles.length, 1);
    assert.equal(paged.body.data.profiles.total, 2);
    assert.equal(paged.body.data.profiles.returned, 1);
    assert.ok(paged.body.data.profiles.next_cursor != null);
  });

  test("searches by q and sorts by completeness_score", async () => {
    const env = fixtureEnv({ "/metagraph/profiles.json": PROFILES_BLOB });
    const searched = await gql(
      '{ profiles(q: "alpha") { profiles total } }',
      env,
    );
    assert.equal(searched.body.data.profiles.total, 1);
    assert.equal(searched.body.data.profiles.profiles[0].slug, "alpha");

    const sorted = await gql(
      '{ profiles(sort: "completeness_score", order: "desc") { profiles } }',
      env,
    );
    assert.equal(sorted.body.data.profiles.profiles[0].slug, "allways");
  });

  test("surfaces an invalid curation_level as a GraphQL error, not a silent default", async () => {
    const env = fixtureEnv({ "/metagraph/profiles.json": PROFILES_BLOB });
    const { body } = await gql(
      '{ profiles(curation_level: "bogus") { total } }',
      env,
    );
    assert.ok(body.errors?.length);
  });

  test("surfaces a cold/missing artifact as a GraphQL error, matching REST/MCP", async () => {
    const { body } = await gql("{ profiles { total } }", emptyEnv);
    assert.ok(body.errors?.length);
    assert.equal(body.data, null);
  });

  test("FIELD_COMPLEXITY weights it like its sibling relationship fields", () => {
    assert.equal(FIELD_COMPLEXITY.profiles, 5);
  });
});

// #6977: block-scoped extrinsics/events/chain-events lists mirror the same
// Postgres tier + schema-stable fallback the block/extrinsics feeds already use.
describe("graphql — block_extrinsics / block_events / block_chain_events (#6977)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("block_extrinsics: cold store returns a schema-stable empty list, never an error", async () => {
    const { status, body } = await gql(
      '{ block_extrinsics(ref: "9") { block_number extrinsic_count extrinsics } }',
    );
    assert.equal(status, 200);
    assert.equal(body.data.block_extrinsics.block_number, null);
    assert.equal(body.data.block_extrinsics.extrinsic_count, 0);
    assert.deepEqual(body.data.block_extrinsics.extrinsics, []);
  });

  test("block_extrinsics: resolves Postgres-tier rows (the /blocks/:ref/extrinsics { data } envelope)", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          data: {
            schema_version: 1,
            ref: "9",
            block_number: 9,
            extrinsic_count: 1,
            limit: 50,
            offset: 0,
            extrinsics: [
              {
                block_number: 9,
                extrinsic_index: 0,
                call_module: "Timestamp",
                call_function: "set",
                success: true,
              },
            ],
          },
        }),
      ),
    };
    const { status, body } = await gql(
      '{ block_extrinsics(ref: "9", limit: 10, offset: 2) { block_number extrinsic_count extrinsics } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.block_extrinsics.block_number, 9);
    assert.equal(body.data.block_extrinsics.extrinsic_count, 1);
    assert.equal(
      body.data.block_extrinsics.extrinsics[0].call_module,
      "Timestamp",
    );
  });

  test("block_events: cold store returns a schema-stable empty list, never an error", async () => {
    const { status, body } = await gql(
      '{ block_events(ref: "9") { block_number event_count events } }',
    );
    assert.equal(status, 200);
    assert.equal(body.data.block_events.event_count, 0);
    assert.deepEqual(body.data.block_events.events, []);
  });

  test("block_events: resolves Postgres-tier rows (the /blocks/:ref/events { data } envelope)", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          data: {
            schema_version: 1,
            ref: "9",
            block_number: 9,
            event_count: 1,
            limit: 100,
            offset: 0,
            events: [
              { block_number: 9, event_index: 0, kind: "Balances.Transfer" },
            ],
          },
        }),
      ),
    };
    const { status, body } = await gql(
      '{ block_events(ref: "9", limit: 20, offset: 3) { block_number event_count events } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.block_events.event_count, 1);
    assert.equal(body.data.block_events.events[0].kind, "Balances.Transfer");
  });

  test("block_chain_events: resolves the all-events tier by block_number", async () => {
    const env = {
      DATA_API: dataApi(
        Response.json({
          block_number: 9,
          event_count: 2,
          events: [
            { event_index: 0, pallet: "System", method: "ExtrinsicSuccess" },
            { event_index: 1, pallet: "Balances", method: "Transfer" },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      "{ block_chain_events(block_number: 9) { block_number event_count events } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.block_chain_events.block_number, 9);
    assert.equal(body.data.block_chain_events.event_count, 2);
    assert.equal(body.data.block_chain_events.events[1].method, "Transfer");
  });

  test("block_chain_events: an absent all-events tier is a GraphQL error, not null-degrade", async () => {
    const { body } = await gql(
      "{ block_chain_events(block_number: 9) { event_count } }",
      emptyEnv,
    );
    assert.ok(
      body.errors?.length,
      "expected a GraphQL error when the tier is unavailable",
    );
    assert.equal(body.data, null);
  });

  test("all three fields are weighted in the complexity map", () => {
    for (const field of [
      "block_extrinsics",
      "block_events",
      "block_chain_events",
    ]) {
      assert.equal(FIELD_COMPLEXITY[field], 5, `${field} should be weighted`);
    }
  });
});

describe("graphql — economics pagination", () => {
  const env = () =>
    fixtureEnv({
      "/metagraph/economics.json": {
        subnets: [
          { netuid: 1, emission_share: 0.1 },
          { netuid: 2, emission_share: 0.2 },
          { netuid: 3, emission_share: 0.3 },
        ],
      },
    });

  test("limit + next_cursor page through the economics rows", async () => {
    const first = await gql(
      "{ economics(limit: 2) { subnets { netuid } total next_cursor } }",
      env(),
    );
    assert.equal(first.body.data.economics.subnets.length, 2);
    assert.equal(first.body.data.economics.total, 3);
    assert.equal(first.body.data.economics.next_cursor, "2");

    const second = await gql(
      '{ economics(limit: 2, cursor: "2") { subnets { netuid } next_cursor } }',
      env(),
    );
    assert.equal(second.body.data.economics.subnets.length, 1);
    assert.equal(second.body.data.economics.subnets[0].netuid, 3);
    assert.equal(second.body.data.economics.next_cursor, null);
  });

  test("prefers the fresh KV economics tier over the committed artifact", async () => {
    const env = fixtureEnv(
      // Stale committed copy — must NOT be served while the KV tier is fresh.
      {
        "/metagraph/economics.json": {
          subnets: [{ netuid: 9, emission_share: 1 }],
        },
      },
      {
        kv: {
          [KV_ECONOMICS_CURRENT]: {
            captured_at: new Date().toISOString(),
            subnets: [
              { netuid: 1, emission_share: 0.6 },
              { netuid: 2, emission_share: 0.4, alpha_market_cap_tao: 80 },
            ],
          },
        },
      },
    );
    const { status, body } = await gql(
      "{ economics { subnets { netuid alpha_market_cap_tao } total } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.economics.total, 2);
    assert.deepEqual(
      body.data.economics.subnets.map((s) => s.netuid),
      [1, 2],
    );
    assert.equal(body.data.economics.subnets[0].alpha_market_cap_tao, null);
    assert.equal(body.data.economics.subnets[1].alpha_market_cap_tao, 80);
  });
});

describe("graphql — opportunity boards (reuse the leaderboard ranking)", () => {
  const env = () =>
    fixtureEnv({
      "/metagraph/economics.json": {
        captured_at: "2026-06-23T00:00:00.000Z",
        subnets: [
          {
            netuid: 1,
            slug: "a",
            name: "A",
            open_slots: 5,
            max_uids: 256,
            registration_cost_tao: 0.5,
            registration_allowed: true,
            emission_share: 0.1,
            total_stake_tao: 1000,
            validator_count: 10,
            max_validators: 64,
            miner_count: 50,
          },
          {
            netuid: 2,
            slug: "b",
            name: "B",
            open_slots: 0,
            registration_cost_tao: 0.2,
            registration_allowed: false,
            emission_share: 0.3,
            total_stake_tao: 2000,
            validator_count: 64,
            max_validators: 64,
            miner_count: 100,
          },
          {
            netuid: 3,
            slug: "c",
            name: "C",
            open_slots: 20,
            registration_cost_tao: 0.1,
            registration_allowed: true,
            emission_share: 0.05,
            total_stake_tao: 500,
            validator_count: 5,
            max_validators: 64,
            miner_count: 10,
          },
        ],
      },
    });

  test("boards rank by their economic metric", async () => {
    const { status, body } = await gql(
      `{ opportunity_boards {
          observed_at with_economics_count
          open_slots { netuid open_slots }
          highest_emission { netuid emission_share }
          cheapest_registration { netuid registration_cost_tao }
          validator_headroom { netuid validator_headroom }
        } }`,
      env(),
    );
    assert.equal(status, 200);
    const b = body.data.opportunity_boards;
    assert.equal(b.with_economics_count, 3);
    assert.equal(b.observed_at, "2026-06-23T00:00:00.000Z");
    // Most open slots first; the full subnet (open_slots 0) is dropped.
    assert.equal(b.open_slots[0].netuid, 3);
    assert.equal(b.open_slots[0].open_slots, 20);
    assert.equal(b.open_slots.length, 2);
    // Highest emission first.
    assert.equal(b.highest_emission[0].netuid, 2);
    // Cheapest open registration first (the closed subnet is excluded).
    assert.equal(b.cheapest_registration[0].netuid, 3);
    assert.ok(b.cheapest_registration.every((e) => e.netuid !== 2));
    // Most validator headroom first.
    assert.equal(b.validator_headroom[0].netuid, 3);
  });

  test("opportunity_boards degrades to empty boards on a cold store", async () => {
    const { status, body } = await gql(
      "{ opportunity_boards { with_economics_count open_slots { netuid } } }",
      emptyEnv,
    );
    assert.equal(status, 200);
    assert.equal(body.data.opportunity_boards.with_economics_count, 0);
    assert.deepEqual(body.data.opportunity_boards.open_slots, []);
  });
});

describe("graphql — complexity weights keep the guard meaningful", () => {
  test("FIELD_COMPLEXITY weights the read/fan-out fields above scalars", () => {
    for (const field of [
      "subnets",
      "subnet",
      "providers",
      "provider",
      "economics",
      "surfaces",
      "endpoints",
      "health",
      "opportunity_boards",
    ]) {
      assert.equal(FIELD_COMPLEXITY[field], 5, `${field} should be weighted`);
    }
  });

  test("a single weighted field trips a tight complexity budget", () => {
    const s = buildSchema(SDL);
    const doc = parse("{ health { status } }"); // 5 (health) + 1 (status) = 6
    assert.equal(validate(s, doc, [maxComplexityRule(6)]).length, 0);
    const errs = validate(s, doc, [maxComplexityRule(5)]);
    assert.equal(errs.length, 1);
    assert.equal(errs[0].extensions?.code, "COMPLEXITY_LIMIT_EXCEEDED");
  });

  test("the headline composition — one subnet with all its relationships — stays within budget", async () => {
    // The whole point of GraphQL here: a subnet + health + surfaces + endpoints
    // + economics in one shaped request must NOT trip the guard.
    const { status, body } = await gql(
      `{ subnet(netuid: 1) {
          netuid name slug
          health { status ok_count }
          surfaces { id kind status }
          endpoints { id kind status }
          economics { emission_share open_slots }
      } }`,
      emptyEnv,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnet, null); // cold store, but the query was accepted
  });

  test("greedily pulling many fields of several relationships across the list exceeds the budget", async () => {
    // subnets(5) items(1) + four relationship containers (5 each = 20) + 28 leaf
    // fields = 55 > 50.
    const { status, body } = await gql(
      `{ subnets { items {
          economics { netuid emission_share alpha_market_cap_tao open_slots max_uids miner_count validator_count total_stake_tao }
          endpoints { id status kind url latency_ms last_ok score }
          health { status ok_count failed_count degraded_count unknown_count surface_count avg_latency_ms }
          surfaces { id key kind status url provider name }
      } } }`,
      emptyEnv,
    );
    assert.equal(status, 400);
    assert.ok(
      body.errors.find(
        (e) => e.extensions?.code === "COMPLEXITY_LIMIT_EXCEEDED",
      ),
    );
  });
});

// --- Branch coverage for the changed resolvers/handler ----------------------

describe("graphql — resolver branch coverage", () => {
  test("a spread to an undefined fragment is handled by the depth/complexity guards", async () => {
    // frag is undefined, so the rules skip the spread instead of throwing.
    const { status } = await gql("{ ...Ghost }");
    assert.equal(status, 400); // unknown-fragment validation error, no crash
  });

  test("list-item surfaces/endpoints resolve lazily by netuid", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": { subnets: [{ netuid: 1, name: "A" }] },
      "/metagraph/surfaces.json": {
        surfaces: [
          { id: "s1", netuid: 1, kind: "subnet-api" },
          { id: "s2", netuid: 2, kind: "rpc" },
        ],
      },
      "/metagraph/endpoints.json": {
        endpoints: [{ id: "e1", netuid: 1, status: "ok" }],
      },
    });
    const { status, body } = await gql(
      "{ subnets { items { netuid surfaces { id } endpoints { id } } } }",
      env,
    );
    assert.equal(status, 200);
    const item = body.data.subnets.items[0];
    assert.deepEqual(
      item.surfaces.map((s) => s.id),
      ["s1"],
    );
    assert.deepEqual(
      item.endpoints.map((e) => e.id),
      ["e1"],
    );
  });

  test("a null bundled surfaces/endpoints list resolves to an empty list", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets/3.json": {
        subnet: { netuid: 3, name: "C" },
        surfaces: null,
        endpoints: null,
      },
    });
    const { status, body } = await gql(
      "{ subnet(netuid: 3) { surfaces { id } endpoints { id } } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet.surfaces, []);
    assert.deepEqual(body.data.subnet.endpoints, []);
  });

  test("subnet.economics is null when the netuid has no economics row", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets/5.json": { subnet: { netuid: 5, name: "E" } },
      "/metagraph/economics.json": {
        subnets: [{ netuid: 9, emission_share: 1 }],
      },
    });
    const { status, body } = await gql(
      "{ subnet(netuid: 5) { economics { emission_share } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.subnet.economics, null);
  });

  test("provider.subnets is empty when the provider lists no netuids", async () => {
    const env = fixtureEnv({
      "/metagraph/providers/solo.json": {
        provider: { id: "solo", name: "Solo", netuids: [] },
      },
    });
    const { status, body } = await gql(
      '{ provider(id: "solo") { subnets { netuid } } }',
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.provider.subnets, []);
  });

  test("providers paginate with an id cursor", async () => {
    const env = fixtureEnv({
      "/metagraph/providers.json": {
        providers: [
          { id: "a", name: "A" },
          { id: "b", name: "B" },
        ],
      },
    });
    const { status, body } = await gql(
      "{ providers(limit: 1) { items { id } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.providers.total, 2);
    assert.equal(body.data.providers.next_cursor, "a");
  });

  test("surfaces paginate, falling back to key for the cursor when id is absent", async () => {
    const env = fixtureEnv({
      "/metagraph/surfaces.json": {
        surfaces: [
          { key: "k1", netuid: 1, kind: "sse" }, // no id → cursor uses key
          { id: "s2", netuid: 1, kind: "rpc" },
        ],
      },
    });
    const first = await gql(
      "{ surfaces(limit: 1) { items { kind } total next_cursor } }",
      env,
    );
    assert.equal(first.body.data.surfaces.total, 2);
    assert.equal(first.body.data.surfaces.next_cursor, "k1");
  });

  test("invalid Content-Length is rejected before the body is read", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "-1" },
      body: JSON.stringify({ query: "{ __typename }" }),
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors[0].message.includes("Content-Length"));
  });

  test("a POST with no body returns a missing-query error", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 400);
    assert.ok((await res.json()).errors[0].message.includes("query"));
  });

  test("OPTIONS /mcp advertises GET, POST, DELETE, OPTIONS (the sibling CORS branch, #4983 MCP half)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/mcp", { method: "OPTIONS" }),
      emptyEnv,
      {},
    );
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "GET, POST, DELETE, OPTIONS",
    );
  });

  test("OPTIONS /api/v1/ask advertises POST, OPTIONS (the other CORS operand)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/ask", { method: "OPTIONS" }),
      emptyEnv,
      {},
    );
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "POST, OPTIONS",
    );
  });

  test("OPTIONS on a default route keeps the read-only CORS methods", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/subnets", {
        method: "OPTIONS",
      }),
      emptyEnv,
      {},
    );
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "GET, HEAD, OPTIONS",
    );
  });

  test("an in-bounds Content-Length is accepted and the body is read", async () => {
    const payload = JSON.stringify({ query: "{ __typename }" });
    const req = new Request("https://api.metagraph.sh/api/v1/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(new TextEncoder().encode(payload).byteLength),
      },
      body: payload,
    });
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { __typename: "Query" } });
  });
});

describe("graphql — compare (reuse the shared compare loader)", () => {
  const profilesEnv = (extra = {}, opts = {}) =>
    fixtureEnv(
      {
        "/metagraph/profiles.json": {
          profiles: [
            {
              netuid: 1,
              slug: "a",
              name: "A",
              completeness_score: 90,
              surface_count: 4,
              operational_interface_count: 2,
            },
            {
              netuid: 2,
              slug: "b",
              name: "B",
              completeness_score: 50,
              surface_count: 1,
              operational_interface_count: 0,
            },
          ],
        },
        ...extra,
      },
      opts,
    );

  test("default dimensions: structure + economics + health side by side", async () => {
    const env = profilesEnv({
      "/metagraph/economics.json": {
        subnets: [{ netuid: 1, emission_share: 0.1, open_slots: 5 }],
      },
    });
    const { status, body } = await gql(
      `{ compare(netuids: [1, 99]) {
          schema_version dimensions requested_netuids
          subnets { netuid found
            structure { completeness_score surface_count }
            economics { emission_share open_slots }
            health { ok_count }
          }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const c = body.data.compare;
    assert.equal(c.schema_version, 1);
    assert.deepEqual(c.dimensions, ["structure", "economics", "health"]);
    assert.deepEqual(c.requested_netuids, [1, 99]);
    // Requested order is preserved.
    assert.equal(c.subnets[0].netuid, 1);
    assert.equal(c.subnets[0].found, true);
    assert.equal(c.subnets[0].structure.completeness_score, 90);
    assert.equal(c.subnets[0].economics.emission_share, 0.1);
    // No D1 binding → health is null, not an error.
    assert.equal(c.subnets[0].health, null);
    // Unknown netuid → found:false, all dimension blocks null.
    assert.equal(c.subnets[1].netuid, 99);
    assert.equal(c.subnets[1].found, false);
    assert.equal(c.subnets[1].structure, null);
    assert.equal(c.subnets[1].economics, null);
  });

  test("explicit dimensions subset skips the economics read", async () => {
    const reads = new Map();
    const env = profilesEnv({}, { reads });
    const { status, body } = await gql(
      `{ compare(netuids: [1], dimensions: ["structure"]) {
          dimensions subnets { structure { surface_count } economics { emission_share } }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.compare.dimensions, ["structure"]);
    assert.equal(body.data.compare.subnets[0].structure.surface_count, 4);
    assert.equal(body.data.compare.subnets[0].economics, null);
    // economics dimension excluded → no economics artifact read.
    assert.equal(reads.has("latest/economics.json"), false);
  });

  test("observed_at is stamped from the health:meta KV freshness", async () => {
    const env = profilesEnv(
      {},
      { kv: { [KV_HEALTH_META]: { last_run_at: "2026-06-23T00:00:00.000Z" } } },
    );
    const { body } = await gql(
      `{ compare(netuids: [1], dimensions: ["structure"]) { observed_at } }`,
      env,
    );
    assert.equal(body.data.compare.observed_at, "2026-06-23T00:00:00.000Z");
  });

  // D1 fully eliminated (2026-07-17): surface_status is Postgres-only now, so
  // the health dimension is always empty -- even a "warm" D1 mock (real rows)
  // must not change the response.
  test("never queries D1 even when mocked with real rows: health dimension is always null", async () => {
    const env = profilesEnv();
    env.METAGRAPH_HEALTH_DB = {
      prepare() {
        throw new Error("D1 must not be queried -- surface_status is retired");
      },
    };
    const { status, body } = await gql(
      `{ compare(netuids: [1], dimensions: ["health"]) {
          subnets { netuid health { surface_count ok_count avg_latency_ms } }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.compare.subnets[0].health, null);
  });

  test("a D1 result with no rows yields null health (results || [] fallback)", async () => {
    const env = profilesEnv();
    env.METAGRAPH_HEALTH_DB = {
      prepare: () => ({ bind: () => ({ all: async () => ({}) }) }),
    };
    const { status, body } = await gql(
      `{ compare(netuids: [1], dimensions: ["health"]) { subnets { health { ok_count } } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.compare.subnets[0].health, null);
  });

  test("a D1 error degrades the health dimension to null (no throw)", async () => {
    const env = profilesEnv();
    env.METAGRAPH_HEALTH_DB = {
      prepare() {
        throw new Error("db unavailable");
      },
    };
    const { status, body } = await gql(
      `{ compare(netuids: [1], dimensions: ["health"]) { subnets { health { ok_count } } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.compare.subnets[0].health, null);
  });

  test("invalid netuids (empty / negative) returns BAD_USER_INPUT", async () => {
    const empty = await gql("{ compare(netuids: []) { schema_version } }");
    assert.equal(empty.status, 200);
    assert.ok(
      empty.body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"),
    );
    const neg = await gql("{ compare(netuids: [-1]) { schema_version } }");
    assert.ok(
      neg.body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"),
    );
  });

  test("an unknown dimension returns BAD_USER_INPUT", async () => {
    const { body } = await gql(
      '{ compare(netuids: [1], dimensions: ["bogus"]) { schema_version } }',
    );
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });

  test("cold store: no profiles/economics artifacts → found:false, empty rows", async () => {
    // emptyEnv: readArtifact always ok:false, so profiles and economics both
    // resolve to [] (the fallback arms), observed_at is null, and every
    // requested netuid is reported found:false with null dimension blocks.
    const { status, body } = await gql(
      `{ compare(netuids: [1], dimensions: ["economics"]) {
          observed_at subnets { netuid found economics { emission_share } }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.data.compare.observed_at, null);
    assert.equal(body.data.compare.subnets[0].found, false);
    assert.equal(body.data.compare.subnets[0].economics, null);
  });

  test("compare is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.compare, 5);
  });
});

describe("graphql — sudo (#5895, Postgres-tier feed)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("sudo: cold/no-tier store returns a schema-stable empty page (fallback builder)", async () => {
    const { status, body } = await gql(
      "{ sudo { items { call_module } total next_cursor } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.sudo, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("sudo: resolves Postgres-tier rows from the Sudo feed, JSON-encoding call_args", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          extrinsic_count: 1,
          limit: 20,
          offset: 0,
          next_cursor: "cursor-1",
          extrinsics: [
            {
              block_number: 9,
              extrinsic_index: 0,
              extrinsic_hash: `0x${"b".repeat(64)}`,
              signer: "5Sudo",
              call_module: "Sudo",
              call_function: "sudo",
              call_args: [{ name: "call", value: "setWeights" }],
              success: true,
              fee_tao: 0,
              tip_tao: 0,
              observed_at: "2026-07-15T00:00:00.000Z",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      "{ sudo { items { block_number call_module call_args success } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.sudo.total, 1);
    assert.equal(body.data.sudo.next_cursor, "cursor-1");
    const item = body.data.sudo.items[0];
    assert.equal(item.call_module, "Sudo");
    assert.equal(item.success, true);
    assert.equal(
      item.call_args,
      JSON.stringify([{ name: "call", value: "setWeights" }]),
    );
  });

  test("sudo: hits /api/v1/sudo and forwards filters, never signer/call_module", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            limit: 5,
            offset: 0,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(
      `{ sudo(limit: 5, offset: 2, block: 42, call_function: "sudo", success: true) { total } }`,
      env,
    );
    assert.equal(capturedUrl.pathname, "/api/v1/sudo");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(capturedUrl.searchParams.get("offset"), "2");
    assert.equal(capturedUrl.searchParams.get("block"), "42");
    assert.equal(capturedUrl.searchParams.get("call_function"), "sudo");
    assert.equal(capturedUrl.searchParams.get("success"), "true");
    // The route fixes call_module=Sudo, so the field exposes neither arg.
    assert.equal(capturedUrl.searchParams.get("call_module"), null);
    assert.equal(capturedUrl.searchParams.get("signer"), null);
  });

  test("sudo: a cursor arg is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            limit: 20,
            offset: 0,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(`{ sudo(cursor: "abc123") { total } }`, env);
    assert.equal(capturedUrl.searchParams.get("cursor"), "abc123");
  });

  test("sudo: a negative block filter is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql("{ sudo(block: -1) { total } }", env);
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("sudo: a malformed Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      "{ sudo { items { call_module } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.sudo, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });
});

describe("graphql — extrinsics / extrinsic (#5580, Postgres-tier feed)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("extrinsics: cold/no-tier store returns a schema-stable empty page (fallback builder)", async () => {
    const { status, body } = await gql(
      "{ extrinsics { items { call_module } total next_cursor } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.extrinsics, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("extrinsics: resolves Postgres-tier rows, JSON-encoding call_args", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          extrinsic_count: 1,
          limit: 20,
          offset: 0,
          next_cursor: "cursor-1",
          extrinsics: [
            {
              block_number: 5,
              extrinsic_index: 0,
              extrinsic_hash: `0x${"a".repeat(64)}`,
              signer: "5Signer",
              call_module: "SubtensorModule",
              call_function: "register",
              call_args: [{ name: "netuid", value: 1 }],
              success: true,
              fee_tao: 0.001,
              tip_tao: 0,
              observed_at: "2026-07-14T00:00:00.000Z",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      "{ extrinsics { items { block_number call_module call_args success } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.extrinsics.total, 1);
    assert.equal(body.data.extrinsics.next_cursor, "cursor-1");
    const item = body.data.extrinsics.items[0];
    assert.equal(item.call_module, "SubtensorModule");
    assert.equal(item.success, true);
    assert.equal(
      item.call_args,
      JSON.stringify([{ name: "netuid", value: 1 }]),
    );
  });

  test("extrinsics: filter args are forwarded as query params to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            limit: 5,
            offset: 0,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(
      `{ extrinsics(limit: 5, block: 42, signer: "5Signer", call_module: "SubtensorModule", call_function: "register", success: true) { total } }`,
      env,
    );
    assert.equal(capturedUrl.pathname, "/api/v1/extrinsics");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(capturedUrl.searchParams.get("block"), "42");
    assert.equal(capturedUrl.searchParams.get("signer"), "5Signer");
    assert.equal(
      capturedUrl.searchParams.get("call_module"),
      "SubtensorModule",
    );
    assert.equal(capturedUrl.searchParams.get("call_function"), "register");
    assert.equal(capturedUrl.searchParams.get("success"), "true");
  });

  test("extrinsics: a cursor arg is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            limit: 20,
            offset: 0,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(`{ extrinsics(cursor: "abc123") { total } }`, env);
    assert.equal(capturedUrl.searchParams.get("cursor"), "abc123");
  });

  test("extrinsics: a malformed Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      "{ extrinsics { items { call_module } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.extrinsics, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("extrinsic: a malformed Postgres-tier body falls back to the requested ref", async () => {
    const ref = "5-2";
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      `{ extrinsic(ref: "${ref}") { ref extrinsic { call_module } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.extrinsic.ref, ref);
    assert.equal(body.data.extrinsic.extrinsic, null);
  });

  test("extrinsics: a negative block filter is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      "{ extrinsics(block: -1) { total } }",
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("extrinsic: unresolved ref returns extrinsic:null, never a GraphQL error", async () => {
    const ref = `0x${"a".repeat(64)}`;
    const { status, body } = await gql(
      `{ extrinsic(ref: "${ref}") { ref extrinsic { call_module } } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.extrinsic.ref, ref);
    assert.equal(body.data.extrinsic.extrinsic, null);
  });

  test("extrinsic: resolves a Postgres-tier row by composite ref", async () => {
    const ref = "5-2";
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ref,
          extrinsic: {
            block_number: 5,
            extrinsic_index: 2,
            extrinsic_hash: null,
            signer: "5Signer",
            call_module: "SubtensorModule",
            call_function: "set_weights",
            call_args: null,
            success: true,
            fee_tao: 0,
            tip_tao: 0,
            observed_at: "2026-07-14T00:00:00.000Z",
          },
          events: [],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ extrinsic(ref: "${ref}") { ref extrinsic { call_module call_function } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.extrinsic.ref, ref);
    assert.equal(body.data.extrinsic.extrinsic.call_module, "SubtensorModule");
    assert.equal(body.data.extrinsic.extrinsic.call_function, "set_weights");
  });

  test("extrinsics / extrinsic are weighted as fan-out fields", () => {
    assert.equal(FIELD_COMPLEXITY.extrinsics, 5);
    assert.equal(FIELD_COMPLEXITY.extrinsic, 5);
  });
});

describe("graphql — governance_config_changes (#5897, Postgres-tier feed)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("governance_config_changes: cold/no-tier store returns a schema-stable empty page (fallback builder)", async () => {
    const { status, body } = await gql(
      "{ governance_config_changes { items { call_module } total next_cursor } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.governance_config_changes, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("governance_config_changes: resolves Postgres-tier AdminUtils rows", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          extrinsic_count: 1,
          limit: 20,
          offset: 0,
          next_cursor: "cursor-1",
          extrinsics: [
            {
              block_number: 5,
              extrinsic_index: 0,
              extrinsic_hash: `0x${"a".repeat(64)}`,
              signer: null,
              call_module: "AdminUtils",
              call_function: "sudo_set_weights_set_rate_limit",
              call_args: [{ name: "netuid", value: 1 }],
              success: true,
              fee_tao: 0,
              tip_tao: 0,
              observed_at: "2026-07-14T00:00:00.000Z",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      "{ governance_config_changes { items { block_number call_module call_function call_args success } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.governance_config_changes.total, 1);
    assert.equal(body.data.governance_config_changes.next_cursor, "cursor-1");
    const item = body.data.governance_config_changes.items[0];
    assert.equal(item.call_module, "AdminUtils");
    assert.equal(item.call_function, "sudo_set_weights_set_rate_limit");
    assert.equal(item.success, true);
    assert.equal(
      item.call_args,
      JSON.stringify([{ name: "netuid", value: 1 }]),
    );
  });

  test("governance_config_changes: a partial Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      // Body omits extrinsics / extrinsic_count / next_cursor entirely -- the
      // resolver must fall back to [] / 0 / null rather than surface undefined.
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      "{ governance_config_changes { items { call_module } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.governance_config_changes, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("governance_config_changes: filter args are forwarded to the /governance/config-changes path (loader reuse, no signer/call_module)", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            limit: 5,
            offset: 0,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(
      `{ governance_config_changes(limit: 5, block: 42, call_function: "sudo_set_tempo", success: true) { total } }`,
      env,
    );
    // The worker fixes call_module=AdminUtils by path, so the resolver hits the
    // governance route (not /extrinsics) and never forwards signer/call_module.
    assert.equal(capturedUrl.pathname, "/api/v1/governance/config-changes");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(capturedUrl.searchParams.get("block"), "42");
    assert.equal(
      capturedUrl.searchParams.get("call_function"),
      "sudo_set_tempo",
    );
    assert.equal(capturedUrl.searchParams.get("success"), "true");
    assert.equal(capturedUrl.searchParams.get("signer"), null);
    assert.equal(capturedUrl.searchParams.get("call_module"), null);
  });

  test("governance_config_changes: a cursor arg is forwarded as a query param", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            extrinsic_count: 0,
            limit: 20,
            offset: 0,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(`{ governance_config_changes(cursor: "abc123") { total } }`, env);
    assert.equal(capturedUrl.searchParams.get("cursor"), "abc123");
  });

  test("governance_config_changes: rejects a negative block with BAD_USER_INPUT", async () => {
    const { status, body } = await gql(
      "{ governance_config_changes(block: -1) { total } }",
    );
    assert.equal(status, 200);
    assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
  });

  test("governance_config_changes is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.governance_config_changes, 5);
  });
});

describe("graphql — blocks / block (#5575, Postgres-tier feed)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("blocks: cold/no-tier store returns a schema-stable empty page (fallback builder, production steady state)", async () => {
    const { status, body } = await gql(
      "{ blocks { items { block_number } total next_cursor } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.blocks, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("blocks: resolves Postgres-tier rows into the block feed", async () => {
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          block_count: 1,
          limit: 20,
          offset: 0,
          next_cursor: "cursor-1",
          blocks: [
            {
              block_number: 123,
              block_hash: `0x${"b".repeat(64)}`,
              parent_hash: `0x${"a".repeat(64)}`,
              author: "5Author",
              extrinsic_count: 3,
              event_count: 7,
              spec_version: 200,
              observed_at: "2026-07-14T00:00:00.000Z",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      "{ blocks { items { block_number block_hash extrinsic_count event_count } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.blocks.total, 1);
    assert.equal(body.data.blocks.next_cursor, "cursor-1");
    const item = body.data.blocks.items[0];
    assert.equal(item.block_number, 123);
    assert.equal(item.extrinsic_count, 3);
    assert.equal(item.event_count, 7);
  });

  test("blocks: limit/offset/cursor are forwarded as query params to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            block_count: 0,
            limit: 5,
            offset: 10,
            next_cursor: null,
            blocks: [],
          });
        },
      },
    };
    await gql(
      `{ blocks(limit: 5, offset: 10, cursor: "abc123") { total } }`,
      env,
    );
    assert.equal(capturedUrl.pathname, "/api/v1/blocks");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(capturedUrl.searchParams.get("offset"), "10");
    assert.equal(capturedUrl.searchParams.get("cursor"), "abc123");
  });

  test("blocks: a malformed Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      "{ blocks { items { block_number } total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.blocks, {
      items: [],
      total: 0,
      next_cursor: null,
    });
  });

  test("block: resolves a Postgres-tier row by numeric height, with chain-walk nav", async () => {
    const ref = "123";
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ref,
          block: {
            block_number: 123,
            block_hash: `0x${"b".repeat(64)}`,
            parent_hash: `0x${"a".repeat(64)}`,
            author: "5Author",
            extrinsic_count: 3,
            event_count: 7,
            spec_version: 200,
            observed_at: "2026-07-14T00:00:00.000Z",
          },
          prev_block_number: 122,
          next_block_number: 124,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ block(ref: "${ref}") { ref block { block_number spec_version } prev_block_number next_block_number } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.block.ref, ref);
    assert.equal(body.data.block.block.block_number, 123);
    assert.equal(body.data.block.block.spec_version, 200);
    assert.equal(body.data.block.prev_block_number, 122);
    assert.equal(body.data.block.next_block_number, 124);
  });

  test("block: resolves a Postgres-tier row by 0x block hash", async () => {
    const ref = `0x${"b".repeat(64)}`;
    let capturedUrl;
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            ref,
            block: {
              block_number: 123,
              block_hash: ref,
              parent_hash: null,
              author: null,
              extrinsic_count: 0,
              event_count: 0,
              spec_version: 200,
              observed_at: "2026-07-14T00:00:00.000Z",
            },
            prev_block_number: null,
            next_block_number: null,
          });
        },
      },
    };
    const { status, body } = await gql(
      `{ block(ref: "${ref}") { ref block { block_number block_hash } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, `/api/v1/blocks/${ref}`);
    assert.equal(body.data.block.block.block_number, 123);
    assert.equal(body.data.block.block.block_hash, ref);
  });

  test("block: unresolved ref returns block:null, never a GraphQL error", async () => {
    const ref = `0x${"c".repeat(64)}`;
    const { status, body } = await gql(
      `{ block(ref: "${ref}") { ref block { block_number } prev_block_number next_block_number } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.block.ref, ref);
    assert.equal(body.data.block.block, null);
    assert.equal(body.data.block.prev_block_number, null);
    assert.equal(body.data.block.next_block_number, null);
  });

  test("block: a malformed Postgres-tier body falls back to the requested ref", async () => {
    const ref = "123";
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      `{ block(ref: "${ref}") { ref block { block_number } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.block.ref, ref);
    assert.equal(body.data.block.block, null);
  });

  test("blocks / block are weighted as fan-out fields", () => {
    assert.equal(FIELD_COMPLEXITY.blocks, 5);
    assert.equal(FIELD_COMPLEXITY.block, 5);
  });
});

describe("graphql — validators / validator (#5573, Postgres-tier leaderboard)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("validators: cold/no-tier store returns a schema-stable empty page (fallback builder)", async () => {
    const { status, body } = await gql(
      "{ validators { items { hotkey } total sort captured_at block_number } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.validators, {
      items: [],
      total: 0,
      sort: "subnet_count",
      captured_at: null,
      block_number: null,
    });
  });

  test("validators: resolves Postgres-tier rows, normalizing latest_* into captured_at/block_number", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          sort: "total_stake",
          limit: 20,
          captured_at: "2026-07-14T00:00:00.000Z",
          block_number: 100,
          validator_count: 1,
          validators: [
            {
              hotkey: "5Validator",
              featured: true,
              coldkey: "5Coldkey",
              coldkey_identity: { has_identity: false },
              coldkey_count: 1,
              subnet_count: 1,
              uid_count: 1,
              take: 0.1,
              total_stake_tao: 1000,
              root_stake_tao: 0,
              alpha_stake_tao: 1000,
              total_emission_tao: 5,
              nominator_count: 3,
              apy_estimate: 0.12,
              apy_estimate_eligible_subnet_count: 1,
              avg_validator_trust: 0.9,
              max_validator_trust: 0.9,
              latest_captured_at: "2026-07-14T00:00:00.000Z",
              latest_block_number: 100,
              subnets: [
                {
                  netuid: 1,
                  uid: 5,
                  stake_tao: 1000,
                  emission_tao: 5,
                  validator_trust: 0.9,
                },
              ],
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      '{ validators(sort: "total_stake", limit: 5) { items { hotkey featured coldkey nominator_count captured_at block_number subnets { netuid uid stake_tao } } total sort captured_at block_number } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.validators.total, 1);
    assert.equal(body.data.validators.sort, "total_stake");
    assert.equal(body.data.validators.captured_at, "2026-07-14T00:00:00.000Z");
    assert.equal(body.data.validators.block_number, 100);
    const item = body.data.validators.items[0];
    assert.equal(item.hotkey, "5Validator");
    assert.equal(item.featured, true);
    assert.equal(item.nominator_count, 3);
    assert.equal(item.captured_at, "2026-07-14T00:00:00.000Z");
    assert.equal(item.block_number, 100);
    assert.deepEqual(item.subnets, [{ netuid: 1, uid: 5, stake_tao: 1000 }]);
  });

  test("validators: sort and limit args are forwarded as query params to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            sort: "uid_count",
            limit: 5,
            captured_at: null,
            block_number: null,
            validator_count: 0,
            validators: [],
          });
        },
      },
    };
    await gql('{ validators(sort: "uid_count", limit: 5) { total } }', env);
    assert.equal(capturedUrl.pathname, "/api/v1/validators");
    assert.equal(capturedUrl.searchParams.get("sort"), "uid_count");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
  });

  test("validators: an omitted limit forwards the default limit to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            sort: "subnet_count",
            limit: 20,
            captured_at: null,
            block_number: null,
            validator_count: 0,
            validators: [],
          });
        },
      },
    };
    await gql("{ validators { total } }", env);
    assert.equal(capturedUrl.searchParams.get("sort"), "subnet_count");
    assert.equal(capturedUrl.searchParams.get("limit"), "20");
  });

  test("validators: a malformed Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      "{ validators { items { hotkey } total sort captured_at block_number } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.validators, {
      items: [],
      total: 0,
      sort: "subnet_count",
      captured_at: null,
      block_number: null,
    });
  });

  test("validators: an unsupported sort value is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      '{ validators(sort: "not_a_real_sort") { total } }',
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("validator: a hotkey with no validator_permit=1 rows resolves to a schema-stable zeroed aggregate, never null", async () => {
    const { status, body } = await gql(
      '{ validator(hotkey: "5NoRows") { hotkey featured subnet_count total_stake_tao captured_at block_number subnets { netuid } } }',
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.validator, {
      hotkey: "5NoRows",
      featured: false,
      subnet_count: 0,
      total_stake_tao: 0,
      captured_at: null,
      block_number: null,
      subnets: [],
    });
  });

  test("validator: resolves Postgres-tier detail data, normalizing captured_at/block_number", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          hotkey: "5Validator",
          coldkey: "5Coldkey",
          coldkey_identity: { has_identity: false },
          coldkey_count: 1,
          subnet_count: 2,
          take: 0.1,
          total_stake_tao: 2000,
          root_stake_tao: 500,
          alpha_stake_tao: 1500,
          total_emission_tao: 8,
          nominator_count: null,
          apy_estimate: null,
          apy_estimate_eligible_subnet_count: 0,
          avg_validator_trust: 0.8,
          max_validator_trust: 0.85,
          captured_at: "2026-07-14T01:00:00.000Z",
          block_number: 200,
          subnets: [
            { netuid: 1, uid: 5, stake_tao: 500, emission_tao: 2 },
            { netuid: 3, uid: 9, stake_tao: 1500, emission_tao: 6 },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      '{ validator(hotkey: "5Validator") { hotkey subnet_count captured_at block_number subnets { netuid stake_tao } } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.validator.hotkey, "5Validator");
    assert.equal(body.data.validator.subnet_count, 2);
    assert.equal(body.data.validator.captured_at, "2026-07-14T01:00:00.000Z");
    assert.equal(body.data.validator.block_number, 200);
    assert.deepEqual(body.data.validator.subnets, [
      { netuid: 1, stake_tao: 500 },
      { netuid: 3, stake_tao: 1500 },
    ]);
  });

  test("validators / validator are weighted as fan-out fields", () => {
    assert.equal(FIELD_COMPLEXITY.validators, 5);
    assert.equal(FIELD_COMPLEXITY.validator, 5);
  });
});

describe("graphql — account_position_history (#5889, Postgres-tier + empty-points fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable empty-points card, never null", async () => {
    const { status, body } = await gql(
      `{ account_position_history(ss58: "${SS58}", netuid: 1) {
          schema_version ss58 netuid window point_count points { snapshot_date }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_position_history, {
      schema_version: 1,
      ss58: SS58,
      netuid: 1,
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("resolves the Postgres-tier points for the requested window", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ss58: SS58,
          netuid: 5,
          window: "90d",
          point_count: 1,
          points: [
            {
              snapshot_date: "2026-07-01",
              captured_at: "2026-07-01T00:00:00.000Z",
              uid: 3,
              coldkey: "5Cold",
              role: "validator",
              active: true,
              stake_tao: 1000,
              emission_tao: 4,
              rank: 0.1,
              trust: 0.2,
              incentive: 0.3,
              dividends: 0.4,
              yield: 0.004,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ account_position_history(ss58: "${SS58}", netuid: 5, window: "90d") {
          ss58 netuid window point_count
          points { snapshot_date captured_at uid coldkey role active stake_tao emission_tao rank trust incentive dividends yield }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.account_position_history;
    assert.equal(r.netuid, 5);
    assert.equal(r.window, "90d");
    assert.equal(r.point_count, 1);
    assert.equal(r.points[0].role, "validator");
    assert.equal(r.points[0].stake_tao, 1000);
    assert.equal(r.points[0].yield, 0.004);
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the tier", async () => {
    const { status, body } = await gql(
      `{ account_position_history(ss58: "not-an-ss58", netuid: 1) { point_count } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });

  test("an out-of-range netuid is BAD_USER_INPUT", async () => {
    const { status, body } = await gql(
      `{ account_position_history(ss58: "${SS58}", netuid: 99999) { point_count } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });

  test("window is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      `{ account_position_history(ss58: "${SS58}", netuid: 5, window: "7d") { window } }`,
      env,
    );
    assert.equal(capturedUrl.searchParams.get("window"), "7d");
    assert.ok(
      capturedUrl.pathname.endsWith(`/accounts/${SS58}/subnets/5/history`),
    );
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ account_position_history(ss58: "${SS58}", netuid: 3, window: "30d") {
          schema_version ss58 netuid window point_count points { snapshot_date }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_position_history, {
      schema_version: 1,
      ss58: SS58,
      netuid: 3,
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { status, body } = await gql(
      `{ account_position_history(ss58: "${SS58}", netuid: 1, window: "99d") { point_count } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });
});

describe("graphql — subnet_turnover (#5886, Postgres-tier + empty-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }
  const EMPTY = {
    schema_version: 1,
    netuid: 1,
    window: "30d",
    start_date: null,
    end_date: null,
    comparable: false,
    validators_start: 0,
    validators_end: 0,
    validators_entered: 0,
    validators_exited: 0,
    validator_retention: null,
    neurons_start: 0,
    neurons_end: 0,
    uids_deregistered: 0,
    neuron_retention: null,
    stability_score: null,
  };
  const ALL_FIELDS =
    "schema_version netuid window start_date end_date comparable validators_start validators_end validators_entered validators_exited validator_retention neurons_start neurons_end uids_deregistered neuron_retention stability_score";

  test("cold store: no Postgres flag returns a schema-stable empty card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_turnover(netuid: 1) { ${ALL_FIELDS} } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_turnover, EMPTY);
  });

  test("resolves the Postgres-tier scorecard for the requested window", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          window: "90d",
          start_date: "2026-04-01",
          end_date: "2026-06-30",
          comparable: true,
          validators_start: 10,
          validators_end: 12,
          validators_entered: 3,
          validators_exited: 1,
          validator_retention: 0.9,
          neurons_start: 100,
          neurons_end: 110,
          uids_deregistered: 4,
          neuron_retention: 0.85,
          stability_score: 88,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_turnover(netuid: 5, window: "90d") { ${ALL_FIELDS} } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.subnet_turnover;
    assert.equal(r.netuid, 5);
    assert.equal(r.window, "90d");
    assert.equal(r.comparable, true);
    assert.equal(r.validators_entered, 3);
    assert.equal(r.validator_retention, 0.9);
    assert.equal(r.stability_score, 88);
  });

  test("window + netuid are forwarded to the Postgres tier route", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(`{ subnet_turnover(netuid: 7, window: "7d") { window } }`, env);
    assert.equal(capturedUrl.searchParams.get("window"), "7d");
    assert.ok(capturedUrl.pathname.endsWith("/subnets/7/turnover"));
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_turnover(netuid: 1, window: "30d") { ${ALL_FIELDS} } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_turnover, EMPTY);
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { status, body } = await gql(
      `{ subnet_turnover(netuid: 1, window: "99d") { comparable } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });

  test("an out-of-range netuid is BAD_USER_INPUT", async () => {
    const { status, body } = await gql(
      `{ subnet_turnover(netuid: 99999) { comparable } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });
});

// #6978: GraphQL parity for the conviction/ownership-contest (#4302) and
// subnet-leasing (#6717) epics. ownership_history/conviction/lease_history
// reach the Postgres-only all-events tier unconditionally (no per-table flag,
// unlike subnet_turnover above), mirroring MCP's get_subnet_ownership_history/
// get_subnet_conviction/get_subnet_lease_history proxies byte-for-byte.
describe("graphql — subnet_ownership_history / subnet_conviction / subnet_lease_history", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("subnet_ownership_history returns the decoded ownership-change list", async () => {
    const env = {
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          count: 1,
          ownership_changes: [
            {
              netuid: 7,
              old_coldkey: "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i",
              new_coldkey: "5EYCAe5jLQhn6ofDSvqF6iY53erXNkwhyE1aCEgvi1NNs91F",
              block_number: 8587754,
              observed_at: "2026-07-09T12:26:40.000Z",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      "{ subnet_ownership_history(netuid: 7) { schema_version netuid count ownership_changes } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.subnet_ownership_history;
    assert.equal(r.netuid, 7);
    assert.equal(r.count, 1);
    assert.equal(
      r.ownership_changes[0].old_coldkey,
      "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i",
    );
  });

  test("subnet_conviction returns the leaderboard and live-rolled rates", async () => {
    const env = {
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          queried_at_block: 5000000,
          unlock_rate: 0.001,
          maturity_rate: 0.002,
          king: { coldkey: "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i" },
          count: 1,
          leaderboard: [
            {
              coldkey: "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i",
              conviction: 1000,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      "{ subnet_conviction(netuid: 7) { schema_version netuid queried_at_block unlock_rate maturity_rate king count leaderboard } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.subnet_conviction;
    assert.equal(r.netuid, 7);
    assert.equal(r.unlock_rate, 0.001);
    assert.equal(
      r.king.coldkey,
      "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i",
    );
    assert.equal(r.leaderboard[0].conviction, 1000);
  });

  test("subnet_lease_history returns the decoded lease-lifecycle event list", async () => {
    const env = {
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 9,
          count: 1,
          lease_events: [
            {
              event_kind: "SubnetLeaseCreated",
              beneficiary: "5HHBZRFX9UiyG77qU1pn1qMceRYKeg2a4yGBwPCHCyDocX4i",
              block_number: 8000000,
              observed_at: "2026-07-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      "{ subnet_lease_history(netuid: 9) { schema_version netuid count lease_events } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.subnet_lease_history;
    assert.equal(r.netuid, 9);
    assert.equal(r.count, 1);
    assert.equal(r.lease_events[0].event_kind, "SubnetLeaseCreated");
  });

  test("a subnet with no recorded events returns an empty list, not an error", async () => {
    const env = {
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 4,
          count: 0,
          ownership_changes: [],
        }),
      ),
    };
    const { body } = await gql(
      "{ subnet_ownership_history(netuid: 4) { count ownership_changes } }",
      env,
    );
    assert.equal(body.data.subnet_ownership_history.count, 0);
    assert.deepEqual(body.data.subnet_ownership_history.ownership_changes, []);
  });

  test("a fully empty tier body degrades every field to its resolver default", async () => {
    // A fresh Response per fetch call (unlike the shared-instance dataApi()
    // helper above) since this test reuses `env` across three requests and a
    // Response body can only be consumed once.
    const env = { DATA_API: { fetch: async () => Response.json({}) } };

    const ownership = await gql(
      "{ subnet_ownership_history(netuid: 4) { schema_version netuid count ownership_changes } }",
      env,
    );
    assert.deepEqual(ownership.body.data.subnet_ownership_history, {
      schema_version: 1,
      netuid: 4,
      count: 0,
      ownership_changes: [],
    });

    const conviction = await gql(
      "{ subnet_conviction(netuid: 4) { schema_version netuid queried_at_block unlock_rate maturity_rate king count leaderboard } }",
      env,
    );
    assert.deepEqual(conviction.body.data.subnet_conviction, {
      schema_version: 1,
      netuid: 4,
      queried_at_block: null,
      unlock_rate: null,
      maturity_rate: null,
      king: null,
      count: 0,
      leaderboard: [],
    });

    const leaseHistory = await gql(
      "{ subnet_lease_history(netuid: 4) { schema_version netuid count lease_events } }",
      env,
    );
    assert.deepEqual(leaseHistory.body.data.subnet_lease_history, {
      schema_version: 1,
      netuid: 4,
      count: 0,
      lease_events: [],
    });
  });

  test("surfaces a missing DATA_API binding as a GraphQL error", async () => {
    const { body } = await gql(
      "{ subnet_ownership_history(netuid: 7) { count } }",
    );
    assert.ok(body.errors?.length);
    assert.equal(body.data, null);
  });

  test("surfaces a non-OK DATA_API response as a GraphQL error", async () => {
    const env = { DATA_API: dataApi(new Response("err", { status: 502 })) };
    const { body } = await gql(
      "{ subnet_conviction(netuid: 7) { count } }",
      env,
    );
    assert.ok(body.errors?.length);
    assert.equal(body.data, null);
  });

  test("surfaces a DATA_API fetch failure as a GraphQL error", async () => {
    const env = {
      DATA_API: {
        fetch: async () => {
          throw new Error("network unreachable");
        },
      },
    };
    const { body } = await gql(
      "{ subnet_lease_history(netuid: 9) { count } }",
      env,
    );
    assert.ok(body.errors?.length);
    assert.equal(body.data, null);
  });

  test("FIELD_COMPLEXITY weights all three like their sibling Postgres-tier fields", () => {
    for (const field of [
      "subnet_ownership_history",
      "subnet_conviction",
      "subnet_lease_history",
    ]) {
      assert.equal(FIELD_COMPLEXITY[field], 5, `${field} should be weighted`);
    }
  });

  test("an out-of-range or negative netuid is BAD_USER_INPUT and never reaches the tier", async () => {
    for (const { query, field } of [
      {
        query: "{ subnet_ownership_history(netuid: 99999) { count } }",
        field: "subnet_ownership_history",
      },
      {
        query: "{ subnet_conviction(netuid: -1) { count } }",
        field: "subnet_conviction",
      },
      {
        query: "{ subnet_lease_history(netuid: 99999) { count } }",
        field: "subnet_lease_history",
      },
    ]) {
      let called = false;
      const env = {
        DATA_API: {
          fetch: async () => {
            called = true;
            return Response.json({});
          },
        },
      };
      const { status, body } = await gql(query, env);
      assert.equal(status, 200);
      // Non-null field type (SubnetOwnershipHistory!/etc.) -- an error nulls
      // the whole response, not just this field.
      assert.equal(body.data, null, `${field} should null the response`);
      assert.ok(
        body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"),
        `${field} should be BAD_USER_INPUT`,
      );
      assert.equal(called, false, `${field} should never reach DATA_API`);
    }
  });
});

// #6978: subnet_lease is the live-RPC counterpart (current state, not the
// event log) -- same schema-stable-null-on-RPC-failure shape as
// subnet_recycled/subnet_burn above, reusing loadSubnetLease unchanged.
describe("graphql — subnet_lease (#6719, live chain RPC via subnet-lease.mjs)", () => {
  function withFetchStub(stub, fn) {
    const orig = globalThis.fetch;
    globalThis.fetch = stub;
    return Promise.resolve(fn()).finally(() => {
      globalThis.fetch = orig;
    });
  }

  test("returns leased:false for a confirmed no-lease result", async () => {
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: null }),
      }),
      async () => {
        const { status, body } = await gql(
          "{ subnet_lease(netuid: 7) { schema_version netuid leased lease queried_at } }",
        );
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        const r = body.data.subnet_lease;
        assert.equal(r.netuid, 7);
        assert.equal(r.leased, false);
        assert.equal(r.lease, null);
        assert.ok(r.queried_at);
      },
    );
  });

  test("RPC failure degrades leased to null, never a GraphQL error", async () => {
    await withFetchStub(
      async () => {
        throw new Error("network unreachable");
      },
      async () => {
        const { status, body } = await gql(
          "{ subnet_lease(netuid: 7) { leased } }",
        );
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        assert.equal(body.data.subnet_lease.leased, null);
      },
    );
  });

  test("an out-of-range netuid is BAD_USER_INPUT and never reaches the RPC", async () => {
    let called = false;
    await withFetchStub(
      async () => {
        called = true;
        return { ok: true, json: async () => ({ result: null }) };
      },
      async () => {
        const { status, body } = await gql(
          "{ subnet_lease(netuid: 99999) { leased } }",
        );
        assert.equal(status, 200);
        assert.equal(body.data.subnet_lease, null);
        assert.ok(
          body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"),
        );
        assert.equal(called, false);
      },
    );
  });

  test("a negative netuid is BAD_USER_INPUT", async () => {
    const { status, body } = await gql(
      "{ subnet_lease(netuid: -1) { leased } }",
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });

  test("subnet_lease is weighted like its live-RPC siblings", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_lease, 10);
    assert.equal(
      FIELD_COMPLEXITY.subnet_lease,
      FIELD_COMPLEXITY.subnet_recycled,
    );
  });
});

describe("graphql — validator_history (#5710, Postgres-tier + empty-points fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag / no neuron_daily rows returns a schema-stable empty-points card, never null", async () => {
    const { status, body } = await gql(
      `{ validator_history(hotkey: "5NoRows") {
          schema_version hotkey window point_count points { snapshot_date }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.validator_history, {
      schema_version: 1,
      hotkey: "5NoRows",
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("resolves the Postgres-tier points for the requested window", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          hotkey: "5Validator",
          window: "90d",
          point_count: 1,
          points: [
            {
              snapshot_date: "2026-07-01",
              subnet_count: 2,
              total_stake_tao: 1000,
              total_emission_tao: 4,
              rewards_per_1000_tao: 4,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ validator_history(hotkey: "5Validator", window: "90d") {
          hotkey window point_count
          points { snapshot_date subnet_count total_stake_tao total_emission_tao rewards_per_1000_tao }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.validator_history;
    assert.equal(r.hotkey, "5Validator");
    assert.equal(r.window, "90d");
    assert.equal(r.point_count, 1);
    assert.deepEqual(r.points, [
      {
        snapshot_date: "2026-07-01",
        subnet_count: 2,
        total_stake_tao: 1000,
        total_emission_tao: 4,
        rewards_per_1000_tao: 4,
      },
    ]);
  });

  test("window is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      '{ validator_history(hotkey: "5Validator", window: "7d") { window } }',
      env,
    );
    assert.equal(capturedUrl.searchParams.get("window"), "7d");
    assert.ok(capturedUrl.pathname.endsWith("/validators/5Validator/history"));
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ validator_history(hotkey: "5Validator", window: "30d") {
          schema_version hotkey window point_count points { snapshot_date }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.validator_history, {
      schema_version: 1,
      hotkey: "5Validator",
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ validator_history(hotkey: "5Validator", window: "99d") { point_count } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|30d/i.test(body.errors[0].message));
    assert.equal(body.data?.validator_history ?? null, null);
  });

  test("validator_history is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.validator_history, 5);
  });
});

describe("graphql — subnet_trajectory (#5887, Postgres-tier + D1-live fallback)", () => {
  const trajectoryQuery = `{ subnet_trajectory(netuid: 3) {
    schema_version netuid point_count
    points { date completeness_score surface_count total_stake_tao }
    deltas { window from_date to_date completeness_score tao_in_pool_tao }
  } }`;

  const P1 = {
    date: "2026-07-01",
    completeness_score: 50,
    surface_count: 4,
    endpoint_count: 2,
    validator_count: null,
    miner_count: null,
    total_stake_tao: 100,
    alpha_price_tao: null,
    emission_share: null,
    tao_in_pool_tao: 10,
    alpha_in_pool: null,
    alpha_out_pool: null,
    subnet_volume_tao: null,
  };
  const P2 = {
    ...P1,
    date: "2026-07-08",
    completeness_score: 60,
    tao_in_pool_tao: 15,
  };

  test("cold store: schema-stable empty trajectory", async () => {
    const { status, body } = await gql(trajectoryQuery);
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_trajectory, {
      schema_version: 1,
      netuid: 3,
      point_count: 0,
      points: [],
      deltas: [],
    });
  });

  test("resolves Postgres-tier data and flattens the window-keyed deltas map to a labelled list", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            netuid: 3,
            point_count: 2,
            points: [P1, P2],
            deltas: {
              "7d": {
                from_date: "2026-07-01",
                to_date: "2026-07-08",
                completeness_score: 10,
                surface_count: 0,
                endpoint_count: 0,
                tao_in_pool_tao: 5,
                alpha_in_pool: null,
                alpha_out_pool: null,
              },
              "30d": null,
            },
          });
        },
      },
    };
    const { status, body } = await gql(trajectoryQuery, env);
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/subnets/3/trajectory");
    assert.equal(body.data.subnet_trajectory.point_count, 2);
    assert.equal(body.data.subnet_trajectory.points[0].date, "2026-07-01");
    assert.equal(body.data.subnet_trajectory.points[1].completeness_score, 60);
    // The window-keyed map becomes a list; the null 30d entry is dropped and
    // the 7d entry carries its label.
    assert.equal(body.data.subnet_trajectory.deltas.length, 1);
    assert.equal(body.data.subnet_trajectory.deltas[0].window, "7d");
    assert.equal(body.data.subnet_trajectory.deltas[0].completeness_score, 10);
    assert.equal(body.data.subnet_trajectory.deltas[0].tao_in_pool_tao, 5);
  });

  test("a malformed Postgres-tier body degrades to a schema-stable empty trajectory", async () => {
    const env = {
      METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(trajectoryQuery, env);
    assert.equal(status, 200);
    assert.equal(body.data.subnet_trajectory.point_count, 0);
    assert.deepEqual(body.data.subnet_trajectory.points, []);
    assert.deepEqual(body.data.subnet_trajectory.deltas, []);
  });

  // D1 fully eliminated (2026-07-17): subnet_snapshots is Postgres-only now,
  // so a tier miss always yields an empty trajectory -- even a "warm" D1 mock
  // (real rows) must not change the response.
  test("no Postgres tier flag: never queries D1, returns a schema-stable empty trajectory", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error(
            "D1 must not be queried -- subnet_snapshots is retired",
          );
        },
      },
    };
    const { status, body } = await gql(trajectoryQuery, env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_trajectory, {
      schema_version: 1,
      netuid: 3,
      point_count: 0,
      points: [],
      deltas: [],
    });
  });

  test("subnet_trajectory is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_trajectory, 5);
  });
});

describe("graphql — subnet_identity_history (#5721, Postgres-tier + empty timeline fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag / no D1 rows returns a schema-stable empty timeline, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_identity_history(netuid: 1) {
          schema_version netuid entry_count limit offset next_cursor
          entries { subnet_name identity_hash }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_identity_history, {
      schema_version: 1,
      netuid: 1,
      entry_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      entries: [],
    });
  });

  test("resolves the Postgres-tier timeline entries", async () => {
    const env = {
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          entry_count: 1,
          limit: 50,
          offset: 0,
          next_cursor: null,
          entries: [
            {
              block_number: 4200,
              observed_at: "2026-07-01T00:00:00.000Z",
              subnet_name: "Example",
              symbol: "EX",
              description: "desc",
              github_repo: "https://github.com/example/repo",
              subnet_url: "https://example.com",
              discord: "https://discord.gg/example",
              logo_url: "https://example.com/logo.png",
              identity_hash: "abc123",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_identity_history(netuid: 7, limit: 50) {
          netuid entry_count limit
          entries {
            block_number observed_at subnet_name symbol description
            github_repo subnet_url discord logo_url identity_hash
          }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.subnet_identity_history;
    assert.equal(r.netuid, 7);
    assert.equal(r.entry_count, 1);
    assert.equal(r.limit, 50);
    assert.deepEqual(r.entries, [
      {
        block_number: 4200,
        observed_at: "2026-07-01T00:00:00.000Z",
        subnet_name: "Example",
        symbol: "EX",
        description: "desc",
        github_repo: "https://github.com/example/repo",
        subnet_url: "https://example.com",
        discord: "https://discord.gg/example",
        logo_url: "https://example.com/logo.png",
        identity_hash: "abc123",
      },
    ]);
  });

  // D1 fully eliminated (2026-07-17): subnet_identity_history is built
  // directly from an empty row set on a tier miss now (buildSubnetIdentityHistory([], ...)),
  // so a tier miss always yields the schema-stable empty timeline -- even a
  // "warm" D1 mock (real rows) must not change the response.
  test("no Postgres tier flag: never queries D1, returns a schema-stable empty timeline", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error(
            "D1 must not be queried -- subnet_identity_history is retired",
          );
        },
      },
    };
    const { status, body } = await gql(
      `{ subnet_identity_history(netuid: 86, limit: 10) {
          netuid entry_count limit
          entries { block_number observed_at subnet_name symbol identity_hash }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.subnet_identity_history;
    assert.equal(r.netuid, 86);
    assert.equal(r.entry_count, 0);
    assert.equal(r.limit, 10);
    assert.deepEqual(r.entries, []);
  });

  test("pagination args are forwarded to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      '{ subnet_identity_history(netuid: 3, limit: 25, offset: 10, cursor: "abc") { entry_count } }',
      env,
    );
    assert.equal(capturedUrl.searchParams.get("limit"), "25");
    assert.equal(capturedUrl.searchParams.get("offset"), "10");
    assert.equal(capturedUrl.searchParams.get("cursor"), "abc");
    assert.ok(capturedUrl.pathname.endsWith("/subnets/3/identity-history"));
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_identity_history(netuid: 9) {
          schema_version netuid entry_count limit offset next_cursor entries { subnet_name }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_identity_history, {
      schema_version: 1,
      netuid: 9,
      entry_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      entries: [],
    });
  });

  test("a negative netuid is a GraphQL error, not an empty card", async () => {
    const { body } = await gql(
      "{ subnet_identity_history(netuid: -1) { entry_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_identity_history ?? null, null);
  });

  test("subnet_identity_history is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_identity_history, 5);
  });
});

describe("graphql — chain_identity_history (#5878, Postgres-tier + empty-feed fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag / no D1 rows returns a schema-stable empty feed, never null", async () => {
    const { status, body } = await gql(
      `{ chain_identity_history {
          schema_version count subnet_count changes { netuid subnet_name identity_hash }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_identity_history, {
      schema_version: 1,
      count: 0,
      subnet_count: 0,
      changes: [],
    });
  });

  test("resolves the Postgres-tier network feed, mapping each cross-subnet change", async () => {
    const env = {
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          count: 2,
          subnet_count: 2,
          changes: [
            {
              netuid: 7,
              block_number: 4200,
              observed_at: "2026-07-01T00:00:00.000Z",
              subnet_name: "Example",
              symbol: "EX",
              description: "desc",
              github_repo: "https://github.com/example/repo",
              subnet_url: "https://example.com",
              discord: "https://discord.gg/example",
              logo_url: "https://example.com/logo.png",
              identity_hash: "abc123",
            },
            {
              netuid: 12,
              block_number: 4180,
              observed_at: "2026-06-30T00:00:00.000Z",
              subnet_name: "Other",
              symbol: "OT",
              description: null,
              github_repo: null,
              subnet_url: null,
              discord: null,
              logo_url: null,
              identity_hash: "def456",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ chain_identity_history(limit: 50) {
          schema_version count subnet_count
          changes { netuid block_number observed_at subnet_name symbol identity_hash }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.chain_identity_history;
    assert.equal(r.count, 2);
    assert.equal(r.subnet_count, 2);
    assert.equal(r.changes.length, 2);
    assert.equal(r.changes[0].netuid, 7);
    assert.equal(r.changes[0].subnet_name, "Example");
    assert.equal(r.changes[1].netuid, 12);
    assert.equal(r.changes[1].identity_hash, "def456");
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_SUBNET_IDENTITY_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ chain_identity_history {
          schema_version count subnet_count changes { netuid }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_identity_history, {
      schema_version: 1,
      count: 0,
      subnet_count: 0,
      changes: [],
    });
  });
});

describe("graphql — accounts / account (#5574, Postgres-tier accounts leaderboard)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  test("accounts: cold/no-tier store returns a schema-stable empty page (fallback builder)", async () => {
    const { status, body } = await gql(
      "{ accounts { items { hotkey } total sort captured_at block_number } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.accounts, {
      items: [],
      total: 0,
      sort: "total_stake",
      captured_at: null,
      block_number: null,
    });
  });

  test("accounts: resolves Postgres-tier rows", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            sort: "total_stake",
            limit: 5,
            captured_at: "2026-07-15T00:00:00.000Z",
            block_number: 300,
            account_count: 1,
            accounts: [
              {
                hotkey: "5Account",
                coldkey: "5Coldkey",
                coldkey_count: 1,
                subnet_count: 2,
                uid_count: 2,
                validator_count: 1,
                miner_count: 1,
                total_stake_tao: 1500,
                total_emission_tao: 7,
                stake_dominance: 0.42,
                latest_captured_at: "2026-07-15T00:00:00.000Z",
                latest_block_number: 300,
                subnets: [
                  { netuid: 1, uid: 5, stake_tao: 1000, emission_tao: 5 },
                  { netuid: 3, uid: 9, stake_tao: 500, emission_tao: 2 },
                ],
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(
      '{ accounts(sort: "total_stake", limit: 5) { items { hotkey coldkey subnet_count total_stake_tao stake_dominance latest_captured_at latest_block_number subnets { netuid uid stake_tao emission_tao } } total sort captured_at block_number } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.accounts.total, 1);
    assert.equal(body.data.accounts.sort, "total_stake");
    assert.equal(body.data.accounts.captured_at, "2026-07-15T00:00:00.000Z");
    assert.equal(body.data.accounts.block_number, 300);
    const item = body.data.accounts.items[0];
    assert.equal(item.hotkey, "5Account");
    assert.equal(item.coldkey, "5Coldkey");
    assert.equal(item.subnet_count, 2);
    assert.equal(item.total_stake_tao, 1500);
    assert.equal(item.stake_dominance, 0.42);
    assert.deepEqual(item.subnets, [
      { netuid: 1, uid: 5, stake_tao: 1000, emission_tao: 5 },
      { netuid: 3, uid: 9, stake_tao: 500, emission_tao: 2 },
    ]);
  });

  test("accounts: sort and limit args are forwarded as query params to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            sort: "uid_count",
            limit: 5,
            captured_at: null,
            block_number: null,
            account_count: 0,
            accounts: [],
          });
        },
      },
    };
    await gql('{ accounts(sort: "uid_count", limit: 5) { total } }', env);
    assert.equal(capturedUrl.pathname, "/api/v1/accounts");
    assert.equal(capturedUrl.searchParams.get("sort"), "uid_count");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
  });

  test("accounts: an omitted sort/limit forwards the defaults to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            sort: "total_stake",
            limit: 20,
            captured_at: null,
            block_number: null,
            account_count: 0,
            accounts: [],
          });
        },
      },
    };
    await gql("{ accounts { total } }", env);
    assert.equal(capturedUrl.searchParams.get("sort"), "total_stake");
    assert.equal(capturedUrl.searchParams.get("limit"), "20");
  });

  test("accounts: a malformed Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      "{ accounts { items { hotkey } total sort captured_at block_number } }",
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.accounts, {
      items: [],
      total: 0,
      sort: "total_stake",
      captured_at: null,
      block_number: null,
    });
  });

  test("accounts: an unsupported sort value is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      '{ accounts(sort: "not_a_real_sort") { total } }',
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("account: an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      '{ account(ss58: "not-a-valid-address") { ss58 } }',
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    // `account` is a nullable field (unlike `validators`/`accounts`), so the
    // thrown error nulls out just this field, not the whole `data` object.
    assert.equal(body.data.account, null);
    assert.equal(called, false);
  });

  test("account: a never-seen address (cold store) resolves to a schema-stable zero summary, never null", async () => {
    const { status, body } = await gql(
      `{ account(ss58: "${SS58}") { ss58 event_count subnet_count event_scan_capped first_block last_block event_kinds { kind } registrations { netuid } recent_events { block_number } activity { tx_count modules_called { call_module } } } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account, {
      ss58: SS58,
      event_count: 0,
      subnet_count: 0,
      event_scan_capped: false,
      first_block: null,
      last_block: null,
      event_kinds: [],
      registrations: [],
      recent_events: [],
      activity: { tx_count: 0, modules_called: [] },
    });
  });

  test("account: resolves Postgres-tier detail data", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            ss58: SS58,
            event_count: 12,
            subnet_count: 2,
            event_scan_capped: false,
            first_block: 100,
            last_block: 500,
            first_seen_at: "2026-06-01T00:00:00.000Z",
            last_seen_at: "2026-07-14T00:00:00.000Z",
            event_kinds: [{ kind: "Transfer", count: 5 }],
            registrations: [
              {
                netuid: 1,
                uid: 5,
                stake_tao: 10,
                validator_permit: true,
                active: true,
              },
            ],
            recent_events: [
              { block_number: 500, event_index: 0, event_kind: "Transfer" },
            ],
            activity: {
              tx_count: 3,
              last_tx_block: 490,
              last_tx_at: "2026-07-13T00:00:00.000Z",
              total_fee_tao: 0.01,
              modules_called: [{ call_module: "SubtensorModule", count: 3 }],
            },
          }),
      },
    };
    const { status, body } = await gql(
      `{ account(ss58: "${SS58}") { ss58 event_count subnet_count first_block last_block event_kinds { kind count } registrations { netuid stake_tao validator_permit active } recent_events { block_number event_kind } activity { tx_count last_tx_block total_fee_tao modules_called { call_module count } } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.account.ss58, SS58);
    assert.equal(body.data.account.event_count, 12);
    assert.equal(body.data.account.subnet_count, 2);
    assert.equal(body.data.account.first_block, 100);
    assert.equal(body.data.account.last_block, 500);
    assert.deepEqual(body.data.account.event_kinds, [
      { kind: "Transfer", count: 5 },
    ]);
    assert.deepEqual(body.data.account.registrations, [
      { netuid: 1, stake_tao: 10, validator_permit: true, active: true },
    ]);
    assert.deepEqual(body.data.account.recent_events, [
      { block_number: 500, event_kind: "Transfer" },
    ]);
    assert.deepEqual(body.data.account.activity, {
      tx_count: 3,
      last_tx_block: 490,
      total_fee_tao: 0.01,
      modules_called: [{ call_module: "SubtensorModule", count: 3 }],
    });
  });

  test("account: a malformed Postgres-tier body degrades to a schema-stable zero summary", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      `{ account(ss58: "${SS58}") { ss58 event_count subnet_count event_scan_capped first_block last_block event_kinds { kind } registrations { netuid } recent_events { block_number } activity { tx_count modules_called { call_module } } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.account, {
      ss58: SS58,
      event_count: 0,
      subnet_count: 0,
      event_scan_capped: false,
      first_block: null,
      last_block: null,
      event_kinds: [],
      registrations: [],
      recent_events: [],
      activity: { tx_count: 0, modules_called: [] },
    });
  });

  test("accounts / account are weighted as fan-out fields", () => {
    assert.equal(FIELD_COMPLEXITY.accounts, 5);
    assert.equal(FIELD_COMPLEXITY.account, 5);
  });
});

describe("graphql — account_prometheus (#5703, Postgres-tier { data, generatedAt } + zeroed-card fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function query(argsClause) {
    return `{ account_prometheus${argsClause} {
      schema_version address window total_announcements subnet_count concentration dominant_netuid
      subnets { netuid announcements first_announced_at last_announced_at }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed footprint, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_prometheus, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_announcements: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("resolves the Postgres-tier footprint for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: {
              schema_version: 1,
              address: SS58,
              window: "7d",
              total_announcements: 5,
              subnet_count: 2,
              concentration: 0.68,
              dominant_netuid: 3,
              subnets: [
                {
                  netuid: 3,
                  announcements: 4,
                  first_announced_at: "2026-07-01T00:00:00.000Z",
                  last_announced_at: "2026-07-10T00:00:00.000Z",
                },
                {
                  netuid: 7,
                  announcements: 1,
                  first_announced_at: "2026-07-05T00:00:00.000Z",
                  last_announced_at: "2026-07-05T00:00:00.000Z",
                },
              ],
            },
            generatedAt: "2026-07-10T00:00:00.000Z",
          }),
      },
    };
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", window: "7d")`),
      env,
    );
    assert.equal(status, 200);
    const p = body.data.account_prometheus;
    assert.equal(p.window, "7d");
    assert.equal(p.total_announcements, 5);
    assert.equal(p.subnet_count, 2);
    assert.equal(p.concentration, 0.68);
    assert.equal(p.dominant_netuid, 3);
    assert.equal(p.subnets[0].netuid, 3);
    assert.equal(p.subnets[0].announcements, 4);
    assert.equal(p.subnets[1].netuid, 7);
  });

  test("window is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            data: { schema_version: 1, address: SS58, subnets: [] },
            generatedAt: null,
          });
        },
      },
    };
    await gql(query(`(ss58: "${SS58}", window: "90d")`), env);
    assert.equal(capturedUrl.pathname, `/api/v1/accounts/${SS58}/prometheus`);
    assert.equal(capturedUrl.searchParams.get("window"), "90d");
  });

  test("a Postgres-tier body missing the data envelope degrades to a schema-stable zeroed footprint", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_prometheus, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_announcements: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("a partial data envelope degrades missing fields to their defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => Response.json({ data: {}, generatedAt: null }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_prometheus, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_announcements: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", window: "99d")`),
    );
    assert.equal(status, 200);
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|30d/i.test(body.errors[0].message));
    assert.equal(body.data, null);
  });

  test("account_prometheus is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_prometheus, 5);
  });
});

describe("graphql — account_stake_flow (#5706, Postgres-tier { data, generatedAt } + zeroed-card fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function query(argsClause) {
    return `{ account_stake_flow${argsClause} {
      schema_version address window total_staked_tao total_unstaked_tao
      net_flow_tao gross_flow_tao flow_ratio direction stake_events unstake_events
      subnet_count concentration dominant_netuid
      subnets { netuid staked_tao unstaked_tao net_flow_tao gross_flow_tao flow_ratio direction stake_events unstake_events }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_stake_flow, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_staked_tao: 0,
      total_unstaked_tao: 0,
      net_flow_tao: 0,
      gross_flow_tao: 0,
      flow_ratio: null,
      direction: "idle",
      stake_events: 0,
      unstake_events: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("resolves the Postgres-tier scorecard for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: {
              schema_version: 1,
              address: SS58,
              window: "7d",
              total_staked_tao: 100,
              total_unstaked_tao: 20,
              net_flow_tao: 80,
              gross_flow_tao: 120,
              flow_ratio: 0.6667,
              direction: "accumulating",
              stake_events: 4,
              unstake_events: 1,
              subnet_count: 2,
              concentration: 0.72,
              dominant_netuid: 3,
              subnets: [
                {
                  netuid: 3,
                  staked_tao: 90,
                  unstaked_tao: 10,
                  net_flow_tao: 80,
                  gross_flow_tao: 100,
                  flow_ratio: 0.8,
                  direction: "accumulating",
                  stake_events: 3,
                  unstake_events: 1,
                },
                {
                  netuid: 7,
                  staked_tao: 10,
                  unstaked_tao: 10,
                  net_flow_tao: 0,
                  gross_flow_tao: 20,
                  flow_ratio: 0,
                  direction: "churning",
                  stake_events: 1,
                  unstake_events: 0,
                },
              ],
            },
            generatedAt: "2026-07-10T00:00:00.000Z",
          }),
      },
    };
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", window: "7d")`),
      env,
    );
    assert.equal(status, 200);
    const f = body.data.account_stake_flow;
    assert.equal(f.window, "7d");
    assert.equal(f.total_staked_tao, 100);
    assert.equal(f.net_flow_tao, 80);
    assert.equal(f.direction, "accumulating");
    assert.equal(f.subnet_count, 2);
    assert.equal(f.dominant_netuid, 3);
    assert.equal(f.subnets[0].netuid, 3);
    assert.equal(f.subnets[0].flow_ratio, 0.8);
    assert.equal(f.subnets[1].direction, "churning");
  });

  test("window and direction are forwarded as query params to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            data: { schema_version: 1, address: SS58, subnets: [] },
            generatedAt: null,
          });
        },
      },
    };
    await gql(query(`(ss58: "${SS58}", window: "90d", direction: "in")`), env);
    assert.equal(capturedUrl.pathname, `/api/v1/accounts/${SS58}/stake-flow`);
    assert.equal(capturedUrl.searchParams.get("window"), "90d");
    assert.equal(capturedUrl.searchParams.get("direction"), "in");
  });

  test("a Postgres-tier body missing the data envelope degrades to a schema-stable zeroed card", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_stake_flow, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_staked_tao: 0,
      total_unstaked_tao: 0,
      net_flow_tao: 0,
      gross_flow_tao: 0,
      flow_ratio: null,
      direction: "idle",
      stake_events: 0,
      unstake_events: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("a partial data envelope degrades missing fields to their defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => Response.json({ data: {}, generatedAt: null }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_stake_flow, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_staked_tao: 0,
      total_unstaked_tao: 0,
      net_flow_tao: 0,
      gross_flow_tao: 0,
      flow_ratio: null,
      direction: "idle",
      stake_events: 0,
      unstake_events: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", window: "99d")`),
    );
    assert.equal(status, 200);
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|30d/i.test(body.errors[0].message));
    assert.equal(body.data, null);
  });

  test("an unsupported direction is a GraphQL error, not a silent card", async () => {
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", direction: "sideways")`),
    );
    assert.equal(status, 200);
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/direction/i.test(body.errors[0].message));
    assert.equal(body.data, null);
  });

  test("account_stake_flow is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_stake_flow, 5);
  });
});

describe("graphql — account_portfolio (#5702, Postgres-tier flat body + zeroed-card fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function query(argsClause) {
    return `{ account_portfolio${argsClause} {
      schema_version ss58 captured_at subnet_count position_count validator_count
      miner_count total_stake_tao total_emission_tao overall_yield
      stake_concentration { holders gini hhi }
      positions { netuid uid role active stake_tao emission_tao rank trust incentive dividends yield }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable empty card, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_portfolio, {
      schema_version: 1,
      ss58: SS58,
      captured_at: null,
      subnet_count: 0,
      position_count: 0,
      validator_count: 0,
      miner_count: 0,
      total_stake_tao: 0,
      total_emission_tao: 0,
      overall_yield: null,
      stake_concentration: null,
      positions: [],
    });
  });

  test("resolves the Postgres-tier portfolio (flat body, unlike the account-event footprint family)", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            ss58: SS58,
            captured_at: "2026-07-10T00:00:00.000Z",
            subnet_count: 2,
            position_count: 2,
            validator_count: 1,
            miner_count: 1,
            total_stake_tao: 1500,
            total_emission_tao: 6,
            overall_yield: 0.004,
            stake_concentration: { holders: 2, gini: 0.2, hhi: 0.52 },
            positions: [
              {
                netuid: 3,
                uid: 5,
                role: "validator",
                active: true,
                stake_tao: 1000,
                emission_tao: 4,
                rank: 0.8,
                trust: 0.9,
                incentive: 0.1,
                dividends: 0.05,
                yield: 0.004,
              },
              {
                netuid: 7,
                uid: 9,
                role: "miner",
                active: true,
                stake_tao: 500,
                emission_tao: 2,
                rank: 0.5,
                trust: 0.5,
                incentive: 0.2,
                dividends: 0,
                yield: 0.004,
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    const p = body.data.account_portfolio;
    assert.equal(p.subnet_count, 2);
    assert.equal(p.total_stake_tao, 1500);
    assert.equal(p.stake_concentration.holders, 2);
    assert.equal(p.positions[0].netuid, 3);
    assert.equal(p.positions[0].role, "validator");
    assert.equal(p.positions[1].role, "miner");
  });

  test("ss58 is forwarded on the Postgres-tier request path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            ss58: SS58,
            positions: [],
          });
        },
      },
    };
    await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(capturedUrl.pathname, `/api/v1/accounts/${SS58}/portfolio`);
  });

  test("a malformed Postgres-tier body degrades to a schema-stable empty card", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_portfolio, {
      schema_version: 1,
      ss58: SS58,
      captured_at: null,
      subnet_count: 0,
      position_count: 0,
      validator_count: 0,
      miner_count: 0,
      total_stake_tao: 0,
      total_emission_tao: 0,
      overall_yield: null,
      stake_concentration: null,
      positions: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("account_portfolio is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_portfolio, 5);
  });
});

describe("graphql — account_positions (#6324, Postgres-tier flat body + empty-card fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function query(argsClause) {
    return `{ account_positions${argsClause} {
      schema_version ss58 captured_at position_count total_stake_tao
      positions { hotkey netuid share_fraction stake_tao }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable empty card, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_positions, {
      schema_version: 1,
      ss58: SS58,
      captured_at: null,
      position_count: 0,
      total_stake_tao: 0,
      positions: [],
    });
  });

  test("resolves the Postgres-tier positions (flat body, matches GET /api/v1/accounts/{ss58}/positions parity)", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            ss58: SS58,
            captured_at: "2026-07-10T00:00:00.000Z",
            position_count: 2,
            total_stake_tao: 1500,
            positions: [
              {
                hotkey: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
                netuid: 3,
                share_fraction: 0.5,
                stake_tao: 1000,
              },
              {
                hotkey: "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy",
                netuid: 7,
                share_fraction: 0.25,
                stake_tao: 500,
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    const p = body.data.account_positions;
    assert.equal(p.position_count, 2);
    assert.equal(p.total_stake_tao, 1500);
    assert.equal(p.positions[0].netuid, 3);
    assert.equal(p.positions[0].share_fraction, 0.5);
    assert.equal(
      p.positions[1].hotkey,
      "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy",
    );
  });

  test("ss58 is forwarded on the Postgres-tier request path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            ss58: SS58,
            positions: [],
          });
        },
      },
    };
    await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(capturedUrl.pathname, `/api/v1/accounts/${SS58}/positions`);
  });

  test("a malformed Postgres-tier body degrades to a schema-stable empty card", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_positions, {
      schema_version: 1,
      ss58: SS58,
      captured_at: null,
      position_count: 0,
      total_stake_tao: 0,
      positions: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("account_positions is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_positions, 5);
  });
});

describe("graphql — account_subnets (#5894, Postgres-tier flat body + empty-card fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function query(argsClause) {
    return `{ account_subnets${argsClause} {
      schema_version ss58 subnet_count
      subnets { netuid uid stake_tao validator_permit active }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable empty footprint, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_subnets, {
      schema_version: 1,
      ss58: SS58,
      subnet_count: 0,
      subnets: [],
    });
  });

  test("resolves the Postgres-tier footprint (flat body, unlike the account-event footprint family)", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            ss58: SS58,
            subnet_count: 2,
            subnets: [
              {
                netuid: 3,
                uid: 5,
                stake_tao: 1000,
                validator_permit: true,
                active: true,
              },
              {
                netuid: 7,
                uid: 9,
                stake_tao: 500,
                validator_permit: false,
                active: false,
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    const s = body.data.account_subnets;
    assert.equal(s.subnet_count, 2);
    assert.equal(s.subnets[0].netuid, 3);
    assert.equal(s.subnets[0].validator_permit, true);
    assert.equal(s.subnets[0].active, true);
    assert.equal(s.subnets[1].netuid, 7);
    assert.equal(s.subnets[1].validator_permit, false);
    assert.equal(s.subnets[1].active, false);
  });

  test("ss58 is forwarded on the Postgres-tier request path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            ss58: SS58,
            subnet_count: 0,
            subnets: [],
          });
        },
      },
    };
    await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(capturedUrl.pathname, `/api/v1/accounts/${SS58}/subnets`);
  });

  test("a malformed Postgres-tier body degrades to a schema-stable empty footprint", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_subnets, {
      schema_version: 1,
      ss58: SS58,
      subnet_count: 0,
      subnets: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("account_subnets is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_subnets, 5);
  });
});

describe("graphql — account_extrinsics (#5891, Postgres-tier feed + empty-page fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function query(argsClause) {
    return `{ account_extrinsics${argsClause} {
      schema_version ss58 extrinsic_count limit offset next_cursor
      extrinsics { block_number extrinsic_index call_module call_function call_args success fee_tao }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable empty page, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_extrinsics, {
      schema_version: 1,
      ss58: SS58,
      extrinsic_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      extrinsics: [],
    });
  });

  test("resolves the Postgres-tier feed, JSON-encoding call_args to the String field", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            ss58: SS58,
            extrinsic_count: 1,
            limit: 100,
            offset: 0,
            next_cursor: "cursor-1",
            extrinsics: [
              {
                block_number: 5,
                extrinsic_index: 0,
                extrinsic_hash: `0x${"a".repeat(64)}`,
                signer: SS58,
                call_module: "SubtensorModule",
                call_function: "register",
                call_args: [{ name: "netuid", value: 1 }],
                success: true,
                fee_tao: 0.001,
                tip_tao: 0,
                observed_at: "2026-07-14T00:00:00.000Z",
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    const s = body.data.account_extrinsics;
    assert.equal(s.extrinsic_count, 1);
    assert.equal(s.next_cursor, "cursor-1");
    const item = s.extrinsics[0];
    assert.equal(item.block_number, 5);
    assert.equal(item.call_module, "SubtensorModule");
    assert.equal(item.call_function, "register");
    assert.equal(item.success, true);
    assert.equal(
      item.call_args,
      JSON.stringify([{ name: "netuid", value: 1 }]),
    );
  });

  test("ss58 + pagination/block-range args are forwarded on the Postgres-tier request path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            ss58: SS58,
            extrinsic_count: 0,
            limit: 5,
            offset: 10,
            next_cursor: null,
            extrinsics: [],
          });
        },
      },
    };
    await gql(
      query(
        `(ss58: "${SS58}", limit: 5, offset: 10, cursor: "abc123", block_start: 100, block_end: 200)`,
      ),
      env,
    );
    assert.equal(capturedUrl.pathname, `/api/v1/accounts/${SS58}/extrinsics`);
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(capturedUrl.searchParams.get("offset"), "10");
    assert.equal(capturedUrl.searchParams.get("cursor"), "abc123");
    assert.equal(capturedUrl.searchParams.get("block_start"), "100");
    assert.equal(capturedUrl.searchParams.get("block_end"), "200");
  });

  test("a malformed Postgres-tier body degrades to a schema-stable empty page", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_extrinsics, {
      schema_version: 1,
      ss58: SS58,
      extrinsic_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      extrinsics: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("account_extrinsics is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_extrinsics, 5);
  });
});

// --- Subscription.chainEvents (#4983, ADR 0015) ---------------------------------
//
// The DO-runtime side of this wiring (ChainFirehoseHub.subscribeChainEvents,
// the graphql-ws WS transport) is covered in tests/chain-firehose-hub.test.mjs.
// These tests exercise the OTHER half: that the schema's chainEvents field is
// wired to a real subscribe() resolver that correctly bridges
// context.chainFirehose's repeater into graphql-js's own subscribe() engine
// -- using graphql-js's real subscribe() function (not a hand-rolled
// simulation) against a minimal fake hub, exactly the shape
// ChainFirehoseHub actually provides via context.
function fakeChainFirehose(pushAfterSubscribe) {
  const subscriptions = [];
  return {
    subscribeChainEvents(topics) {
      const pending = [];
      let waitingResolve = null;
      const repeater = {
        push(value) {
          if (waitingResolve) {
            const resolve = waitingResolve;
            waitingResolve = null;
            resolve({ value, done: false });
          } else {
            pending.push(value);
          }
        },
        [Symbol.asyncIterator]() {
          return {
            next: () =>
              pending.length
                ? Promise.resolve({ value: pending.shift(), done: false })
                : new Promise((resolve) => {
                    waitingResolve = resolve;
                  }),
          };
        },
      };
      subscriptions.push({ repeater, topics });
      if (pushAfterSubscribe) pushAfterSubscribe(repeater);
      return repeater;
    },
    unsubscribeChainEvents(repeater) {
      const index = subscriptions.findIndex((s) => s.repeater === repeater);
      if (index !== -1) subscriptions.splice(index, 1);
    },
    subscriptions,
  };
}

async function subscribeChainEvents(query, hub, clientIp) {
  const document = parse(query);
  return subscribe({
    schema: chainEventsSchema,
    document,
    contextValue: { [GRAPHQL_SUBSCRIPTION_CONTEXT_KEY]: hub, clientIp },
  });
}

// graphql-js's execution results are null-prototype objects internally
// (Object.create(null)) -- deepStrictEqual against a plain object literal
// fails on prototype alone even with identical content. Round-tripping
// through JSON is also a MORE faithful comparison than a raw deep-equal:
// real clients only ever see this result after it's been JSON-serialized
// for the wire, same as every other transport in this repo.
function asPlainJson(value) {
  return JSON.parse(JSON.stringify(value));
}

describe("graphql — blocks_summary (#5664, Postgres-tier + retired-D1 fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable empty summary, never null", async () => {
    const { status, body } = await gql(
      `{ blocks_summary {
          schema_version block_count first_block last_block
          first_observed_at last_observed_at
          block_time { count } throughput { total_extrinsics }
          distinct_authors author_concentration { gini }
          distinct_spec_versions latest_spec_version
        } }`,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.blocks_summary, {
      schema_version: 1,
      block_count: 0,
      first_block: null,
      last_block: null,
      first_observed_at: null,
      last_observed_at: null,
      block_time: null,
      throughput: null,
      distinct_authors: 0,
      author_concentration: null,
      distinct_spec_versions: 0,
      latest_spec_version: null,
    });
  });

  test("resolves the Postgres-tier summary, including nested time/throughput/concentration", async () => {
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          block_count: 3,
          first_block: 100,
          last_block: 102,
          first_observed_at: "2026-07-01T00:00:00.000Z",
          last_observed_at: "2026-07-01T00:00:24.000Z",
          block_time: {
            count: 2,
            mean_ms: 12000,
            min_ms: 11800,
            max_ms: 12200,
            p50_ms: 12000,
            p90_ms: 12200,
          },
          throughput: {
            total_extrinsics: 30,
            total_events: 90,
            mean_extrinsics_per_block: 10,
            mean_events_per_block: 30,
            max_extrinsics_in_block: 12,
          },
          distinct_authors: 2,
          author_concentration: {
            holders: 2,
            total: 3,
            gini: 0.17,
            hhi: 0.56,
            hhi_normalized: 0.11,
            nakamoto_coefficient: 1,
            top_1pct_share: 0.67,
            top_5pct_share: 0.67,
            top_10pct_share: 0.67,
            top_20pct_share: 0.67,
            entropy: 0.92,
            entropy_normalized: 0.92,
          },
          distinct_spec_versions: 1,
          latest_spec_version: 199,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ blocks_summary {
          block_count first_block last_block latest_spec_version distinct_authors
          block_time { count mean_ms p50_ms p90_ms }
          throughput { total_extrinsics mean_extrinsics_per_block max_extrinsics_in_block }
          author_concentration { gini nakamoto_coefficient top_1pct_share entropy_normalized }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const s = body.data.blocks_summary;
    assert.equal(s.block_count, 3);
    assert.equal(s.first_block, 100);
    assert.equal(s.last_block, 102);
    assert.equal(s.latest_spec_version, 199);
    assert.equal(s.distinct_authors, 2);
    assert.equal(s.block_time.count, 2);
    assert.equal(s.block_time.mean_ms, 12000);
    assert.equal(s.block_time.p90_ms, 12200);
    assert.equal(s.throughput.total_extrinsics, 30);
    assert.equal(s.throughput.max_extrinsics_in_block, 12);
    assert.equal(s.author_concentration.gini, 0.17);
    assert.equal(s.author_concentration.nakamoto_coefficient, 1);
    assert.equal(s.author_concentration.top_1pct_share, 0.67);
  });

  test("forwards to /api/v1/blocks/summary with no query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({ schema_version: 1, block_count: 0 });
        },
      },
    };
    await gql("{ blocks_summary { block_count } }", env);
    assert.equal(capturedUrl.pathname, "/api/v1/blocks/summary");
    assert.equal(capturedUrl.search, "");
  });

  test("a partial Postgres-tier body degrades to the schema-stable defaults, never null", async () => {
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      // Every field absent -- the resolver's own ?? defaults must fill them in.
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ blocks_summary {
          schema_version block_count distinct_authors distinct_spec_versions
          first_block last_block block_time { count } throughput { total_extrinsics }
          author_concentration { gini } latest_spec_version
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.blocks_summary, {
      schema_version: 1,
      block_count: 0,
      distinct_authors: 0,
      distinct_spec_versions: 0,
      first_block: null,
      last_block: null,
      block_time: null,
      throughput: null,
      author_concentration: null,
      latest_spec_version: null,
    });
  });
});

describe("graphql — runtime (#5898, Postgres-tier spec-version timeline + retired-D1 fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable empty timeline, never null", async () => {
    const { status, body } = await gql(
      `{ runtime {
          schema_version transition_count current_spec_version
          coverage_from_block coverage_from_at
          transitions { spec_version block_number observed_at }
        } }`,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.runtime, {
      schema_version: 1,
      transition_count: 0,
      current_spec_version: null,
      coverage_from_block: null,
      coverage_from_at: null,
      transitions: [],
    });
  });

  test("resolves the Postgres-tier spec-version transition timeline", async () => {
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          transitions: [
            {
              spec_version: 200,
              block_number: 100,
              observed_at: "2026-06-25T00:00:00.000Z",
            },
            {
              spec_version: 201,
              block_number: 500,
              observed_at: "2026-07-01T00:00:00.000Z",
            },
          ],
          transition_count: 2,
          current_spec_version: 201,
          coverage_from_block: 100,
          coverage_from_at: "2026-06-25T00:00:00.000Z",
        }),
      ),
    };
    const { status, body } = await gql(
      `{ runtime {
          schema_version transition_count current_spec_version
          coverage_from_block coverage_from_at
          transitions { spec_version block_number observed_at }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.runtime, {
      schema_version: 1,
      transition_count: 2,
      current_spec_version: 201,
      coverage_from_block: 100,
      coverage_from_at: "2026-06-25T00:00:00.000Z",
      transitions: [
        {
          spec_version: 200,
          block_number: 100,
          observed_at: "2026-06-25T00:00:00.000Z",
        },
        {
          spec_version: 201,
          block_number: 500,
          observed_at: "2026-07-01T00:00:00.000Z",
        },
      ],
    });
  });

  test("forwards to /api/v1/runtime with no query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({ schema_version: 1, transition_count: 0 });
        },
      },
    };
    await gql("{ runtime { transition_count } }", env);
    assert.equal(capturedUrl.pathname, "/api/v1/runtime");
    assert.equal(capturedUrl.search, "");
  });

  test("a partial Postgres-tier body degrades to the schema-stable defaults, never null", async () => {
    const env = {
      METAGRAPH_BLOCKS_SOURCE: "postgres",
      // Every field absent -- the resolver's own ?? / || defaults must fill them in.
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ runtime {
          schema_version transition_count current_spec_version
          coverage_from_block coverage_from_at transitions { spec_version }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.runtime, {
      schema_version: 1,
      transition_count: 0,
      current_spec_version: null,
      coverage_from_block: null,
      coverage_from_at: null,
      transitions: [],
    });
  });
});

describe("graphql — incidents (#5660, Postgres-tier + retired-D1 fallback ledger)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }
  // Minimal D1 stub: every query returns no rows, so loadGlobalIncidentsLedger's
  // fallback path runs to a schema-stable empty ledger without a live DB.
  const emptyHealthDb = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
  };

  test("cold store: no Postgres flag falls back to the D1 ledger, schema-stable empty, never null", async () => {
    const { status, body } = await gql(
      "{ incidents { schema_version window surfaces { id } } }",
      { METAGRAPH_HEALTH_DB: emptyHealthDb },
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.incidents.schema_version, 1);
    assert.equal(body.data.incidents.window, "7d");
    assert.deepEqual(body.data.incidents.surfaces, []);
  });

  test("resolves the Postgres-tier ledger, including the JSON summary and typed surfaces", async () => {
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          window: "30d",
          observed_at: "2026-07-01T00:00:00.000Z",
          source: "postgres",
          summary: {
            incident_count: 2,
            active_count: 1,
            by_status: { down: 1, warn: 1 },
            by_severity: { high: 1, medium: 1 },
            by_kind: {},
            by_layer: {},
            by_provider: { acme: 2 },
          },
          surfaces: [
            {
              id: "inc-1",
              endpoint_id: "ep-1",
              state: "down",
              severity: "high",
              status: "down",
              reason: "probe timeout",
              netuid: 5,
              provider: "acme",
              health_stale: false,
              pool_eligible: true,
              user_reported: false,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ incidents(window: "30d") {
          schema_version window observed_at source
          summary
          surfaces { id endpoint_id state severity status reason netuid provider health_stale pool_eligible user_reported }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const inc = body.data.incidents;
    assert.equal(inc.window, "30d");
    assert.equal(inc.observed_at, "2026-07-01T00:00:00.000Z");
    // JSON scalar passes the dynamic-keyed summary through as-is.
    assert.equal(inc.summary.incident_count, 2);
    assert.equal(inc.summary.active_count, 1);
    assert.deepEqual(inc.summary.by_status, { down: 1, warn: 1 });
    assert.deepEqual(inc.summary.by_provider, { acme: 2 });
    assert.equal(inc.surfaces.length, 1);
    assert.equal(inc.surfaces[0].id, "inc-1");
    assert.equal(inc.surfaces[0].state, "down");
    assert.equal(inc.surfaces[0].netuid, 5);
    assert.equal(inc.surfaces[0].pool_eligible, true);
  });

  test("a partial Postgres-tier body degrades to the schema-stable defaults", async () => {
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      '{ incidents(window: "30d") { schema_version window observed_at source summary surfaces { id } } }',
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.incidents, {
      schema_version: 1,
      window: "30d",
      observed_at: null,
      source: null,
      summary: null,
      surfaces: [],
    });
  });

  test("an unsupported window is a GraphQL error, not a silent empty ledger", async () => {
    const { body } = await gql(
      '{ incidents(window: "99d") { schema_version } }',
      {
        METAGRAPH_HEALTH_DB: emptyHealthDb,
      },
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|7d/i.test(body.errors[0].message));
    assert.equal(body.data?.incidents ?? null, null);
  });
});

describe("graphql — subnet_registrations (#5720, Postgres-tier + zeroed-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_registrations(netuid: 5) {
          schema_version netuid window observed_at
          distinct_registrants registrations registrations_per_registrant
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_registrations, {
      schema_version: 1,
      netuid: 5,
      window: "7d",
      observed_at: null,
      distinct_registrants: 0,
      registrations: 0,
      registrations_per_registrant: null,
    });
  });

  test("resolves the Postgres-tier card for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          window: "30d",
          observed_at: "2026-07-01T00:00:00.000Z",
          distinct_registrants: 3,
          registrations: 7,
          registrations_per_registrant: 2.33,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_registrations(netuid: 5, window: "30d") {
          netuid window observed_at distinct_registrants registrations registrations_per_registrant
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.subnet_registrations;
    assert.equal(r.window, "30d");
    assert.equal(r.observed_at, "2026-07-01T00:00:00.000Z");
    assert.equal(r.distinct_registrants, 3);
    assert.equal(r.registrations, 7);
    assert.equal(r.registrations_per_registrant, 2.33);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_registrations(netuid: 9, window: "30d") {
          schema_version netuid window observed_at distinct_registrants registrations registrations_per_registrant
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_registrations, {
      schema_version: 1,
      netuid: 9,
      window: "30d",
      observed_at: null,
      distinct_registrants: 0,
      registrations: 0,
      registrations_per_registrant: null,
    });
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ subnet_registrations(netuid: 5, window: "99d") { registrations } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|7d/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_registrations ?? null, null);
  });
});

describe("graphql — subnet_performance (#5714, Postgres-tier + zeroed-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_performance(netuid: 5) {
          schema_version netuid neuron_count validator_count active_count captured_at
          incentive { holders gini } dividends { holders }
          trust { count } consensus { count } validator_trust { count }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_performance, {
      schema_version: 1,
      netuid: 5,
      neuron_count: 0,
      validator_count: 0,
      active_count: 0,
      captured_at: null,
      incentive: null,
      dividends: null,
      trust: null,
      consensus: null,
      validator_trust: null,
    });
  });

  test("resolves the Postgres-tier reward + score blocks", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          neuron_count: 4,
          validator_count: 2,
          active_count: 3,
          captured_at: "2026-07-01T00:00:00.000Z",
          incentive: {
            holders: 3,
            total: 1,
            gini: 0.4,
            hhi: 0.5,
            hhi_normalized: 0.25,
            nakamoto_coefficient: 1,
            top_1pct_share: 0.6,
            top_5pct_share: 0.6,
            top_10pct_share: 0.6,
            top_20pct_share: 0.9,
            entropy: 1.4,
            entropy_normalized: 0.8,
          },
          dividends: {
            holders: 2,
            total: 0.6,
            gini: 0.2,
            hhi: 0.7,
            hhi_normalized: 0.4,
            nakamoto_coefficient: 1,
            top_1pct_share: 0.83,
            top_5pct_share: 0.83,
            top_10pct_share: 0.83,
            top_20pct_share: 1,
            entropy: 0.9,
            entropy_normalized: 0.9,
          },
          trust: {
            count: 4,
            mean: 0.7,
            min: 0.4,
            max: 0.9,
            p10: 0.4,
            p25: 0.5,
            p50: 0.75,
            p75: 0.85,
            p90: 0.9,
          },
          consensus: {
            count: 4,
            mean: 0.6,
            min: 0.3,
            max: 0.8,
            p10: 0.3,
            p25: 0.4,
            p50: 0.65,
            p75: 0.75,
            p90: 0.8,
          },
          validator_trust: {
            count: 2,
            mean: 0.9,
            min: 0.85,
            max: 0.95,
            p10: 0.85,
            p25: 0.85,
            p50: 0.95,
            p75: 0.95,
            p90: 0.95,
          },
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_performance(netuid: 7) {
          netuid neuron_count validator_count active_count captured_at
          incentive { holders gini nakamoto_coefficient top_10pct_share }
          dividends { holders total }
          trust { count mean max }
          validator_trust { count min max }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const p = body.data.subnet_performance;
    assert.equal(p.netuid, 7);
    assert.equal(p.neuron_count, 4);
    assert.equal(p.validator_count, 2);
    assert.equal(p.active_count, 3);
    assert.equal(p.captured_at, "2026-07-01T00:00:00.000Z");
    assert.equal(p.incentive.holders, 3);
    assert.equal(p.incentive.nakamoto_coefficient, 1);
    assert.equal(p.dividends.holders, 2);
    assert.equal(p.dividends.total, 0.6);
    assert.equal(p.trust.count, 4);
    assert.equal(p.trust.max, 0.9);
    assert.equal(p.validator_trust.count, 2);
    assert.equal(p.validator_trust.min, 0.85);
  });

  test("forwards the performance path to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql("{ subnet_performance(netuid: 3) { neuron_count } }", env);
    assert.ok(capturedUrl.pathname.endsWith("/subnets/3/performance"));
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_performance(netuid: 9) {
          schema_version netuid neuron_count validator_count active_count
          incentive { holders } trust { count }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_performance, {
      schema_version: 1,
      netuid: 9,
      neuron_count: 0,
      validator_count: 0,
      active_count: 0,
      incentive: null,
      trust: null,
    });
  });

  test("a negative netuid is a GraphQL error, not an empty card", async () => {
    const { body } = await gql(
      "{ subnet_performance(netuid: -1) { neuron_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_performance ?? null, null);
  });

  test("subnet_performance is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_performance, 5);
  });
});

describe("graphql — subnet_concentration (#5901, Postgres-tier + zeroed-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_concentration(netuid: 5) {
          schema_version netuid neuron_count entity_count uids_per_entity captured_at
          stake { holders gini } emission { holders }
          entity_stake { holders } entity_emission { holders } validator_stake { holders }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_concentration, {
      schema_version: 1,
      netuid: 5,
      neuron_count: 0,
      entity_count: 0,
      uids_per_entity: null,
      captured_at: null,
      stake: null,
      emission: null,
      entity_stake: null,
      entity_emission: null,
      validator_stake: null,
    });
  });

  test("resolves the Postgres-tier stake + emission concentration blocks", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          neuron_count: 4,
          entity_count: 3,
          uids_per_entity: 1.3333,
          captured_at: "2026-07-01T00:00:00.000Z",
          stake: {
            holders: 4,
            total: 1000,
            gini: 0.4,
            hhi: 0.5,
            hhi_normalized: 0.25,
            nakamoto_coefficient: 1,
            top_1pct_share: 0.6,
            top_5pct_share: 0.6,
            top_10pct_share: 0.6,
            top_20pct_share: 0.9,
            entropy: 1.4,
            entropy_normalized: 0.8,
          },
          emission: {
            holders: 3,
            total: 12.5,
            gini: 0.2,
            hhi: 0.7,
            hhi_normalized: 0.4,
            nakamoto_coefficient: 1,
            top_1pct_share: 0.83,
            top_5pct_share: 0.83,
            top_10pct_share: 0.83,
            top_20pct_share: 1,
            entropy: 0.9,
            entropy_normalized: 0.9,
          },
          validator_stake: {
            holders: 2,
            total: 800,
            gini: 0.1,
            hhi: 0.55,
            hhi_normalized: 0.1,
            nakamoto_coefficient: 1,
            top_1pct_share: 0.7,
            top_5pct_share: 0.7,
            top_10pct_share: 0.7,
            top_20pct_share: 1,
            entropy: 0.8,
            entropy_normalized: 0.8,
          },
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_concentration(netuid: 7) {
          netuid neuron_count entity_count uids_per_entity captured_at
          stake { holders gini nakamoto_coefficient top_10pct_share }
          emission { holders total }
          validator_stake { holders gini }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const c = body.data.subnet_concentration;
    assert.equal(c.netuid, 7);
    assert.equal(c.neuron_count, 4);
    assert.equal(c.entity_count, 3);
    assert.equal(c.uids_per_entity, 1.3333);
    assert.equal(c.captured_at, "2026-07-01T00:00:00.000Z");
    assert.equal(c.stake.holders, 4);
    assert.equal(c.stake.nakamoto_coefficient, 1);
    assert.equal(c.stake.top_10pct_share, 0.6);
    assert.equal(c.emission.holders, 3);
    assert.equal(c.emission.total, 12.5);
    assert.equal(c.validator_stake.holders, 2);
    assert.equal(c.validator_stake.gini, 0.1);
  });

  test("forwards the concentration path to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql("{ subnet_concentration(netuid: 3) { neuron_count } }", env);
    assert.ok(capturedUrl.pathname.endsWith("/subnets/3/concentration"));
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_concentration(netuid: 9) {
          schema_version netuid neuron_count entity_count uids_per_entity
          stake { holders } validator_stake { holders }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_concentration, {
      schema_version: 1,
      netuid: 9,
      neuron_count: 0,
      entity_count: 0,
      uids_per_entity: null,
      stake: null,
      validator_stake: null,
    });
  });

  test("a negative netuid is a GraphQL error, not an empty card", async () => {
    const { body } = await gql(
      "{ subnet_concentration(netuid: -1) { neuron_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_concentration ?? null, null);
  });

  test("subnet_concentration is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_concentration, 5);
  });
});

describe("graphql — subnet_concentration_history (#5901, neuron_daily trend + window validation)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable empty series, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_concentration_history(netuid: 5) {
          schema_version netuid window point_count points { snapshot_date stake_gini }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_concentration_history, {
      schema_version: 1,
      netuid: 5,
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("resolves the Postgres-tier per-day trend points", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          window: "7d",
          point_count: 2,
          points: [
            {
              snapshot_date: "2026-07-02",
              neuron_count: 4,
              stake_gini: 0.42,
              stake_nakamoto_coefficient: 2,
              stake_top_10pct_share: 0.55,
              emission_gini: 0.3,
              emission_nakamoto_coefficient: 1,
              emission_top_10pct_share: 0.7,
            },
            {
              snapshot_date: "2026-07-01",
              neuron_count: 3,
              stake_gini: 0.4,
              stake_nakamoto_coefficient: 2,
              stake_top_10pct_share: 0.5,
              emission_gini: 0.28,
              emission_nakamoto_coefficient: 1,
              emission_top_10pct_share: 0.68,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_concentration_history(netuid: 7, window: "7d") {
          netuid window point_count
          points { snapshot_date neuron_count stake_gini stake_nakamoto_coefficient emission_top_10pct_share }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const h = body.data.subnet_concentration_history;
    assert.equal(h.netuid, 7);
    assert.equal(h.window, "7d");
    assert.equal(h.point_count, 2);
    assert.equal(h.points.length, 2);
    assert.equal(h.points[0].snapshot_date, "2026-07-02");
    assert.equal(h.points[0].stake_gini, 0.42);
    assert.equal(h.points[0].stake_nakamoto_coefficient, 2);
    assert.equal(h.points[1].emission_top_10pct_share, 0.68);
  });

  test("forwards the window to the concentration/history Postgres path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      '{ subnet_concentration_history(netuid: 3, window: "90d") { point_count } }',
      env,
    );
    assert.ok(
      capturedUrl.pathname.endsWith("/subnets/3/concentration/history"),
    );
    assert.equal(capturedUrl.searchParams.get("window"), "90d");
  });

  test("an unsupported window is a GraphQL error, not a silent series", async () => {
    const { body } = await gql(
      '{ subnet_concentration_history(netuid: 5, window: "5d") { point_count } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_concentration_history ?? null, null);
  });

  test("a negative netuid is a GraphQL error, not an empty series", async () => {
    const { body } = await gql(
      "{ subnet_concentration_history(netuid: -1) { point_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_concentration_history ?? null, null);
  });

  test("subnet_concentration_history is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_concentration_history, 5);
  });
});

describe("graphql — discovery parity (#6989, search/domains/compare_validators)", () => {
  const HOTKEY_A = "5FnPunMdSFTr8swMhMTdSGFqiZAJTBEDaAgTmrKfSpvRQyaR";
  const HOTKEY_B = "5CXRfP2ZfvGCe8EQoZnjuBVUkado1RyfHf1zPTMhVpvSJHnp";

  test("search pages the baked full index", async () => {
    const env = fixtureEnv({
      "/metagraph/search.json": {
        documents: [
          { id: "subnet:1", type: "subnet", title: "Alpha", tokens: "a b" },
          { id: "subnet:2", type: "subnet", title: "Beta", tokens: "c d" },
        ],
      },
    });
    const { status, body } = await gql(
      "{ search(limit: 1) { documents total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const s = body.data.search;
    assert.equal(s.total, 2);
    assert.equal(s.documents.length, 1);
    assert.equal(s.documents[0].id, "subnet:1");
    // The full index keeps the per-document token blob.
    assert.equal(s.documents[0].tokens, "a b");
    assert.ok(s.next_cursor);
  });

  test("search_index serves the slim artifact (documents without tokens)", async () => {
    const env = fixtureEnv({
      "/metagraph/search-index.json": {
        documents: [
          { id: "subnet:1", type: "subnet", title: "Alpha" },
          { id: "subnet:2", type: "subnet", title: "Beta" },
        ],
      },
    });
    const { status, body } = await gql(
      "{ search_index(limit: 1) { documents total next_cursor } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.search_index.total, 2);
    assert.equal(body.data.search_index.documents.length, 1);
    // The slim index drops the per-document token blob the full index keeps.
    assert.equal(body.data.search_index.documents[0].tokens, undefined);
    assert.ok(body.data.search_index.next_cursor);
  });

  test("search degrades to an empty page on a cold artifact", async () => {
    const { status, body } = await gql("{ search { documents total } }");
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.search, { documents: [], total: 0 });
  });

  test("domains rolls up every tag in the fixed taxonomy", async () => {
    const env = fixtureEnv({
      "/metagraph/subnets.json": {
        subnets: [{ netuid: 1, name: "A", categories: ["agents"] }],
      },
      "/metagraph/economics.json": {
        subnets: [{ netuid: 1, total_stake_tao: 100, emission_share: 0.5 }],
      },
    });
    const { status, body } = await gql(
      "{ domains { schema_version domain_count domains { domain subnet_count netuids total_stake_tao } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const d = body.data.domains;
    assert.equal(d.schema_version, 1);
    assert.equal(d.domain_count, 14);
    assert.equal(d.domains.length, 14);
    const agents = d.domains.find((row) => row.domain === "agents");
    assert.ok(agents, "expected an agents rollup");
  });

  test("domain_summary rolls up one tag", async () => {
    const { status, body } = await gql(
      '{ domain_summary(tag: "agents") { schema_version domain subnet_count netuids total_stake_tao total_emission_share emission_concentration } }',
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const s = body.data.domain_summary;
    assert.equal(s.domain, "agents");
    assert.equal(s.subnet_count, 0);
    assert.deepEqual(s.netuids, []);
    assert.equal(s.emission_concentration, null);
  });

  test("domain_summary rejects a tag outside the fixed taxonomy", async () => {
    const { body } = await gql(
      '{ domain_summary(tag: "not-a-domain") { domain } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/tag must be one of/i.test(body.errors[0].message));
    assert.equal(body.data?.domain_summary ?? null, null);
  });

  test("compare_validators places validators side by side (cold tier)", async () => {
    const { status, body } = await gql(
      `{ compare_validators(hotkeys: ["${HOTKEY_A}", "${HOTKEY_B}"]) {
          schema_version netuid validator_count
          validators { hotkey total_stake_tao subnet_count subnet_context }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const c = body.data.compare_validators;
    assert.equal(c.netuid, null);
    assert.equal(c.validator_count, 2);
    assert.equal(c.validators[0].hotkey, HOTKEY_A);
    assert.equal(c.validators[1].hotkey, HOTKEY_B);
    assert.equal(c.validators[0].subnet_context, null);
  });

  test("compare_validators fetches each hotkey from the Postgres tier", async () => {
    const paths = [];
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          paths.push(new URL(req.url).pathname);
          return Response.json({
            schema_version: 1,
            hotkey: HOTKEY_A,
            total_stake_tao: 42,
            subnets: [],
          });
        },
      },
    };
    const { status, body } = await gql(
      `{ compare_validators(hotkeys: ["${HOTKEY_A}"], netuid: 3) { netuid validator_count validators { hotkey total_stake_tao } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(paths.length, 1);
    assert.ok(paths[0].endsWith(`/validators/${HOTKEY_A}`));
    assert.equal(body.data.compare_validators.netuid, 3);
    assert.equal(
      body.data.compare_validators.validators[0].total_stake_tao,
      42,
    );
  });

  test("compare_validators rejects a malformed hotkey list", async () => {
    const { body } = await gql(
      '{ compare_validators(hotkeys: ["nope"]) { validator_count } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/hotkeys must be/i.test(body.errors[0].message));
  });

  test("compare_validators rejects an empty hotkey list", async () => {
    const { body } = await gql(
      "{ compare_validators(hotkeys: []) { validator_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/hotkeys must be/i.test(body.errors[0].message));
  });

  test("compare_validators rejects a negative netuid", async () => {
    const { body } = await gql(
      `{ compare_validators(hotkeys: ["${HOTKEY_A}"], netuid: -1) { validator_count } }`,
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
  });

  test("the discovery fields are weighted as fan-out fields", () => {
    assert.equal(FIELD_COMPLEXITY.search, 5);
    assert.equal(FIELD_COMPLEXITY.search_index, 5);
    assert.equal(FIELD_COMPLEXITY.domains, 5);
    assert.equal(FIELD_COMPLEXITY.domain_summary, 5);
    assert.equal(FIELD_COMPLEXITY.compare_validators, 5);
  });
});

describe("graphql — agent_resources (#6987, baked AI-resources index)", () => {
  test("resolves the baked AI-resources index", async () => {
    const env = fixtureEnv({
      "/metagraph/agent-resources.json": {
        schema_version: 1,
        agent: { url: "https://metagraph.sh/agent.md" },
        mcp: { server: "https://api.metagraph.sh/mcp", tool_count: 197 },
      },
    });
    const { status, body } = await gql("{ agent_resources }", env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.agent_resources.schema_version, 1);
    assert.equal(body.data.agent_resources.mcp.tool_count, 197);
  });

  test("degrades to null when the index has not been baked, never an error", async () => {
    const { status, body } = await gql("{ agent_resources }");
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.agent_resources, null);
  });

  test("agent_resources is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.agent_resources, 5);
  });
});

// #7168: GraphQL parity for the registry-summary / source-health / lineage /
// rpc-endpoints REST routes, each reusing the same baked artifact its MCP tool
// (registry_summary / get_source_health / get_lineage / list_rpc_endpoints)
// reads -- a cold artifact degrades to null (schema-stable), never a GraphQL
// error, matching agent_resources and the other artifact-backed resolvers.
describe("graphql — registry_summary / source_health / lineage / rpc_endpoints (#7168)", () => {
  test("registry_summary resolves the baked summary artifact", async () => {
    const env = fixtureEnv({
      "/metagraph/registry-summary.json": {
        subnet_count: 128,
        counts: { verified: 40 },
        generated_at: "2026-07-01T00:00:00.000Z",
      },
    });
    const { status, body } = await gql("{ registry_summary }", env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.registry_summary.subnet_count, 128);
    assert.equal(body.data.registry_summary.counts.verified, 40);
  });

  test("source_health resolves the baked per-provider rollup", async () => {
    const env = fixtureEnv({
      "/metagraph/source-health.json": {
        providers: [{ provider: "gittensor", status: "healthy" }],
        generated_at: "2026-07-01T00:00:00.000Z",
      },
    });
    const { status, body } = await gql("{ source_health }", env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.source_health.providers[0].provider, "gittensor");
  });

  test("lineage resolves the baked cross-network lineage", async () => {
    const env = fixtureEnv({
      "/metagraph/lineage.json": {
        link_count: 3,
        links: [{ mainnet_netuid: 64, testnet_netuid: 165 }],
        generated_at: "2026-07-01T00:00:00.000Z",
      },
    });
    const { status, body } = await gql("{ lineage }", env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.lineage.link_count, 3);
    assert.equal(body.data.lineage.links[0].mainnet_netuid, 64);
  });

  const RPC_ENDPOINTS_BLOB = {
    schema_version: 1,
    generated_at: "2026-07-01T00:00:00.000Z",
    summary: { endpoint_count: 2 },
    endpoints: [
      {
        id: "finney-wss",
        url: "wss://entrypoint-finney.opentensor.ai",
        network: "finney",
        status: "degraded",
        archive_support: false,
      },
      {
        id: "subvortex",
        url: "wss://subvortex.example",
        network: "finney",
        status: "degraded",
        archive_support: true,
      },
    ],
  };

  test("rpc_endpoints resolves the static catalog with no live overlay", async () => {
    const env = fixtureEnv({
      "/metagraph/rpc-endpoints.json": RPC_ENDPOINTS_BLOB,
    });
    const { status, body } = await gql("{ rpc_endpoints }", env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.rpc_endpoints.endpoints.length, 2);
    assert.equal(body.data.rpc_endpoints.endpoints[0].id, "finney-wss");
    // No live snapshot -> the static catalog passes through unchanged.
    assert.equal(body.data.rpc_endpoints.source, undefined);
  });

  test("rpc_endpoints applies the live 15-minute RPC-pool overlay", async () => {
    const env = fixtureEnv(
      { "/metagraph/rpc-endpoints.json": RPC_ENDPOINTS_BLOB },
      {
        kv: {
          [KV_HEALTH_RPC_POOL]: {
            last_run_at: "2026-07-20T12:00:00.000Z",
            endpoints: [
              {
                id: "finney-wss",
                status: "healthy",
                classification: "live",
                latency_ms: 42,
              },
            ],
          },
        },
      },
    );
    const { body } = await gql("{ rpc_endpoints }", env);
    assert.equal(body.data.rpc_endpoints.source, "live-cron-prober");
    assert.equal(
      body.data.rpc_endpoints.operational_observed_at,
      "2026-07-20T12:00:00.000Z",
    );
    const overlaid = body.data.rpc_endpoints.endpoints.find(
      (e) => e.id === "finney-wss",
    );
    assert.equal(overlaid.latency_ms, 42);
    assert.equal(overlaid.health_source, "probe-derived");
  });

  test("each field degrades to null on a cold artifact, never a GraphQL error", async () => {
    for (const field of [
      "registry_summary",
      "source_health",
      "lineage",
      "rpc_endpoints",
    ]) {
      const { status, body } = await gql(`{ ${field} }`);
      assert.equal(status, 200, `${field} should not error`);
      assert.equal(body.errors, undefined, `${field} should not error`);
      assert.equal(body.data[field], null, `${field} should degrade to null`);
    }
  });

  test("FIELD_COMPLEXITY weights all four new fields like their sibling relationship fields", () => {
    for (const field of [
      "registry_summary",
      "source_health",
      "lineage",
      "rpc_endpoints",
    ]) {
      assert.equal(FIELD_COMPLEXITY[field], 5, `${field} should be weighted`);
    }
  });
});

describe("graphql — subnet metagraph / overview / profile (#7169, composed-route parity)", () => {
  function tierEnv(sourceKey, payload, onUrl) {
    return {
      [sourceKey]: "postgres",
      DATA_API: {
        fetch: async (r) => {
          onUrl?.(new URL(r.url));
          return Response.json(payload);
        },
      },
    };
  }

  test("subnet_metagraph resolves the postgres-tier payload", async () => {
    let url;
    const env = tierEnv(
      "METAGRAPH_NEURONS_SOURCE",
      { schema_version: 1, netuid: 3, neuron_count: 1, neurons: [{ uid: 0 }] },
      (u) => {
        url = u;
      },
    );
    const { status, body } = await gql("{ subnet_metagraph(netuid: 3) }", env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.subnet_metagraph.neuron_count, 1);
    assert.equal(url.pathname, "/api/v1/subnets/3/metagraph");
    assert.equal(url.searchParams.get("validator_permit"), null);
  });

  test("subnet_metagraph forwards validator_permit to the tier", async () => {
    let url;
    const env = tierEnv(
      "METAGRAPH_NEURONS_SOURCE",
      { schema_version: 1, netuid: 3, neuron_count: 0, neurons: [] },
      (u) => {
        url = u;
      },
    );
    const { body } = await gql(
      "{ subnet_metagraph(netuid: 3, validator_permit: true) }",
      env,
    );
    assert.equal(body.errors, undefined);
    assert.equal(url.searchParams.get("validator_permit"), "true");
  });

  test("subnet_metagraph falls back to a schema-stable empty metagraph, never null", async () => {
    const { status, body } = await gql("{ subnet_metagraph(netuid: 3) }");
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_metagraph, {
      schema_version: 1,
      netuid: 3,
      neuron_count: 0,
      captured_at: null,
      block_number: null,
      neurons: [],
    });
  });

  test("subnet_overview composes the baked overview with live health", async () => {
    const env = fixtureEnv({
      "/metagraph/overview/3.json": { netuid: 3, name: "Three" },
    });
    const { status, body } = await gql("{ subnet_overview(netuid: 3) }", env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.subnet_overview.netuid, 3);
    assert.equal(body.data.subnet_overview.name, "Three");
  });

  test("subnet_overview resolves to null when no overview is baked", async () => {
    const { status, body } = await gql("{ subnet_overview(netuid: 3) }");
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.subnet_overview, null);
  });

  test("subnet_profile resolves the baked contributor-review profile", async () => {
    const env = fixtureEnv({
      "/metagraph/profiles/3.json": { netuid: 3, completeness_score: 88 },
    });
    const { status, body } = await gql("{ subnet_profile(netuid: 3) }", env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.subnet_profile.completeness_score, 88);
  });

  test("subnet_profile resolves to null when no profile is baked", async () => {
    const { status, body } = await gql("{ subnet_profile(netuid: 3) }");
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.subnet_profile, null);
  });

  test("subnet_profile rejects a negative netuid with BAD_USER_INPUT", async () => {
    const { body } = await gql("{ subnet_profile(netuid: -1) }");
    assert.equal(body.errors?.[0]?.extensions?.code, "BAD_USER_INPUT");
    assert.match(body.errors[0].message, /non-negative integer/);
  });

  test("subnet_profile surfaces a non-loader fault instead of reporting null", async () => {
    // An unparseable artifact body throws out of readR2's .json() as a plain
    // Error -- not a loader profilesMcp error -- so it must surface rather than
    // being silently reported as "no profile baked".
    const env = {
      METAGRAPH_R2_LATEST_PREFIX: "latest/",
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            async json() {
              throw new Error("malformed artifact body");
            },
          };
        },
      },
    };
    const { body } = await gql("{ subnet_profile(netuid: 3) }", env);
    assert.ok(body.errors?.length, "expected a GraphQL error");
    assert.equal(body.data?.subnet_profile ?? null, null);
  });

  test("the three fields are weighted as fan-out fields", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_metagraph, 5);
    assert.equal(FIELD_COMPLEXITY.subnet_overview, 5);
    assert.equal(FIELD_COMPLEXITY.subnet_profile, 5);
  });
});

describe("graphql — subnet market data (#6979, volume/ohlc/stake-quote/validators)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }
  const POOL = {
    "/metagraph/economics.json": {
      subnets: [
        {
          netuid: 64,
          tao_in_pool_tao: 201959.938748425,
          alpha_in_pool: 2730860.150574127,
          alpha_market_cap_tao: 5000,
        },
      ],
    },
  };

  test("subnet_volume cold store returns a schema-stable zeroed card", async () => {
    const { status, body } = await gql(
      "{ subnet_volume(netuid: 5) { schema_version netuid total_volume_tao buy_count sentiment sentiment_ratio vol_mcap_ratio } }",
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const v = body.data.subnet_volume;
    assert.equal(v.schema_version, 1);
    assert.equal(v.netuid, 5);
    assert.equal(v.total_volume_tao, 0);
    assert.equal(v.buy_count, 0);
    assert.equal(v.sentiment, "neutral");
    assert.equal(v.sentiment_ratio, null);
    assert.equal(v.vol_mcap_ratio, null);
  });

  test("subnet_volume unwraps the tier's { data } envelope", async () => {
    const env = {
      ...fixtureEnv(POOL),
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          data: {
            schema_version: 1,
            netuid: 64,
            window: "24h",
            buy_volume_tao: 12,
            sell_volume_tao: 8,
            total_volume_tao: 20,
            buy_count: 3,
            sell_count: 2,
            sentiment: "buying",
            sentiment_ratio: 0.6,
          },
        }),
      ),
    };
    const { status, body } = await gql(
      "{ subnet_volume(netuid: 64) { netuid window total_volume_tao buy_count sentiment sentiment_ratio } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const v = body.data.subnet_volume;
    assert.equal(v.window, "24h");
    assert.equal(v.total_volume_tao, 20);
    assert.equal(v.sentiment, "buying");
    assert.equal(v.sentiment_ratio, 0.6);
  });

  test("subnet_ohlc cold store returns an empty candle list", async () => {
    const { status, body } = await gql(
      "{ subnet_ohlc(netuid: 5) { schema_version netuid interval root_excluded candles { bucket_start open close } } }",
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const o = body.data.subnet_ohlc;
    assert.equal(o.interval, "1h");
    assert.deepEqual(o.candles, []);
    assert.equal(o.root_excluded, false);
  });

  test("subnet_ohlc forwards interval + days and returns tier candles", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            netuid: 7,
            interval: "1d",
            root_excluded: false,
            candles: [
              {
                bucket_start: 1770000000000,
                bucket_start_iso: "2026-02-02T00:00:00.000Z",
                open: 0.1,
                high: 0.2,
                low: 0.09,
                close: 0.15,
                volume_alpha: 100,
                volume_tao: 12,
                event_count: 4,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      '{ subnet_ohlc(netuid: 7, interval: "1d", days: 30) { interval candles { bucket_start close event_count } } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.ok(capturedUrl.pathname.endsWith("/subnets/7/ohlc"));
    assert.equal(capturedUrl.searchParams.get("interval"), "1d");
    assert.equal(capturedUrl.searchParams.get("days"), "30");
    const o = body.data.subnet_ohlc;
    assert.equal(o.interval, "1d");
    assert.equal(o.candles[0].bucket_start, 1770000000000);
    assert.equal(o.candles[0].event_count, 4);
  });

  test("subnet_ohlc rejects an unsupported interval", async () => {
    const { body } = await gql(
      '{ subnet_ohlc(netuid: 5, interval: "5m") { interval } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/interval/i.test(body.errors[0].message));
  });

  test("subnet_ohlc rejects days above the maximum window", async () => {
    const { body } = await gql(
      "{ subnet_ohlc(netuid: 5, days: 9999) { interval } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/days/i.test(body.errors[0].message));
  });

  test("subnet_ohlc rejects a non-positive days", async () => {
    const { body } = await gql(
      "{ subnet_ohlc(netuid: 5, days: 0) { interval } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/days/i.test(body.errors[0].message));
  });

  test("subnet_stake_quote quotes against the live pool reserves", async () => {
    const { status, body } = await gql(
      "{ subnet_stake_quote(netuid: 64, amount: 1000) { schema_version netuid direction amount expected_out expected_out_unit spot_price_tao effective_price_tao price_impact_pct is_root } }",
      fixtureEnv(POOL),
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const q = body.data.subnet_stake_quote;
    assert.equal(q.schema_version, 1);
    assert.equal(q.netuid, 64);
    assert.equal(q.direction, "stake");
    assert.equal(q.expected_out_unit, "alpha");
    assert.ok(q.expected_out > 0);
    assert.ok(q.price_impact_pct > 0);
    assert.equal(q.is_root, false);
  });

  test("subnet_stake_quote quotes an unstake (alpha in, TAO out)", async () => {
    const { body } = await gql(
      '{ subnet_stake_quote(netuid: 64, amount: 500, direction: "unstake") { direction expected_out_unit expected_out } }',
      fixtureEnv(POOL),
    );
    assert.equal(body.errors, undefined);
    assert.equal(body.data.subnet_stake_quote.direction, "unstake");
    assert.equal(body.data.subnet_stake_quote.expected_out_unit, "tao");
  });

  test("subnet_stake_quote rejects an unsupported direction", async () => {
    const { body } = await gql(
      '{ subnet_stake_quote(netuid: 64, amount: 1, direction: "swap") { direction } }',
      fixtureEnv(POOL),
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/direction/i.test(body.errors[0].message));
  });

  test("subnet_stake_quote surfaces the calculator's error for a subnet with no pool", async () => {
    const { body } = await gql(
      "{ subnet_stake_quote(netuid: 999, amount: 1) { expected_out } }",
      fixtureEnv(POOL),
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.equal(body.data?.subnet_stake_quote ?? null, null);
  });

  test("subnet_validators cold store returns a schema-stable empty list", async () => {
    const { status, body } = await gql(
      "{ subnet_validators(netuid: 5) { schema_version netuid validator_count captured_at block_number validators { uid hotkey } } }",
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const v = body.data.subnet_validators;
    assert.equal(v.validator_count, 0);
    assert.equal(v.captured_at, null);
    assert.deepEqual(v.validators, []);
  });

  test("subnet_validators resolves the Postgres-tier validator set", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            netuid: 7,
            validator_count: 1,
            captured_at: "2026-07-19T00:00:00.000Z",
            block_number: 91,
            validators: [
              {
                uid: 3,
                hotkey: "5Hotkey",
                stake_tao: 1234.5,
                validator_permit: true,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      "{ subnet_validators(netuid: 7) { netuid validator_count block_number validators { uid hotkey stake_tao validator_permit } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.ok(capturedUrl.pathname.endsWith("/subnets/7/validators"));
    const v = body.data.subnet_validators;
    assert.equal(v.validator_count, 1);
    assert.equal(v.block_number, 91);
    assert.equal(v.validators[0].hotkey, "5Hotkey");
    assert.equal(v.validators[0].stake_tao, 1234.5);
  });

  test("a negative netuid is a GraphQL error on every market-data field", async () => {
    for (const q of [
      "{ subnet_volume(netuid: -1) { netuid } }",
      "{ subnet_ohlc(netuid: -1) { netuid } }",
      "{ subnet_stake_quote(netuid: -1, amount: 1) { netuid } }",
      "{ subnet_validators(netuid: -1) { netuid } }",
    ]) {
      const { body } = await gql(q);
      assert.ok(body.errors, `expected a GraphQL error for ${q}`);
      assert.ok(/netuid/i.test(body.errors[0].message));
    }
  });

  test("a partial tier body falls back to defaults on every market-data field", async () => {
    // Exercises the `?? default` branches: a tier that answers with an empty
    // body must still yield the schema-stable card, never nulls or an error.
    const volumeEnv = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({ data: {} })),
    };
    const vol = await gql(
      "{ subnet_volume(netuid: 9) { schema_version netuid window total_volume_alpha total_volume_tao buy_volume_alpha sell_volume_alpha buy_volume_tao sell_volume_tao buy_count sell_count net_volume_alpha sentiment sentiment_ratio vol_mcap_ratio } }",
      volumeEnv,
    );
    assert.equal(vol.body.errors, undefined);
    assert.deepEqual(vol.body.data.subnet_volume, {
      schema_version: 1,
      netuid: 9,
      window: null,
      total_volume_alpha: 0,
      total_volume_tao: 0,
      buy_volume_alpha: 0,
      sell_volume_alpha: 0,
      buy_volume_tao: 0,
      sell_volume_tao: 0,
      buy_count: 0,
      sell_count: 0,
      net_volume_alpha: 0,
      sentiment: null,
      sentiment_ratio: null,
      vol_mcap_ratio: null,
    });

    // A fresh Response per fetch -- a single Response body can only be consumed
    // once, so reusing one would make the second query silently miss the tier.
    const emptyTier = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const ohlc = await gql(
      "{ subnet_ohlc(netuid: 9) { schema_version netuid interval candles { open } root_excluded } }",
      emptyTier,
    );
    assert.equal(ohlc.body.errors, undefined);
    assert.deepEqual(ohlc.body.data.subnet_ohlc, {
      schema_version: 1,
      netuid: 9,
      interval: "1h",
      candles: [],
      root_excluded: false,
    });

    const vals = await gql(
      "{ subnet_validators(netuid: 9) { schema_version netuid validator_count captured_at block_number validators { uid } } }",
      emptyTier,
    );
    assert.equal(vals.body.errors, undefined);
    assert.deepEqual(vals.body.data.subnet_validators, {
      schema_version: 1,
      netuid: 9,
      validator_count: 0,
      captured_at: null,
      block_number: null,
      validators: [],
    });
  });

  test("the market-data fields are weighted as fan-out fields", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_volume, 5);
    assert.equal(FIELD_COMPLEXITY.subnet_ohlc, 5);
    assert.equal(FIELD_COMPLEXITY.subnet_stake_quote, 5);
    assert.equal(FIELD_COMPLEXITY.subnet_validators, 5);
  });
});

describe("graphql — subnet_health_percentiles (#6980, live latency percentiles)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable empty surfaces list, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_health_percentiles(netuid: 5) {
          schema_version netuid window surfaces
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const p = body.data.subnet_health_percentiles;
    assert.equal(p.schema_version, 1);
    assert.equal(p.netuid, 5);
    assert.equal(p.window, "7d");
    assert.deepEqual(p.surfaces, []);
  });

  test("resolves the Postgres-tier per-surface percentiles", async () => {
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          window: "30d",
          observed_at: "2026-07-19T00:00:00.000Z",
          source: "live-cron-prober",
          surfaces: [
            {
              surface: "api",
              latency_sample_count: 120,
              p50_ms: 88,
              p90_ms: 210,
              p95_ms: 280,
              p99_ms: 640,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      '{ subnet_health_percentiles(netuid: 7, window: "30d") { netuid window observed_at source surfaces } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const p = body.data.subnet_health_percentiles;
    assert.equal(p.netuid, 7);
    assert.equal(p.window, "30d");
    assert.equal(p.source, "live-cron-prober");
    assert.equal(p.surfaces[0].p95_ms, 280);
  });

  test("forwards the window to the health/percentiles Postgres path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      '{ subnet_health_percentiles(netuid: 3, window: "30d") { netuid } }',
      env,
    );
    assert.ok(capturedUrl.pathname.endsWith("/subnets/3/health/percentiles"));
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ subnet_health_percentiles(netuid: 5, window: "5d") { netuid } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.equal(body.data?.subnet_health_percentiles ?? null, null);
  });

  test("subnet_health_percentiles is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_health_percentiles, 5);
  });
});

describe("graphql — subnet_event_summary (#6980, chain-event activity summary)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_event_summary(netuid: 5) {
          schema_version netuid window total_events kind_count category_count
          recent_event_count limit categories event_kinds recent_events
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_event_summary, {
      schema_version: 1,
      netuid: 5,
      window: "30d",
      total_events: 0,
      kind_count: 0,
      category_count: 0,
      recent_event_count: 0,
      limit: 10,
      categories: [],
      event_kinds: [],
      recent_events: [],
    });
  });

  test("resolves the Postgres-tier summary", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          window: "7d",
          observed_at: "2026-07-19T00:00:00.000Z",
          total_events: 42,
          kind_count: 3,
          category_count: 2,
          recent_event_count: 2,
          limit: 10,
          categories: [{ category: "stake", event_count: 30 }],
          event_kinds: [{ event_kind: "StakeAdded", event_count: 30 }],
          recent_events: [{ event_kind: "StakeAdded", block_number: 91 }],
        }),
      ),
    };
    const { status, body } = await gql(
      '{ subnet_event_summary(netuid: 7, window: "7d") { netuid window total_events kind_count categories event_kinds recent_events } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const s = body.data.subnet_event_summary;
    assert.equal(s.total_events, 42);
    assert.equal(s.kind_count, 3);
    assert.equal(s.categories[0].category, "stake");
    assert.equal(s.recent_events[0].block_number, 91);
  });

  test("clamps the recent-event limit into 1..50 and forwards it", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      '{ subnet_event_summary(netuid: 3, window: "90d", limit: 999) { netuid } }',
      env,
    );
    assert.ok(capturedUrl.pathname.endsWith("/subnets/3/event-summary"));
    assert.equal(capturedUrl.searchParams.get("window"), "90d");
    assert.equal(capturedUrl.searchParams.get("limit"), "50");
  });

  test("clamps a below-range limit up to 1", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql("{ subnet_event_summary(netuid: 3, limit: 0) { netuid } }", env);
    assert.equal(capturedUrl.searchParams.get("limit"), "1");
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ subnet_event_summary(netuid: 5, window: "5d") { netuid } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_event_summary ?? null, null);
  });

  test("a negative netuid is a GraphQL error", async () => {
    const { body } = await gql(
      "{ subnet_event_summary(netuid: -1) { netuid } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
  });

  test("subnet_event_summary is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_event_summary, 5);
  });
});

describe("graphql — subnet_gaps / subnet_evidence (#6980, baked review artifacts)", () => {
  test("subnet_gaps resolves the baked gap report", async () => {
    const env = fixtureEnv({
      "/metagraph/review/gaps/5.json": {
        netuid: 5,
        gaps: [{ kind: "api", missing: true }],
      },
    });
    const { status, body } = await gql("{ subnet_gaps(netuid: 5) }", env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.subnet_gaps.netuid, 5);
    assert.equal(body.data.subnet_gaps.gaps[0].kind, "api");
  });

  test("subnet_gaps degrades to null when no report is baked, never an error", async () => {
    const { status, body } = await gql("{ subnet_gaps(netuid: 999) }");
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.subnet_gaps, null);
  });

  test("subnet_evidence resolves the baked evidence record", async () => {
    const env = fixtureEnv({
      "/metagraph/evidence/5.json": {
        netuid: 5,
        sources: ["https://example.com"],
      },
    });
    const { status, body } = await gql("{ subnet_evidence(netuid: 5) }", env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.subnet_evidence.netuid, 5);
  });

  test("subnet_evidence degrades to null when no record is baked", async () => {
    const { status, body } = await gql("{ subnet_evidence(netuid: 999) }");
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.subnet_evidence, null);
  });

  test("a negative netuid is a GraphQL error on both artifact fields", async () => {
    for (const field of ["subnet_gaps", "subnet_evidence"]) {
      const { body } = await gql(`{ ${field}(netuid: -1) }`);
      assert.ok(body.errors, `expected a GraphQL error for ${field}`);
      assert.ok(/netuid/i.test(body.errors[0].message));
    }
  });

  test("both artifact fields are weighted as fan-out fields", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_gaps, 5);
    assert.equal(FIELD_COMPLEXITY.subnet_evidence, 5);
  });
});

describe("graphql — subnet_performance_history (#6981, neuron_daily reward-distribution trend)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable empty series, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_performance_history(netuid: 5) {
          schema_version netuid window point_count points { snapshot_date incentive_gini }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_performance_history, {
      schema_version: 1,
      netuid: 5,
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("resolves the Postgres-tier per-day trend points", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          window: "7d",
          point_count: 2,
          points: [
            {
              snapshot_date: "2026-07-02",
              neuron_count: 4,
              validator_count: 2,
              active_count: 3,
              incentive_gini: 0.42,
              incentive_nakamoto_coefficient: 2,
              incentive_top_10pct_share: 0.55,
              dividends_gini: 0.3,
              dividends_nakamoto_coefficient: 1,
              dividends_top_10pct_share: 0.7,
              trust_mean: 0.61,
              trust_median: 0.6,
              consensus_mean: 0.5,
              consensus_median: 0.49,
              validator_trust_mean: 0.8,
              validator_trust_median: 0.79,
            },
            {
              snapshot_date: "2026-07-01",
              neuron_count: 3,
              validator_count: 1,
              active_count: 2,
              incentive_gini: 0.4,
              incentive_nakamoto_coefficient: 2,
              incentive_top_10pct_share: 0.5,
              dividends_gini: 0.28,
              dividends_nakamoto_coefficient: 1,
              dividends_top_10pct_share: 0.68,
              trust_mean: 0.58,
              trust_median: 0.57,
              consensus_mean: 0.47,
              consensus_median: 0.46,
              validator_trust_mean: 0.77,
              validator_trust_median: 0.76,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_performance_history(netuid: 7, window: "7d") {
          netuid window point_count
          points { snapshot_date neuron_count validator_count incentive_gini dividends_top_10pct_share trust_median validator_trust_mean }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const h = body.data.subnet_performance_history;
    assert.equal(h.netuid, 7);
    assert.equal(h.window, "7d");
    assert.equal(h.point_count, 2);
    assert.equal(h.points.length, 2);
    assert.equal(h.points[0].snapshot_date, "2026-07-02");
    assert.equal(h.points[0].incentive_gini, 0.42);
    assert.equal(h.points[0].validator_count, 2);
    assert.equal(h.points[1].dividends_top_10pct_share, 0.68);
    assert.equal(h.points[1].trust_median, 0.57);
  });

  test("forwards the window to the performance/history Postgres path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      '{ subnet_performance_history(netuid: 3, window: "90d") { point_count } }',
      env,
    );
    assert.ok(capturedUrl.pathname.endsWith("/subnets/3/performance/history"));
    assert.equal(capturedUrl.searchParams.get("window"), "90d");
  });

  test("an unsupported window is a GraphQL error, not a silent series", async () => {
    const { body } = await gql(
      '{ subnet_performance_history(netuid: 5, window: "5d") { point_count } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_performance_history ?? null, null);
  });

  test("a negative netuid is a GraphQL error, not an empty series", async () => {
    const { body } = await gql(
      "{ subnet_performance_history(netuid: -1) { point_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_performance_history ?? null, null);
  });

  test("subnet_performance_history is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_performance_history, 5);
  });
});

describe("graphql — subnet_yield_history (#6981, neuron_daily emission-per-stake trend)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable empty series, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_yield_history(netuid: 5) {
          schema_version netuid window point_count points { snapshot_date subnet_yield }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_yield_history, {
      schema_version: 1,
      netuid: 5,
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("resolves the Postgres-tier per-day trend points", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 7,
          window: "7d",
          point_count: 2,
          points: [
            {
              snapshot_date: "2026-07-02",
              neuron_count: 4,
              validator_count: 2,
              yield_count: 4,
              subnet_yield: 0.0123,
              mean_yield: 0.0131,
              median_yield: 0.0129,
              p25_yield: 0.011,
              p75_yield: 0.015,
              p90_yield: 0.017,
            },
            {
              snapshot_date: "2026-07-01",
              neuron_count: 3,
              validator_count: 1,
              yield_count: 3,
              subnet_yield: 0.0119,
              mean_yield: 0.0125,
              median_yield: 0.0124,
              p25_yield: 0.0105,
              p75_yield: 0.0145,
              p90_yield: 0.0166,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_yield_history(netuid: 7, window: "7d") {
          netuid window point_count
          points { snapshot_date neuron_count validator_count yield_count subnet_yield median_yield p90_yield }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const h = body.data.subnet_yield_history;
    assert.equal(h.netuid, 7);
    assert.equal(h.window, "7d");
    assert.equal(h.point_count, 2);
    assert.equal(h.points.length, 2);
    assert.equal(h.points[0].snapshot_date, "2026-07-02");
    assert.equal(h.points[0].subnet_yield, 0.0123);
    assert.equal(h.points[0].yield_count, 4);
    assert.equal(h.points[1].median_yield, 0.0124);
    assert.equal(h.points[1].p90_yield, 0.0166);
  });

  test("forwards the window to the yield/history Postgres path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      '{ subnet_yield_history(netuid: 3, window: "90d") { point_count } }',
      env,
    );
    assert.ok(capturedUrl.pathname.endsWith("/subnets/3/yield/history"));
    assert.equal(capturedUrl.searchParams.get("window"), "90d");
  });

  test("an unsupported window is a GraphQL error, not a silent series", async () => {
    const { body } = await gql(
      '{ subnet_yield_history(netuid: 5, window: "5d") { point_count } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_yield_history ?? null, null);
  });

  test("a negative netuid is a GraphQL error, not an empty series", async () => {
    const { body } = await gql(
      "{ subnet_yield_history(netuid: -1) { point_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_yield_history ?? null, null);
  });

  test("subnet_yield_history is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_yield_history, 5);
  });
});

describe("graphql — neuron (#5900, Postgres-tier + neuron:null fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable card with neuron:null, never null", async () => {
    const { status, body } = await gql(
      `{ neuron(netuid: 5, uid: 12) {
          schema_version netuid captured_at block_number
          neuron { uid hotkey }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.neuron, {
      schema_version: 1,
      netuid: 5,
      captured_at: null,
      block_number: null,
      neuron: null,
    });
  });

  test("resolves the Postgres-tier neuron detail row", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          captured_at: "2026-07-01T00:00:00.000Z",
          block_number: 8621331,
          neuron: {
            uid: 12,
            hotkey: "5Hot",
            coldkey: "5Cold",
            active: true,
            validator_permit: false,
            rank: 0.1,
            trust: 0.2,
            validator_trust: 0,
            consensus: 0.15,
            incentive: 0.05,
            dividends: 0,
            emission_tao: 1.25,
            stake_tao: 100.5,
            registered_at_block: 8000000,
            is_immunity_period: false,
            axon: "1.2.3.4:8091",
            take: 0.18,
          },
        }),
      ),
    };
    const { status, body } = await gql(
      `{ neuron(netuid: 5, uid: 12) {
          netuid captured_at block_number
          neuron {
            uid hotkey coldkey active validator_permit
            rank trust stake_tao emission_tao axon take
          }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const n = body.data.neuron;
    assert.equal(n.block_number, 8621331);
    assert.deepEqual(n.neuron, {
      uid: 12,
      hotkey: "5Hot",
      coldkey: "5Cold",
      active: true,
      validator_permit: false,
      rank: 0.1,
      trust: 0.2,
      stake_tao: 100.5,
      emission_tao: 1.25,
      axon: "1.2.3.4:8091",
      take: 0.18,
    });
  });

  test("exposes immunity_expires_at_block/immunity_expires_at when the REST tier returns them (#6640)", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          captured_at: "2026-07-01T00:00:00.000Z",
          block_number: 8621331,
          neuron: {
            uid: 12,
            hotkey: "5Hot",
            registered_at_block: 8000000,
            is_immunity_period: true,
            immunity_expires_at_block: 8007200,
            immunity_expires_at: "2026-07-02T00:00:00.000Z",
          },
        }),
      ),
    };
    const { status, body } = await gql(
      `{ neuron(netuid: 5, uid: 12) {
          neuron { uid is_immunity_period immunity_expires_at_block immunity_expires_at }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.neuron.neuron, {
      uid: 12,
      is_immunity_period: true,
      immunity_expires_at_block: 8007200,
      immunity_expires_at: "2026-07-02T00:00:00.000Z",
    });
  });

  test("hits /api/v1/subnets/{netuid}/neurons/{uid} on the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql("{ neuron(netuid: 3, uid: 7) { netuid neuron { uid } } }", env);
    assert.equal(capturedUrl.pathname, "/api/v1/subnets/3/neurons/7");
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ neuron(netuid: 9, uid: 1) {
          schema_version netuid captured_at block_number neuron { uid }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.neuron, {
      schema_version: 1,
      netuid: 9,
      captured_at: null,
      block_number: null,
      neuron: null,
    });
  });

  test("a negative netuid is a GraphQL error, not a null card", async () => {
    const { body } = await gql(
      "{ neuron(netuid: -1, uid: 0) { neuron { uid } } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
    assert.equal(body.data?.neuron ?? null, null);
  });

  test("a negative uid is a GraphQL error, not a null card", async () => {
    const { body } = await gql(
      "{ neuron(netuid: 5, uid: -1) { neuron { uid } } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/uid/i.test(body.errors[0].message));
    assert.equal(body.data?.neuron ?? null, null);
  });

  test("neuron is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.neuron, 5);
  });
});

describe("graphql — neuron_history (#5900, Postgres-tier + empty-points fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag / no neuron_daily rows returns a schema-stable empty-points card, never null", async () => {
    const { status, body } = await gql(
      `{ neuron_history(netuid: 5, uid: 12) {
          schema_version netuid uid window point_count points { snapshot_date }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.neuron_history, {
      schema_version: 1,
      netuid: 5,
      uid: 12,
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("resolves the Postgres-tier points for the requested window", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          uid: 12,
          window: "90d",
          point_count: 1,
          points: [
            {
              snapshot_date: "2026-07-01",
              captured_at: "2026-07-01T00:00:00.000Z",
              block_number: 8621331,
              uid: 12,
              hotkey: "5Hot",
              coldkey: "5Cold",
              active: true,
              validator_permit: true,
              stake_tao: 200,
              emission_tao: 3.5,
              rank: 0.4,
              trust: 0.5,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ neuron_history(netuid: 5, uid: 12, window: "90d") {
          netuid uid window point_count
          points {
            snapshot_date captured_at block_number uid hotkey
            stake_tao emission_tao rank trust
          }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.neuron_history;
    assert.equal(r.netuid, 5);
    assert.equal(r.uid, 12);
    assert.equal(r.window, "90d");
    assert.equal(r.point_count, 1);
    assert.deepEqual(r.points, [
      {
        snapshot_date: "2026-07-01",
        captured_at: "2026-07-01T00:00:00.000Z",
        block_number: 8621331,
        uid: 12,
        hotkey: "5Hot",
        stake_tao: 200,
        emission_tao: 3.5,
        rank: 0.4,
        trust: 0.5,
      },
    ]);
  });

  test("window is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      '{ neuron_history(netuid: 3, uid: 7, window: "7d") { window } }',
      env,
    );
    assert.equal(capturedUrl.pathname, "/api/v1/subnets/3/neurons/7/history");
    assert.equal(capturedUrl.searchParams.get("window"), "7d");
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ neuron_history(netuid: 9, uid: 1, window: "30d") {
          schema_version netuid uid window point_count points { snapshot_date }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.neuron_history, {
      schema_version: 1,
      netuid: 9,
      uid: 1,
      window: "30d",
      point_count: 0,
      points: [],
    });
  });

  test("an unsupported window is a GraphQL error, not a silent series", async () => {
    const { body } = await gql(
      '{ neuron_history(netuid: 5, uid: 12, window: "5d") { point_count } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window/i.test(body.errors[0].message));
    assert.equal(body.data?.neuron_history ?? null, null);
  });

  test("a negative netuid is a GraphQL error, not an empty series", async () => {
    const { body } = await gql(
      "{ neuron_history(netuid: -1, uid: 0) { point_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
    assert.equal(body.data?.neuron_history ?? null, null);
  });

  test("a negative uid is a GraphQL error, not an empty series", async () => {
    const { body } = await gql(
      "{ neuron_history(netuid: 5, uid: -1) { point_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/uid/i.test(body.errors[0].message));
    assert.equal(body.data?.neuron_history ?? null, null);
  });

  test("neuron_history is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.neuron_history, 5);
  });
});

describe("graphql — subnet_yield (#5713, Postgres-tier + zeroed-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_yield(netuid: 5) {
          schema_version netuid captured_at block_number
          neuron_count validator_count miner_count
          subnet_yield mean_yield median_yield p25_yield p75_yield p90_yield
          neurons { uid }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const y = body.data.subnet_yield;
    assert.equal(y.schema_version, 1);
    assert.equal(y.netuid, 5);
    assert.equal(y.neuron_count, 0);
    assert.equal(y.validator_count, 0);
    assert.equal(y.miner_count, 0);
    assert.equal(y.subnet_yield, null);
    assert.deepEqual(y.neurons, []);
  });

  test("resolves the Postgres-tier card, including the per-UID neuron rows", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          captured_at: "2026-07-01T00:00:00.000Z",
          block_number: 8621331,
          neuron_count: 2,
          validator_count: 1,
          miner_count: 1,
          total_stake_tao: 1500.5,
          total_emission_tao: 12.25,
          subnet_yield: 0.0081,
          mean_yield: 0.009,
          median_yield: 0.009,
          p25_yield: 0.005,
          p75_yield: 0.013,
          p90_yield: 0.02,
          neurons: [
            {
              uid: 0,
              hotkey: "5Val",
              role: "validator",
              stake_tao: 1000.5,
              emission_tao: 9.1,
              yield: 0.0091,
            },
            {
              uid: 1,
              hotkey: "5Min",
              role: "miner",
              stake_tao: 500,
              emission_tao: null,
              yield: null,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_yield(netuid: 5) {
          netuid captured_at block_number neuron_count validator_count miner_count
          total_stake_tao total_emission_tao subnet_yield mean_yield median_yield
          p25_yield p75_yield p90_yield
          neurons { uid hotkey role stake_tao emission_tao yield }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const y = body.data.subnet_yield;
    assert.equal(y.block_number, 8621331);
    assert.equal(y.neuron_count, 2);
    assert.equal(y.validator_count, 1);
    assert.equal(y.subnet_yield, 0.0081);
    assert.equal(y.neurons.length, 2);
    assert.deepEqual(y.neurons[0], {
      uid: 0,
      hotkey: "5Val",
      role: "validator",
      stake_tao: 1000.5,
      emission_tao: 9.1,
      yield: 0.0091,
    });
    // A stakeless/blank-emission neuron keeps its nulls, not a coerced 0.
    assert.equal(y.neurons[1].emission_tao, null);
    assert.equal(y.neurons[1].yield, null);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_yield(netuid: 9) {
          schema_version netuid captured_at block_number
          neuron_count validator_count miner_count
          subnet_yield mean_yield median_yield p25_yield p75_yield p90_yield
          neurons { uid }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_yield, {
      schema_version: 1,
      netuid: 9,
      captured_at: null,
      block_number: null,
      neuron_count: 0,
      validator_count: 0,
      miner_count: 0,
      subnet_yield: null,
      mean_yield: null,
      median_yield: null,
      p25_yield: null,
      p75_yield: null,
      p90_yield: null,
      neurons: [],
    });
  });
});

describe("graphql — subnet_weights (#5711, Postgres-tier + zeroed-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_weights(netuid: 5) {
          schema_version netuid window observed_at
          distinct_setters weight_sets sets_per_setter
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_weights, {
      schema_version: 1,
      netuid: 5,
      window: "7d",
      observed_at: null,
      distinct_setters: 0,
      weight_sets: 0,
      sets_per_setter: null,
    });
  });

  test("resolves the Postgres-tier card for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          window: "30d",
          observed_at: "2026-07-01T00:00:00.000Z",
          distinct_setters: 4,
          weight_sets: 10,
          sets_per_setter: 2.5,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_weights(netuid: 5, window: "30d") {
          netuid window observed_at distinct_setters weight_sets sets_per_setter
        } }`,
      env,
    );
    assert.equal(status, 200);
    const w = body.data.subnet_weights;
    assert.equal(w.window, "30d");
    assert.equal(w.observed_at, "2026-07-01T00:00:00.000Z");
    assert.equal(w.distinct_setters, 4);
    assert.equal(w.weight_sets, 10);
    assert.equal(w.sets_per_setter, 2.5);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_weights(netuid: 9, window: "30d") {
          schema_version netuid window observed_at distinct_setters weight_sets sets_per_setter
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_weights, {
      schema_version: 1,
      netuid: 9,
      window: "30d",
      observed_at: null,
      distinct_setters: 0,
      weight_sets: 0,
      sets_per_setter: null,
    });
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ subnet_weights(netuid: 5, window: "99d") { weight_sets } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|7d/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_weights ?? null, null);
  });
});

describe("graphql — subnet_weight_setters (#5712, Postgres-tier + empty-leaderboard fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable empty leaderboard, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_weight_setters(netuid: 5) {
          schema_version netuid window observed_at
          distinct_setters weight_sets setter_count
          setters { hotkey uid weight_sets share }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_weight_setters, {
      schema_version: 1,
      netuid: 5,
      window: "7d",
      observed_at: null,
      distinct_setters: 0,
      weight_sets: 0,
      setter_count: 0,
      setters: [],
    });
  });

  test("resolves the Postgres-tier leaderboard for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          window: "30d",
          observed_at: "2026-07-01T00:00:00.000Z",
          distinct_setters: 2,
          weight_sets: 10,
          setter_count: 2,
          setters: [
            {
              hotkey: "5SetterA",
              uid: 1,
              weight_sets: 7,
              share: 0.7,
              first_set_at: "2026-06-20T00:00:00.000Z",
              last_set_at: "2026-07-01T00:00:00.000Z",
            },
            {
              hotkey: null,
              uid: 2,
              weight_sets: 3,
              share: 0.3,
              first_set_at: "2026-06-25T00:00:00.000Z",
              last_set_at: "2026-06-30T00:00:00.000Z",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_weight_setters(netuid: 5, window: "30d") {
          netuid window observed_at distinct_setters weight_sets setter_count
          setters { hotkey uid weight_sets share first_set_at last_set_at }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const w = body.data.subnet_weight_setters;
    assert.equal(w.window, "30d");
    assert.equal(w.weight_sets, 10);
    assert.equal(w.setter_count, 2);
    assert.equal(w.setters[0].hotkey, "5SetterA");
    assert.equal(w.setters[0].share, 0.7);
    assert.equal(w.setters[1].hotkey, null);
    assert.equal(w.setters[1].uid, 2);
  });

  test("window is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(
      '{ subnet_weight_setters(netuid: 3, window: "30d") { setter_count } }',
      env,
    );
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.ok(capturedUrl.pathname.endsWith("/subnets/3/weights/setters"));
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_weight_setters(netuid: 9, window: "30d") {
          schema_version netuid window observed_at
          distinct_setters weight_sets setter_count setters { hotkey }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_weight_setters, {
      schema_version: 1,
      netuid: 9,
      window: "30d",
      observed_at: null,
      distinct_setters: 0,
      weight_sets: 0,
      setter_count: 0,
      setters: [],
    });
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ subnet_weight_setters(netuid: 5, window: "99d") { setter_count } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|7d/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_weight_setters ?? null, null);
  });

  test("a negative netuid is a GraphQL error, not an empty card", async () => {
    const { body } = await gql(
      "{ subnet_weight_setters(netuid: -1) { setter_count } }",
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/netuid/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_weight_setters ?? null, null);
  });

  test("subnet_weight_setters is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_weight_setters, 5);
  });
});

describe("graphql — subnet_stake_moves (#5716, Postgres-tier + zeroed-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_stake_moves(netuid: 5) {
          schema_version netuid window observed_at
          distinct_movers movements movements_per_mover
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_stake_moves, {
      schema_version: 1,
      netuid: 5,
      window: "7d",
      observed_at: null,
      distinct_movers: 0,
      movements: 0,
      movements_per_mover: null,
    });
  });

  test("resolves the Postgres-tier card for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          window: "30d",
          observed_at: "2026-07-01T00:00:00.000Z",
          distinct_movers: 6,
          movements: 15,
          movements_per_mover: 2.5,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_stake_moves(netuid: 5, window: "30d") {
          netuid window observed_at distinct_movers movements movements_per_mover
        } }`,
      env,
    );
    assert.equal(status, 200);
    const m = body.data.subnet_stake_moves;
    assert.equal(m.window, "30d");
    assert.equal(m.observed_at, "2026-07-01T00:00:00.000Z");
    assert.equal(m.distinct_movers, 6);
    assert.equal(m.movements, 15);
    assert.equal(m.movements_per_mover, 2.5);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_stake_moves(netuid: 9, window: "30d") {
          schema_version netuid window observed_at distinct_movers movements movements_per_mover
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_stake_moves, {
      schema_version: 1,
      netuid: 9,
      window: "30d",
      observed_at: null,
      distinct_movers: 0,
      movements: 0,
      movements_per_mover: null,
    });
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ subnet_stake_moves(netuid: 5, window: "99d") { movements } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|7d/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_stake_moves ?? null, null);
  });
});

describe("graphql — subnet_stake_transfers (#5717, Postgres-tier + zeroed-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_stake_transfers(netuid: 5) {
          schema_version netuid window observed_at
          distinct_senders transfers transfers_per_sender
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_stake_transfers, {
      schema_version: 1,
      netuid: 5,
      window: "7d",
      observed_at: null,
      distinct_senders: 0,
      transfers: 0,
      transfers_per_sender: null,
    });
  });

  test("resolves the Postgres-tier card for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          window: "30d",
          observed_at: "2026-07-01T00:00:00.000Z",
          distinct_senders: 4,
          transfers: 11,
          transfers_per_sender: 2.75,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_stake_transfers(netuid: 5, window: "30d") {
          netuid window observed_at distinct_senders transfers transfers_per_sender
        } }`,
      env,
    );
    assert.equal(status, 200);
    const t = body.data.subnet_stake_transfers;
    assert.equal(t.window, "30d");
    assert.equal(t.observed_at, "2026-07-01T00:00:00.000Z");
    assert.equal(t.distinct_senders, 4);
    assert.equal(t.transfers, 11);
    assert.equal(t.transfers_per_sender, 2.75);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_stake_transfers(netuid: 9, window: "30d") {
          schema_version netuid window observed_at distinct_senders transfers transfers_per_sender
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_stake_transfers, {
      schema_version: 1,
      netuid: 9,
      window: "30d",
      observed_at: null,
      distinct_senders: 0,
      transfers: 0,
      transfers_per_sender: null,
    });
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ subnet_stake_transfers(netuid: 5, window: "99d") { transfers } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|7d/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_stake_transfers ?? null, null);
  });
});

describe("graphql — subnet_deregistrations (#5719, Postgres-tier + zeroed-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_deregistrations(netuid: 5) {
          schema_version netuid window observed_at
          distinct_deregistered_hotkeys deregistrations deregistrations_per_hotkey
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_deregistrations, {
      schema_version: 1,
      netuid: 5,
      window: "7d",
      observed_at: null,
      distinct_deregistered_hotkeys: 0,
      deregistrations: 0,
      deregistrations_per_hotkey: null,
    });
  });

  test("resolves the Postgres-tier card for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          window: "30d",
          observed_at: "2026-07-01T00:00:00.000Z",
          distinct_deregistered_hotkeys: 2,
          deregistrations: 5,
          deregistrations_per_hotkey: 2.5,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_deregistrations(netuid: 5, window: "30d") {
          netuid window observed_at distinct_deregistered_hotkeys deregistrations deregistrations_per_hotkey
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.subnet_deregistrations;
    assert.equal(r.window, "30d");
    assert.equal(r.observed_at, "2026-07-01T00:00:00.000Z");
    assert.equal(r.distinct_deregistered_hotkeys, 2);
    assert.equal(r.deregistrations, 5);
    assert.equal(r.deregistrations_per_hotkey, 2.5);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_deregistrations(netuid: 9, window: "30d") {
          schema_version netuid window observed_at distinct_deregistered_hotkeys deregistrations deregistrations_per_hotkey
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_deregistrations, {
      schema_version: 1,
      netuid: 9,
      window: "30d",
      observed_at: null,
      distinct_deregistered_hotkeys: 0,
      deregistrations: 0,
      deregistrations_per_hotkey: null,
    });
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ subnet_deregistrations(netuid: 5, window: "99d") { deregistrations } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|7d/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_deregistrations ?? null, null);
  });
});

describe("graphql — subnet_serving (#5715, Postgres-tier + zeroed-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_serving(netuid: 5) {
          schema_version netuid window observed_at
          distinct_servers announcements announcements_per_server
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_serving, {
      schema_version: 1,
      netuid: 5,
      window: "7d",
      observed_at: null,
      distinct_servers: 0,
      announcements: 0,
      announcements_per_server: null,
    });
  });

  test("resolves the Postgres-tier card for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          window: "30d",
          observed_at: "2026-07-01T00:00:00.000Z",
          distinct_servers: 3,
          announcements: 9,
          announcements_per_server: 3,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_serving(netuid: 5, window: "30d") {
          netuid window observed_at distinct_servers announcements announcements_per_server
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.subnet_serving;
    assert.equal(r.window, "30d");
    assert.equal(r.observed_at, "2026-07-01T00:00:00.000Z");
    assert.equal(r.distinct_servers, 3);
    assert.equal(r.announcements, 9);
    assert.equal(r.announcements_per_server, 3);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_serving(netuid: 9, window: "30d") {
          schema_version netuid window observed_at distinct_servers announcements announcements_per_server
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_serving, {
      schema_version: 1,
      netuid: 9,
      window: "30d",
      observed_at: null,
      distinct_servers: 0,
      announcements: 0,
      announcements_per_server: null,
    });
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ subnet_serving(netuid: 5, window: "99d") { announcements } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|7d/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_serving ?? null, null);
  });
});

describe("graphql — subnet_health_incidents (#5884, Postgres-tier + D1-live fallback)", () => {
  const NETUID = 3;

  function incidentsQuery(argsClause) {
    return `{ subnet_health_incidents${argsClause} {
      schema_version netuid window observed_at source surfaces
    } }`;
  }

  test("cold store: schema-stable empty surfaces via the D1-live loader", async () => {
    const { status, body } = await gql(incidentsQuery(`(netuid: ${NETUID})`));
    assert.equal(status, 200);
    const d = body.data.subnet_health_incidents;
    assert.equal(d.schema_version, 1);
    assert.equal(d.netuid, NETUID);
    assert.equal(d.window, "7d");
    assert.equal(d.observed_at, null);
    assert.equal(d.source, "live-cron-prober");
    assert.deepEqual(d.surfaces, []);
  });

  test("resolves Postgres-tier data, forwarding netuid in the path + window param", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            netuid: NETUID,
            window: "30d",
            observed_at: "2026-07-10T00:00:00.000Z",
            source: "live-cron-prober",
            surfaces: [
              {
                surface_id: "srf-1",
                samples: 100,
                uptime_ratio: 0.98,
                incident_count: 1,
                downtime_ms: 60000,
                incidents: [
                  {
                    started_at: 1000,
                    ended_at: 61000,
                    duration_ms: 60000,
                    failed_samples: 3,
                  },
                ],
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      incidentsQuery(`(netuid: ${NETUID}, window: "30d")`),
      env,
    );
    assert.equal(status, 200);
    assert.equal(
      capturedUrl.pathname,
      `/api/v1/subnets/${NETUID}/health/incidents`,
    );
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    const d = body.data.subnet_health_incidents;
    assert.equal(d.window, "30d");
    const s = d.surfaces[0];
    assert.equal(s.surface_id, "srf-1");
    assert.equal(s.uptime_ratio, 0.98);
    assert.equal(s.incident_count, 1);
    assert.equal(s.incidents[0].duration_ms, 60000);
    assert.equal(s.incidents[0].failed_samples, 3);
  });

  test("an empty Postgres-tier body degrades to schema-stable defaults with empty surfaces", async () => {
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      incidentsQuery(`(netuid: ${NETUID})`),
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_health_incidents, {
      schema_version: 1,
      netuid: NETUID,
      window: "7d",
      observed_at: null,
      source: null,
      surfaces: [],
    });
  });

  test("rejects an unsupported window with BAD_USER_INPUT", async () => {
    const { body } = await gql(
      incidentsQuery(`(netuid: ${NETUID}, window: "99d")`),
    );
    assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
  });

  test("subnet_health_incidents is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_health_incidents, 5);
  });
});

describe("graphql — subnet_axon_removals (#5718, Postgres-tier + zeroed-card fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_axon_removals(netuid: 5) {
          schema_version netuid window observed_at
          distinct_removers removals removals_per_remover
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_axon_removals, {
      schema_version: 1,
      netuid: 5,
      window: "7d",
      observed_at: null,
      distinct_removers: 0,
      removals: 0,
      removals_per_remover: null,
    });
  });

  test("resolves the Postgres-tier card for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          netuid: 5,
          window: "30d",
          observed_at: "2026-07-01T00:00:00.000Z",
          distinct_removers: 2,
          removals: 5,
          removals_per_remover: 2.5,
        }),
      ),
    };
    const { status, body } = await gql(
      `{ subnet_axon_removals(netuid: 5, window: "30d") {
          netuid window observed_at distinct_removers removals removals_per_remover
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.subnet_axon_removals;
    assert.equal(r.window, "30d");
    assert.equal(r.observed_at, "2026-07-01T00:00:00.000Z");
    assert.equal(r.distinct_removers, 2);
    assert.equal(r.removals, 5);
    assert.equal(r.removals_per_remover, 2.5);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ subnet_axon_removals(netuid: 9, window: "30d") {
          schema_version netuid window observed_at distinct_removers removals removals_per_remover
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_axon_removals, {
      schema_version: 1,
      netuid: 9,
      window: "30d",
      observed_at: null,
      distinct_removers: 0,
      removals: 0,
      removals_per_remover: null,
    });
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ subnet_axon_removals(netuid: 5, window: "99d") { removals } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|7d/i.test(body.errors[0].message));
    assert.equal(body.data?.subnet_axon_removals ?? null, null);
  });
});

describe("graphql — account_registrations (#5704, Postgres-tier + zeroed-card fallback)", () => {
  const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ account_registrations(ss58: "${SS58}") {
          schema_version address window total_registrations subnet_count
          concentration dominant_netuid subnets { netuid registrations }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_registrations, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_registrations: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("resolves the Postgres-tier { data } envelope, mapping the per-subnet footprint", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          data: {
            schema_version: 1,
            address: SS58,
            window: "90d",
            total_registrations: 7,
            subnet_count: 2,
            concentration: 0.63,
            dominant_netuid: 1,
            subnets: [
              {
                netuid: 1,
                registrations: 5,
                first_registered_at: "2026-04-01T00:00:00.000Z",
                last_registered_at: "2026-06-01T00:00:00.000Z",
              },
              { netuid: 2, registrations: 2 },
            ],
          },
          generatedAt: "2026-06-01T00:00:00.000Z",
        }),
      ),
    };
    const { status, body } = await gql(
      `{ account_registrations(ss58: "${SS58}", window: "90d") {
          address window total_registrations subnet_count concentration dominant_netuid
          subnets { netuid registrations first_registered_at last_registered_at }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.account_registrations;
    assert.equal(r.window, "90d");
    assert.equal(r.total_registrations, 7);
    assert.equal(r.subnet_count, 2);
    assert.equal(r.concentration, 0.63);
    assert.equal(r.dominant_netuid, 1);
    assert.deepEqual(r.subnets, [
      {
        netuid: 1,
        registrations: 5,
        first_registered_at: "2026-04-01T00:00:00.000Z",
        last_registered_at: "2026-06-01T00:00:00.000Z",
      },
      {
        netuid: 2,
        registrations: 2,
        first_registered_at: null,
        last_registered_at: null,
      },
    ]);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({ data: {} })),
    };
    const { status, body } = await gql(
      `{ account_registrations(ss58: "${SS58}", window: "7d") {
          schema_version address window total_registrations subnet_count
          concentration dominant_netuid subnets { netuid }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_registrations, {
      schema_version: 1,
      address: SS58,
      window: "7d",
      total_registrations: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("a malformed ss58 address is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ account_registrations(ss58: "not-an-address") { total_registrations } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/ss58/i.test(body.errors[0].message));
    assert.equal(body.data?.account_registrations ?? null, null);
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      `{ account_registrations(ss58: "${SS58}", window: "99d") { total_registrations } }`,
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|30d/i.test(body.errors[0].message));
    assert.equal(body.data?.account_registrations ?? null, null);
  });
});

describe("graphql — account_deregistrations (#5701, Postgres-tier + zeroed-card fallback)", () => {
  const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ account_deregistrations(ss58: "${SS58}") {
          schema_version address window total_deregistrations subnet_count
          concentration dominant_netuid subnets { netuid deregistrations }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_deregistrations, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_deregistrations: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("resolves the Postgres-tier { data } envelope, mapping the per-subnet footprint", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          data: {
            schema_version: 1,
            address: SS58,
            window: "90d",
            total_deregistrations: 4,
            subnet_count: 2,
            concentration: 0.55,
            dominant_netuid: 3,
            subnets: [
              {
                netuid: 3,
                deregistrations: 3,
                first_deregistered_at: "2026-04-01T00:00:00.000Z",
                last_deregistered_at: "2026-06-01T00:00:00.000Z",
              },
              { netuid: 7, deregistrations: 1 },
            ],
          },
          generatedAt: "2026-06-01T00:00:00.000Z",
        }),
      ),
    };
    const { status, body } = await gql(
      `{ account_deregistrations(ss58: "${SS58}", window: "90d") {
          address window total_deregistrations subnet_count concentration dominant_netuid
          subnets { netuid deregistrations first_deregistered_at last_deregistered_at }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.account_deregistrations;
    assert.equal(r.window, "90d");
    assert.equal(r.total_deregistrations, 4);
    assert.equal(r.subnet_count, 2);
    assert.equal(r.concentration, 0.55);
    assert.equal(r.dominant_netuid, 3);
    assert.deepEqual(r.subnets, [
      {
        netuid: 3,
        deregistrations: 3,
        first_deregistered_at: "2026-04-01T00:00:00.000Z",
        last_deregistered_at: "2026-06-01T00:00:00.000Z",
      },
      {
        netuid: 7,
        deregistrations: 1,
        first_deregistered_at: null,
        last_deregistered_at: null,
      },
    ]);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({ data: {} })),
    };
    const { status, body } = await gql(
      `{ account_deregistrations(ss58: "${SS58}", window: "7d") {
          schema_version address window total_deregistrations subnet_count
          concentration dominant_netuid subnets { netuid }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_deregistrations, {
      schema_version: 1,
      address: SS58,
      window: "7d",
      total_deregistrations: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("a malformed ss58 address is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ account_deregistrations(ss58: "not-an-address") { total_deregistrations } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/ss58/i.test(body.errors[0].message));
    assert.equal(body.data?.account_deregistrations ?? null, null);
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      `{ account_deregistrations(ss58: "${SS58}", window: "99d") { total_deregistrations } }`,
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|30d/i.test(body.errors[0].message));
    assert.equal(body.data?.account_deregistrations ?? null, null);
  });
});

describe("graphql — account_serving (#5705, Postgres-tier + zeroed-card fallback)", () => {
  const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ account_serving(ss58: "${SS58}") {
          schema_version address window total_announcements subnet_count
          concentration dominant_netuid subnets { netuid announcements }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_serving, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_announcements: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("resolves the Postgres-tier { data } envelope, mapping the per-subnet footprint", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          data: {
            schema_version: 1,
            address: SS58,
            window: "90d",
            total_announcements: 8,
            subnet_count: 2,
            concentration: 0.68,
            dominant_netuid: 4,
            subnets: [
              {
                netuid: 4,
                announcements: 6,
                first_served_at: "2026-04-01T00:00:00.000Z",
                last_served_at: "2026-06-01T00:00:00.000Z",
              },
              { netuid: 9, announcements: 2 },
            ],
          },
          generatedAt: "2026-06-01T00:00:00.000Z",
        }),
      ),
    };
    const { status, body } = await gql(
      `{ account_serving(ss58: "${SS58}", window: "90d") {
          address window total_announcements subnet_count concentration dominant_netuid
          subnets { netuid announcements first_served_at last_served_at }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.account_serving;
    assert.equal(r.window, "90d");
    assert.equal(r.total_announcements, 8);
    assert.equal(r.subnet_count, 2);
    assert.equal(r.concentration, 0.68);
    assert.equal(r.dominant_netuid, 4);
    assert.deepEqual(r.subnets, [
      {
        netuid: 4,
        announcements: 6,
        first_served_at: "2026-04-01T00:00:00.000Z",
        last_served_at: "2026-06-01T00:00:00.000Z",
      },
      {
        netuid: 9,
        announcements: 2,
        first_served_at: null,
        last_served_at: null,
      },
    ]);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({ data: {} })),
    };
    const { status, body } = await gql(
      `{ account_serving(ss58: "${SS58}", window: "7d") {
          schema_version address window total_announcements subnet_count
          concentration dominant_netuid subnets { netuid }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_serving, {
      schema_version: 1,
      address: SS58,
      window: "7d",
      total_announcements: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("a malformed ss58 address is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ account_serving(ss58: "not-an-address") { total_announcements } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/ss58/i.test(body.errors[0].message));
    assert.equal(body.data?.account_serving ?? null, null);
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      `{ account_serving(ss58: "${SS58}", window: "99d") { total_announcements } }`,
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|30d/i.test(body.errors[0].message));
    assert.equal(body.data?.account_serving ?? null, null);
  });
});

describe("graphql — account_axon_removals (#5699, Postgres-tier + zeroed-card fallback)", () => {
  const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ account_axon_removals(ss58: "${SS58}") {
          schema_version address window total_removals subnet_count
          concentration dominant_netuid subnets { netuid removals }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_axon_removals, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_removals: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("resolves the Postgres-tier { data } envelope, mapping the per-subnet footprint", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          data: {
            schema_version: 1,
            address: SS58,
            window: "90d",
            total_removals: 5,
            subnet_count: 2,
            concentration: 0.72,
            dominant_netuid: 6,
            subnets: [
              {
                netuid: 6,
                removals: 4,
                first_removed_at: "2026-04-01T00:00:00.000Z",
                last_removed_at: "2026-06-01T00:00:00.000Z",
              },
              { netuid: 11, removals: 1 },
            ],
          },
          generatedAt: "2026-06-01T00:00:00.000Z",
        }),
      ),
    };
    const { status, body } = await gql(
      `{ account_axon_removals(ss58: "${SS58}", window: "90d") {
          address window total_removals subnet_count concentration dominant_netuid
          subnets { netuid removals first_removed_at last_removed_at }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.account_axon_removals;
    assert.equal(r.window, "90d");
    assert.equal(r.total_removals, 5);
    assert.equal(r.subnet_count, 2);
    assert.equal(r.concentration, 0.72);
    assert.equal(r.dominant_netuid, 6);
    assert.deepEqual(r.subnets, [
      {
        netuid: 6,
        removals: 4,
        first_removed_at: "2026-04-01T00:00:00.000Z",
        last_removed_at: "2026-06-01T00:00:00.000Z",
      },
      {
        netuid: 11,
        removals: 1,
        first_removed_at: null,
        last_removed_at: null,
      },
    ]);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({ data: {} })),
    };
    const { status, body } = await gql(
      `{ account_axon_removals(ss58: "${SS58}", window: "7d") {
          schema_version address window total_removals subnet_count
          concentration dominant_netuid subnets { netuid }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_axon_removals, {
      schema_version: 1,
      address: SS58,
      window: "7d",
      total_removals: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("a malformed ss58 address is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ account_axon_removals(ss58: "not-an-address") { total_removals } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/ss58/i.test(body.errors[0].message));
    assert.equal(body.data?.account_axon_removals ?? null, null);
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      `{ account_axon_removals(ss58: "${SS58}", window: "99d") { total_removals } }`,
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|30d/i.test(body.errors[0].message));
    assert.equal(body.data?.account_axon_removals ?? null, null);
  });
});

describe("graphql — account_stake_moves (#5707, Postgres-tier + zeroed-card fallback)", () => {
  const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ account_stake_moves(ss58: "${SS58}") {
          schema_version address window total_movements subnet_count
          concentration dominant_netuid subnets { netuid movements }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_stake_moves, {
      schema_version: 1,
      address: SS58,
      window: "30d",
      total_movements: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("resolves the Postgres-tier { data } envelope, mapping the per-subnet footprint", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          data: {
            schema_version: 1,
            address: SS58,
            window: "90d",
            total_movements: 6,
            subnet_count: 2,
            concentration: 0.61,
            dominant_netuid: 8,
            subnets: [
              {
                netuid: 8,
                movements: 5,
                first_moved_at: "2026-04-01T00:00:00.000Z",
                last_moved_at: "2026-06-01T00:00:00.000Z",
                price_tao_at_last_move: 0.042,
              },
              { netuid: 12, movements: 1 },
            ],
          },
          generatedAt: "2026-06-01T00:00:00.000Z",
        }),
      ),
    };
    const { status, body } = await gql(
      `{ account_stake_moves(ss58: "${SS58}", window: "90d") {
          address window total_movements subnet_count concentration dominant_netuid
          subnets { netuid movements first_moved_at last_moved_at price_tao_at_last_move }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.account_stake_moves;
    assert.equal(r.window, "90d");
    assert.equal(r.total_movements, 6);
    assert.equal(r.subnet_count, 2);
    assert.equal(r.concentration, 0.61);
    assert.equal(r.dominant_netuid, 8);
    assert.deepEqual(r.subnets, [
      {
        netuid: 8,
        movements: 5,
        first_moved_at: "2026-04-01T00:00:00.000Z",
        last_moved_at: "2026-06-01T00:00:00.000Z",
        price_tao_at_last_move: 0.042,
      },
      {
        netuid: 12,
        movements: 1,
        first_moved_at: null,
        last_moved_at: null,
        price_tao_at_last_move: null,
      },
    ]);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({ data: {} })),
    };
    const { status, body } = await gql(
      `{ account_stake_moves(ss58: "${SS58}", window: "7d") {
          schema_version address window total_movements subnet_count
          concentration dominant_netuid subnets { netuid }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_stake_moves, {
      schema_version: 1,
      address: SS58,
      window: "7d",
      total_movements: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("a malformed ss58 address is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ account_stake_moves(ss58: "not-an-address") { total_movements } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/ss58/i.test(body.errors[0].message));
    assert.equal(body.data?.account_stake_moves ?? null, null);
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      `{ account_stake_moves(ss58: "${SS58}", window: "99d") { total_movements } }`,
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|30d/i.test(body.errors[0].message));
    assert.equal(body.data?.account_stake_moves ?? null, null);
  });
});

describe("graphql — account_children / account_parents (#6976, live chain RPC via child-hotkey-delegation.mjs)", () => {
  const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
  const CHILD_SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

  function stubFetch(handler) {
    const orig = globalThis.fetch;
    globalThis.fetch = handler;
    return () => {
      globalThis.fetch = orig;
    };
  }

  for (const [field, cacheKeyPrefix, counterpartKey] of [
    ["account_children", "children", "child"],
    ["account_parents", "parents", "parent"],
  ]) {
    function query(argsClause) {
      return `{ ${field}${argsClause} {
        schema_version account queried_at
        subnets { netuid entries { ${counterpartKey} proportion proportion_fraction } }
      } }`;
    }

    test(`${field}: an invalid ss58 is BAD_USER_INPUT and never reaches the RPC`, async () => {
      let called = false;
      const restore = stubFetch(async () => {
        called = true;
        return { ok: false };
      });
      try {
        const { status, body } = await gql(query('(ss58: "not-an-address")'));
        assert.equal(status, 200);
        assert.equal(body.data[field], null);
        assert.ok(
          body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"),
        );
        assert.equal(called, false);
      } finally {
        restore();
      }
    });

    test(`${field}: subnets is null on an RPC failure, distinct from confirmed-empty`, async () => {
      const restore = stubFetch(async () => ({ ok: false }));
      try {
        const { status, body } = await gql(query(`(ss58: "${SS58}")`));
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        assert.equal(body.data[field].subnets, null);
      } finally {
        restore();
      }
    });

    test(`${field}: subnets:[] when the account genuinely has none, schema-stable`, async () => {
      const restore = stubFetch(async (_url, init) => {
        const parsedBody = JSON.parse(init.body);
        if (parsedBody.method === "state_getKeysPaged") {
          return { ok: true, json: async () => ({ result: [] }) };
        }
        throw new Error("should not reach state_getStorage");
      });
      try {
        const { status, body } = await gql(query(`(ss58: "${SS58}")`));
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        assert.deepEqual(body.data[field].subnets, []);
        assert.equal(body.data[field].account, SS58);
        assert.equal(body.data[field].schema_version, 1);
        assert.ok(body.data[field].queried_at);
      } finally {
        restore();
      }
    });

    test(`${field}: happy path resolves every field from a KV-cached payload`, async () => {
      const cached = {
        schema_version: 1,
        account: SS58,
        subnets: [
          {
            netuid: 3,
            entries: [
              {
                [counterpartKey]: CHILD_SS58,
                proportion: "9223372036854775807",
                proportion_fraction: 0.5,
              },
            ],
          },
        ],
        queried_at: "2026-07-19T00:00:00.000Z",
      };
      const env = fixtureEnv(
        {},
        { kv: { [`${cacheKeyPrefix}:${SS58}`]: cached } },
      );
      let fetchCalled = false;
      const restore = stubFetch(async () => {
        fetchCalled = true;
        return { ok: false };
      });
      try {
        const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        assert.deepEqual(body.data[field], cached);
        assert.equal(fetchCalled, false);
      } finally {
        restore();
      }
    });
  }

  test("account_children/account_parents are weighted at the live-RPC complexity", () => {
    assert.equal(FIELD_COMPLEXITY.account_children, 10);
    assert.equal(FIELD_COMPLEXITY.account_parents, 10);
  });
});

describe("graphql — account_weight_setters (#6976, Postgres-tier { data, generatedAt } + zeroed-card fallback)", () => {
  const SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function query(argsClause) {
    return `{ account_weight_setters${argsClause} {
      schema_version address window total_weight_sets subnet_count concentration dominant_netuid
      subnets { netuid weight_sets first_set_at last_set_at }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_weight_setters, {
      schema_version: 1,
      address: SS58,
      window: "7d",
      total_weight_sets: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("resolves the Postgres-tier footprint for the requested window", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            data: {
              schema_version: 1,
              address: SS58,
              window: "30d",
              total_weight_sets: 12,
              subnet_count: 2,
              concentration: 0.61,
              dominant_netuid: 5,
              subnets: [
                {
                  netuid: 5,
                  weight_sets: 9,
                  first_set_at: "2026-06-01T00:00:00.000Z",
                  last_set_at: "2026-07-01T00:00:00.000Z",
                },
                {
                  netuid: 11,
                  weight_sets: 3,
                  first_set_at: "2026-06-15T00:00:00.000Z",
                  last_set_at: "2026-06-20T00:00:00.000Z",
                },
              ],
            },
            generatedAt: "2026-07-01T00:00:00.000Z",
          }),
      },
    };
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", window: "30d")`),
      env,
    );
    assert.equal(status, 200);
    const r = body.data.account_weight_setters;
    assert.equal(r.window, "30d");
    assert.equal(r.total_weight_sets, 12);
    assert.equal(r.subnet_count, 2);
    assert.equal(r.concentration, 0.61);
    assert.equal(r.dominant_netuid, 5);
    assert.equal(r.subnets[0].netuid, 5);
    assert.equal(r.subnets[0].weight_sets, 9);
    assert.equal(r.subnets[1].netuid, 11);
  });

  test("window is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            data: { schema_version: 1, address: SS58, subnets: [] },
            generatedAt: null,
          });
        },
      },
    };
    await gql(query(`(ss58: "${SS58}", window: "30d")`), env);
    assert.equal(
      capturedUrl.pathname,
      `/api/v1/accounts/${SS58}/weight-setters`,
    );
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
  });

  test("a Postgres-tier body missing the data envelope degrades to a schema-stable zeroed card", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_weight_setters, {
      schema_version: 1,
      address: SS58,
      window: "7d",
      total_weight_sets: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("a partial data envelope degrades missing fields to their defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => Response.json({ data: {}, generatedAt: null }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_weight_setters, {
      schema_version: 1,
      address: SS58,
      window: "7d",
      total_weight_sets: 0,
      subnet_count: 0,
      concentration: null,
      dominant_netuid: null,
      subnets: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("an unsupported window is a GraphQL error, not a silent card", async () => {
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", window: "99d")`),
    );
    assert.equal(status, 200);
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/window|7d/i.test(body.errors[0].message));
    assert.equal(body.data, null);
  });

  test("account_weight_setters is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_weight_setters, 5);
  });
});

describe("graphql — account_entities (#6976, R2 entity labels + Postgres-tier ownership-ties join)", () => {
  const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";
  const ENTITIES_ARTIFACT_PATH = "/metagraph/entities.json";

  function query(argsClause) {
    return `{ account_entities${argsClause} {
      schema_version ss58 ownership_tie_count
      labels { name category notes source_urls }
      ownership_ties { netuid role block_number observed_at }
    } }`;
  }

  test("cold store: no artifact, no Postgres flag resolves a schema-stable empty card, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_entities, {
      schema_version: 1,
      ss58: SS58,
      ownership_tie_count: 0,
      labels: [],
      ownership_ties: [],
    });
  });

  test("joins a populated entities.json artifact's labels for this ss58", async () => {
    const env = fixtureEnv({
      [ENTITIES_ARTIFACT_PATH]: {
        schema_version: 1,
        generated_at: null,
        entities: [
          {
            schema_version: 1,
            ss58: SS58,
            name: "Example Foundation",
            category: "foundation",
            notes: "Verified operator",
            source_urls: ["https://example.org/proof"],
            review: { state: "maintainer-reviewed" },
          },
        ],
      },
    });
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_entities.labels, [
      {
        name: "Example Foundation",
        category: "foundation",
        notes: "Verified operator",
        source_urls: ["https://example.org/proof"],
      },
    ]);
  });

  test("resolves ownership ties from the Postgres tier", async () => {
    const env = {
      METAGRAPH_SUBNET_OWNERSHIP_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            ss58: SS58,
            labels: [],
            ownership_tie_count: 1,
            ownership_ties: [
              {
                netuid: 4,
                role: "gained_ownership",
                block_number: 123,
                observed_at: "2026-07-01T00:00:00.000Z",
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    const r = body.data.account_entities;
    assert.equal(r.ownership_tie_count, 1);
    assert.equal(r.ownership_ties[0].netuid, 4);
    assert.equal(r.ownership_ties[0].role, "gained_ownership");
    assert.equal(r.ownership_ties[0].block_number, 123);
  });

  test("a malformed Postgres-tier body degrades to a schema-stable empty ownership card", async () => {
    const env = {
      METAGRAPH_SUBNET_OWNERSHIP_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_entities, {
      schema_version: 1,
      ss58: SS58,
      ownership_tie_count: 0,
      labels: [],
      ownership_ties: [],
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the artifact or Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_SUBNET_OWNERSHIP_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query('(ss58: "not-a-valid-address")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("account_entities is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.account_entities, 5);
  });
});

describe("graphql — account_counterparties (#5893, Postgres-tier + retired-D1 zero card)", () => {
  const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
  const OTHER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zero list card, never null", async () => {
    const { status, body } = await gql(
      `{ account_counterparties(ss58: "${SS58}") {
          schema_version ss58 counterparty_count transfers_scanned scan_capped
          total_sent_tao total_received_tao
          counterparties { address sent_tao received_tao net_tao transfer_count last_block }
          relationship { counterparty }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_counterparties, {
      schema_version: 1,
      ss58: SS58,
      counterparty_count: 0,
      transfers_scanned: 0,
      scan_capped: false,
      total_sent_tao: 0,
      total_received_tao: 0,
      counterparties: [],
      relationship: null,
    });
  });

  test("resolves the Postgres-tier list envelope, mapping each ranked counterparty", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ss58: SS58,
          counterparty_count: 2,
          transfers_scanned: 7,
          scan_capped: false,
          total_sent_tao: 12.5,
          total_received_tao: 4.25,
          counterparties: [
            {
              address: OTHER,
              sent_tao: 10,
              received_tao: 4.25,
              net_tao: -5.75,
              transfer_count: 5,
              last_block: 4321,
            },
            {
              address: "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy",
              sent_tao: 2.5,
              received_tao: 0,
              net_tao: -2.5,
              transfer_count: 2,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ account_counterparties(ss58: "${SS58}", limit: 5) {
          ss58 counterparty_count transfers_scanned scan_capped
          total_sent_tao total_received_tao
          counterparties { address sent_tao received_tao net_tao transfer_count last_block }
          relationship { counterparty }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.account_counterparties;
    assert.equal(r.counterparty_count, 2);
    assert.equal(r.transfers_scanned, 7);
    assert.equal(r.total_sent_tao, 12.5);
    assert.equal(r.relationship, null);
    assert.deepEqual(r.counterparties, [
      {
        address: OTHER,
        sent_tao: 10,
        received_tao: 4.25,
        net_tao: -5.75,
        transfer_count: 5,
        last_block: 4321,
      },
      {
        address: "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy",
        sent_tao: 2.5,
        received_tao: 0,
        net_tao: -2.5,
        transfer_count: 2,
        last_block: null,
      },
    ]);
  });

  test("relationship mode: maps the Postgres-tier composite envelope with transfer evidence", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ss58: SS58,
          counterparty_count: 1,
          transfers_scanned: 3,
          scan_capped: false,
          total_sent_tao: 8,
          total_received_tao: 1,
          counterparties: [
            {
              address: OTHER,
              sent_tao: 8,
              received_tao: 1,
              net_tao: -7,
              transfer_count: 3,
              last_block: 900,
            },
          ],
          relationship: {
            schema_version: 1,
            ss58: SS58,
            counterparty: OTHER,
            transfer_count: 3,
            transfers_scanned: 3,
            scan_capped: false,
            total_sent_tao: 8,
            total_received_tao: 1,
            net_tao: -7,
            first_block: 700,
            last_block: 900,
            first_seen_at: "2026-05-01T00:00:00.000Z",
            last_seen_at: "2026-06-01T00:00:00.000Z",
            limit: 50,
            transfers: [
              {
                block_number: 900,
                event_index: 2,
                netuid: 0,
                from: SS58,
                to: OTHER,
                amount_tao: 5,
                direction: "sent",
                observed_at: "2026-06-01T00:00:00.000Z",
              },
            ],
          },
        }),
      ),
    };
    const { status, body } = await gql(
      `{ account_counterparties(ss58: "${SS58}", counterparty: "${OTHER}", limit: 50) {
          counterparty_count
          counterparties { address transfer_count }
          relationship {
            counterparty transfer_count net_tao first_block last_block
            first_seen_at last_seen_at limit
            transfers { block_number event_index netuid from to amount_tao direction observed_at }
          }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const r = body.data.account_counterparties;
    assert.equal(r.counterparty_count, 1);
    assert.deepEqual(r.counterparties, [{ address: OTHER, transfer_count: 3 }]);
    assert.equal(r.relationship.counterparty, OTHER);
    assert.equal(r.relationship.net_tao, -7);
    assert.equal(r.relationship.first_block, 700);
    assert.equal(r.relationship.limit, 50);
    assert.deepEqual(r.relationship.transfers, [
      {
        block_number: 900,
        event_index: 2,
        netuid: 0,
        from: SS58,
        to: OTHER,
        amount_tao: 5,
        direction: "sent",
        observed_at: "2026-06-01T00:00:00.000Z",
      },
    ]);
  });

  test("relationship mode cold store: a schema-stable empty relationship envelope, never null", async () => {
    const { status, body } = await gql(
      `{ account_counterparties(ss58: "${SS58}", counterparty: "${OTHER}") {
          counterparty_count
          counterparties { address }
          relationship { counterparty transfer_count scan_capped limit transfers { direction } }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.account_counterparties;
    assert.equal(r.counterparty_count, 0);
    assert.deepEqual(r.counterparties, []);
    assert.equal(r.relationship.counterparty, OTHER);
    assert.equal(r.relationship.transfer_count, 0);
    assert.equal(r.relationship.scan_capped, false);
    assert.equal(r.relationship.limit, 50);
    assert.deepEqual(r.relationship.transfers, []);
  });

  test("a partial Postgres-tier body degrades to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({ counterparties: [{ address: OTHER }] }),
      ),
    };
    const { status, body } = await gql(
      `{ account_counterparties(ss58: "${SS58}") {
          schema_version ss58 counterparty_count transfers_scanned scan_capped
          total_sent_tao total_received_tao
          counterparties { address sent_tao received_tao net_tao transfer_count last_block }
          relationship { counterparty }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_counterparties, {
      schema_version: 1,
      ss58: SS58,
      counterparty_count: 0,
      transfers_scanned: 0,
      scan_capped: false,
      total_sent_tao: 0,
      total_received_tao: 0,
      counterparties: [
        {
          address: OTHER,
          sent_tao: 0,
          received_tao: 0,
          net_tao: 0,
          transfer_count: 0,
          last_block: null,
        },
      ],
      relationship: null,
    });
  });

  test("a Postgres-tier body with no counterparties key degrades to an empty list, never null", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({ schema_version: 1 })),
    };
    const { status, body } = await gql(
      `{ account_counterparties(ss58: "${SS58}") {
          schema_version ss58 counterparty_count transfers_scanned scan_capped
          total_sent_tao total_received_tao
          counterparties { address }
          relationship { counterparty }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_counterparties, {
      schema_version: 1,
      ss58: SS58,
      counterparty_count: 0,
      transfers_scanned: 0,
      scan_capped: false,
      total_sent_tao: 0,
      total_received_tao: 0,
      counterparties: [],
      relationship: null,
    });
  });

  test("relationship mode: a bare relationship object degrades every field to the resolver's defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          counterparties: [{ address: OTHER }],
          relationship: {},
        }),
      ),
    };
    const { status, body } = await gql(
      `{ account_counterparties(ss58: "${SS58}", counterparty: "${OTHER}") {
          relationship {
            schema_version ss58 counterparty transfer_count transfers_scanned
            scan_capped total_sent_tao total_received_tao net_tao
            first_block last_block first_seen_at last_seen_at limit
            transfers { direction }
          }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_counterparties.relationship, {
      schema_version: 1,
      ss58: SS58,
      counterparty: OTHER,
      transfer_count: 0,
      transfers_scanned: 0,
      scan_capped: false,
      total_sent_tao: 0,
      total_received_tao: 0,
      net_tao: 0,
      first_block: null,
      last_block: null,
      first_seen_at: null,
      last_seen_at: null,
      limit: 0,
      transfers: [],
    });
  });

  test("relationship mode: a partial transfer row degrades its nullable fields, keeping the required direction", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          counterparties: [{ address: OTHER }],
          relationship: {
            counterparty: OTHER,
            transfers: [{ direction: "received" }],
          },
        }),
      ),
    };
    const { status, body } = await gql(
      `{ account_counterparties(ss58: "${SS58}", counterparty: "${OTHER}") {
          relationship {
            transfers { block_number event_index netuid from to amount_tao direction observed_at }
          }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_counterparties.relationship.transfers, [
      {
        block_number: null,
        event_index: null,
        netuid: null,
        from: null,
        to: null,
        amount_tao: 0,
        direction: "received",
        observed_at: null,
      },
    ]);
  });

  test("a malformed ss58 address is a GraphQL error, not a silent card", async () => {
    const { body } = await gql(
      '{ account_counterparties(ss58: "not-an-address") { counterparty_count } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/ss58/i.test(body.errors[0].message));
    assert.equal(body.data?.account_counterparties ?? null, null);
  });

  test("a malformed counterparty address is a GraphQL error", async () => {
    const { body } = await gql(
      `{ account_counterparties(ss58: "${SS58}", counterparty: "not-an-address") { counterparty_count } }`,
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/counterparty/i.test(body.errors[0].message));
    assert.equal(body.data?.account_counterparties ?? null, null);
  });

  test("a counterparty equal to ss58 is a GraphQL error", async () => {
    const { body } = await gql(
      `{ account_counterparties(ss58: "${SS58}", counterparty: "${SS58}") { counterparty_count } }`,
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/differ/i.test(body.errors[0].message));
    assert.equal(body.data?.account_counterparties ?? null, null);
  });

  test("account_counterparties is weighted as a relationship field", () => {
    assert.equal(
      FIELD_COMPLEXITY.account_counterparties,
      FIELD_COMPLEXITY.account_identity_history,
    );
  });
});

describe("graphql — account_transfers (#5892, Postgres-tier flat feed)", () => {
  const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
  const OTHER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function dataApi(response, capture) {
    return {
      fetch: async (req) => {
        if (capture) capture.url = new URL(req.url);
        return response;
      },
    };
  }

  test("cold store: no Postgres flag returns a schema-stable empty feed, never null", async () => {
    const { status, body } = await gql(
      `{ account_transfers(ss58: "${SS58}") {
          schema_version ss58 transfer_count limit offset next_cursor
          transfers { block_number event_index from to amount_tao direction observed_at }
        } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_transfers, {
      schema_version: 1,
      ss58: SS58,
      transfer_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      transfers: [],
    });
  });

  test("resolves the flat Postgres-tier envelope, mapping each transfer's fields", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ss58: SS58,
          transfer_count: 1,
          limit: 50,
          offset: 0,
          next_cursor: "b:1200:3",
          transfers: [
            {
              block_number: 1200,
              event_index: 3,
              from: SS58,
              to: OTHER,
              amount_tao: 1.5,
              direction: "sent",
              observed_at: "2026-07-15T00:00:00.000Z",
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ account_transfers(ss58: "${SS58}") {
          schema_version ss58 transfer_count limit offset next_cursor
          transfers { block_number event_index from to amount_tao direction observed_at }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_transfers, {
      schema_version: 1,
      ss58: SS58,
      transfer_count: 1,
      limit: 50,
      offset: 0,
      next_cursor: "b:1200:3",
      transfers: [
        {
          block_number: 1200,
          event_index: 3,
          from: SS58,
          to: OTHER,
          amount_tao: 1.5,
          direction: "sent",
          observed_at: "2026-07-15T00:00:00.000Z",
        },
      ],
    });
  });

  test("hits /api/v1/accounts/{ss58}/transfers and forwards every filter", async () => {
    const capture = {};
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ss58: SS58,
          transfer_count: 0,
          limit: 5,
          offset: 2,
          next_cursor: null,
          transfers: [],
        }),
        capture,
      ),
    };
    const { status } = await gql(
      `{ account_transfers(ss58: "${SS58}", limit: 5, offset: 2, cursor: "c:9:1", direction: "received", block_start: 10, block_end: 20) { transfer_count } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(capture.url.pathname, `/api/v1/accounts/${SS58}/transfers`);
    assert.equal(capture.url.searchParams.get("limit"), "5");
    assert.equal(capture.url.searchParams.get("offset"), "2");
    assert.equal(capture.url.searchParams.get("cursor"), "c:9:1");
    assert.equal(capture.url.searchParams.get("direction"), "received");
    assert.equal(capture.url.searchParams.get("block_start"), "10");
    assert.equal(capture.url.searchParams.get("block_end"), "20");
  });

  test("clamps limit/offset to FEED_PAGINATION bounds before forwarding", async () => {
    const capture = {};
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({}), capture),
    };
    await gql(
      `{ account_transfers(ss58: "${SS58}", limit: 100000, offset: -5) { transfer_count } }`,
      env,
    );
    const forwardedLimit = Number(capture.url.searchParams.get("limit"));
    const forwardedOffset = Number(capture.url.searchParams.get("offset"));
    assert.ok(forwardedLimit > 0 && forwardedLimit < 100000);
    assert.equal(forwardedOffset, 0);
    // No filter params were supplied, so none are forwarded.
    assert.equal(capture.url.searchParams.get("cursor"), null);
    assert.equal(capture.url.searchParams.get("direction"), null);
    assert.equal(capture.url.searchParams.get("block_start"), null);
    assert.equal(capture.url.searchParams.get("block_end"), null);
  });

  test("a partial tier envelope degrades missing scalars to schema-stable defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ account_transfers(ss58: "${SS58}") {
          schema_version ss58 transfer_count limit offset next_cursor transfers { from }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_transfers, {
      schema_version: 1,
      ss58: SS58,
      transfer_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      transfers: [],
    });
  });

  test("a transfer row with missing fields degrades each to null", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ss58: SS58,
          transfer_count: 1,
          next_cursor: null,
          transfers: [{}],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ account_transfers(ss58: "${SS58}") {
          transfers { block_number event_index from to amount_tao direction observed_at }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_transfers.transfers, [
      {
        block_number: null,
        event_index: null,
        from: null,
        to: null,
        amount_tao: null,
        direction: null,
        observed_at: null,
      },
    ]);
  });

  test("an invalid ss58 is a GraphQL error and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { body } = await gql(
      '{ account_transfers(ss58: "not-an-address") { transfer_count } }',
      env,
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/ss58/i.test(body.errors[0].message));
    assert.equal(body.data?.account_transfers ?? null, null);
    assert.equal(called, false);
  });

  test("account_transfers is weighted as a relationship field", () => {
    assert.equal(
      FIELD_COMPLEXITY.account_transfers,
      FIELD_COMPLEXITY.account_identity_history,
    );
  });
});

describe("graphql — account_events (#5890, Postgres-tier hotkey/coldkey feed)", () => {
  const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
  const OTHER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function dataApi(response, capture) {
    return {
      fetch: async (req) => {
        if (capture) capture.url = new URL(req.url);
        return response;
      },
    };
  }

  function query(argsClause) {
    return `{ account_events${argsClause} {
      schema_version ss58 event_count limit offset next_cursor
      events { block_number event_index event_kind hotkey coldkey netuid uid amount_tao alpha_amount observed_at extrinsic_index }
    } }`;
  }

  test("cold store: no Postgres flag returns a schema-stable empty feed, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_events, {
      schema_version: 1,
      ss58: SS58,
      event_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      events: [],
    });
  });

  test("resolves the Postgres-tier envelope, mapping each event's fields", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ss58: SS58,
          event_count: 1,
          limit: 50,
          offset: 0,
          next_cursor: "b:1200:3",
          events: [
            {
              block_number: 1200,
              event_index: 3,
              event_kind: "StakeAdded",
              hotkey: SS58,
              coldkey: OTHER,
              netuid: 7,
              uid: 42,
              amount_tao: 1.5,
              alpha_amount: 2.25,
              observed_at: "2026-07-15T00:00:00.000Z",
              extrinsic_index: 4,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_events, {
      schema_version: 1,
      ss58: SS58,
      event_count: 1,
      limit: 50,
      offset: 0,
      next_cursor: "b:1200:3",
      events: [
        {
          block_number: 1200,
          event_index: 3,
          event_kind: "StakeAdded",
          hotkey: SS58,
          coldkey: OTHER,
          netuid: 7,
          uid: 42,
          amount_tao: 1.5,
          alpha_amount: 2.25,
          observed_at: "2026-07-15T00:00:00.000Z",
          extrinsic_index: 4,
        },
      ],
    });
  });

  test("hits /api/v1/accounts/{ss58}/events and forwards every filter", async () => {
    const capture = {};
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ss58: SS58,
          event_count: 0,
          limit: 5,
          offset: 2,
          next_cursor: null,
          events: [],
        }),
        capture,
      ),
    };
    const { status } = await gql(
      query(
        `(ss58: "${SS58}", kind: "StakeAdded", netuid: 7, block_start: 10, block_end: 20, limit: 5, offset: 2, cursor: "c:9:1")`,
      ),
      env,
    );
    assert.equal(status, 200);
    assert.equal(capture.url.pathname, `/api/v1/accounts/${SS58}/events`);
    assert.equal(capture.url.searchParams.get("limit"), "5");
    assert.equal(capture.url.searchParams.get("offset"), "2");
    assert.equal(capture.url.searchParams.get("kind"), "StakeAdded");
    assert.equal(capture.url.searchParams.get("netuid"), "7");
    assert.equal(capture.url.searchParams.get("cursor"), "c:9:1");
    assert.equal(capture.url.searchParams.get("block_start"), "10");
    assert.equal(capture.url.searchParams.get("block_end"), "20");
  });

  test("clamps limit/offset to FEED_PAGINATION bounds and omits absent filters", async () => {
    const capture = {};
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({}), capture),
    };
    await gql(query(`(ss58: "${SS58}", limit: 100000, offset: -5)`), env);
    const forwardedLimit = Number(capture.url.searchParams.get("limit"));
    const forwardedOffset = Number(capture.url.searchParams.get("offset"));
    assert.ok(forwardedLimit > 0 && forwardedLimit < 100000);
    assert.equal(forwardedOffset, 0);
    // No filter params were supplied, so none are forwarded.
    assert.equal(capture.url.searchParams.get("kind"), null);
    assert.equal(capture.url.searchParams.get("netuid"), null);
    assert.equal(capture.url.searchParams.get("cursor"), null);
    assert.equal(capture.url.searchParams.get("block_start"), null);
    assert.equal(capture.url.searchParams.get("block_end"), null);
  });

  test("a partial tier envelope degrades missing scalars to schema-stable defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_events, {
      schema_version: 1,
      ss58: SS58,
      event_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      events: [],
    });
  });

  test("an event row with missing fields degrades each to null", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ss58: SS58,
          event_count: 1,
          next_cursor: null,
          events: [{}],
        }),
      ),
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_events.events, [
      {
        block_number: null,
        event_index: null,
        event_kind: null,
        hotkey: null,
        coldkey: null,
        netuid: null,
        uid: null,
        amount_tao: null,
        alpha_amount: null,
        observed_at: null,
        extrinsic_index: null,
      },
    ]);
  });

  test("an invalid ss58 is a GraphQL error and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { body } = await gql(query('(ss58: "not-an-address")'), env);
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/ss58/i.test(body.errors[0].message));
    assert.equal(body.data?.account_events ?? null, null);
    assert.equal(called, false);
  });

  test("account_events is weighted as a relationship field", () => {
    assert.equal(
      FIELD_COMPLEXITY.account_events,
      FIELD_COMPLEXITY.account_transfers,
    );
  });
});

describe("graphql — account_history (#5888, Postgres-tier + D1 loadAccountHistory fallback)", () => {
  const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

  function dataApi(response, capture) {
    return {
      fetch: async (req) => {
        if (capture) capture.url = new URL(req.url);
        return response;
      },
    };
  }

  function query(argsClause) {
    return `{ account_history${argsClause} {
      schema_version ss58 day_count limit offset next_cursor
      days { day netuid event_count event_kinds first_block last_block }
    } }`;
  }

  // #6353: from/to were declared as plain String and forwarded unvalidated. On
  // a Postgres-tier miss loadAccountHistory binds them straight into
  // `day >= ?` / `day <= ?` against a TEXT column, so a malformed bound
  // silently produced an empty series instead of an error -- while REST
  // (parseDateRange) and MCP (optionalDayArg) both rejected it.
  test("a malformed from is BAD_USER_INPUT, not a silently empty series", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", from: "not-a-date")`),
      env,
    );
    assert.equal(status, 200);
    const err = body.errors.find(
      (e) => e.extensions?.code === "BAD_USER_INPUT",
    );
    assert.ok(err, "expected a BAD_USER_INPUT error");
    // The same message REST's parseDateRange and MCP's optionalDayArg emit.
    assert.equal(err.message, "from/to must be YYYY-MM-DD dates.");
    assert.equal(body.data, null);
    assert.equal(called, false, "must not reach the tier");
  });

  test("a malformed to is BAD_USER_INPUT even when from is valid", async () => {
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", from: "2026-07-01", to: "07/16/2026")`),
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
  });

  test("a date-shaped but non-YYYY-MM-DD bound is still rejected", async () => {
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", from: "2026-7-1")`),
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });

  test("well-formed from/to bounds are accepted and forwarded to the tier", async () => {
    const capture = {};
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({ days: [] }), capture),
    };
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", from: "2026-07-01", to: "2026-07-16")`),
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(capture.url.searchParams.get("from"), "2026-07-01");
    assert.equal(capture.url.searchParams.get("to"), "2026-07-16");
  });

  // The regression the issue describes predates D1 elimination (2026-07-17):
  // with a D1 tier available, a bad bound used to reach `day >= ?` and return
  // days: [] rather than erroring. D1 is never queried at all now, so this
  // just confirms validation still runs before any tier lookup.
  test("a malformed bound is rejected before any tier lookup, D1 never queried", async () => {
    let prepared = false;
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare: () => {
          prepared = true;
          return { bind: () => ({ all: async () => ({ results: [] }) }) };
        },
      },
    };
    const { status, body } = await gql(
      query(`(ss58: "${SS58}", to: "not-a-date")`),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(prepared, false, "must not reach D1");
  });

  test("cold store: no Postgres flag returns a schema-stable empty series, never null", async () => {
    const { status, body } = await gql(query(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_history, {
      schema_version: 1,
      ss58: SS58,
      day_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      days: [],
    });
  });

  test("resolves the Postgres-tier envelope, mapping each day's fields", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ss58: SS58,
          day_count: 1,
          limit: 50,
          offset: 0,
          next_cursor: "c:20260625:7",
          days: [
            {
              day: "2026-06-25",
              netuid: 7,
              event_count: 3,
              event_kinds: ["StakeAdded", "WeightsSet"],
              first_block: 1000,
              last_block: 1200,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_history, {
      schema_version: 1,
      ss58: SS58,
      day_count: 1,
      limit: 50,
      offset: 0,
      next_cursor: "c:20260625:7",
      days: [
        {
          day: "2026-06-25",
          netuid: 7,
          event_count: 3,
          event_kinds: ["StakeAdded", "WeightsSet"],
          first_block: 1000,
          last_block: 1200,
        },
      ],
    });
  });

  test("hits /api/v1/accounts/{ss58}/history and forwards every filter", async () => {
    const capture = {};
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          ss58: SS58,
          day_count: 0,
          limit: 5,
          offset: 2,
          next_cursor: null,
          days: [],
        }),
        capture,
      ),
    };
    const { status } = await gql(
      query(
        `(ss58: "${SS58}", netuid: 7, from: "2026-06-01", to: "2026-06-30", limit: 5, offset: 2, cursor: "c:20260615:3")`,
      ),
      env,
    );
    assert.equal(status, 200);
    assert.equal(capture.url.pathname, `/api/v1/accounts/${SS58}/history`);
    assert.equal(capture.url.searchParams.get("limit"), "5");
    assert.equal(capture.url.searchParams.get("offset"), "2");
    assert.equal(capture.url.searchParams.get("netuid"), "7");
    assert.equal(capture.url.searchParams.get("from"), "2026-06-01");
    assert.equal(capture.url.searchParams.get("to"), "2026-06-30");
    assert.equal(capture.url.searchParams.get("cursor"), "c:20260615:3");
  });

  test("clamps limit/offset to FEED_PAGINATION bounds and omits absent filters", async () => {
    const capture = {};
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({}), capture),
    };
    await gql(query(`(ss58: "${SS58}", limit: 100000, offset: -5)`), env);
    const forwardedLimit = Number(capture.url.searchParams.get("limit"));
    const forwardedOffset = Number(capture.url.searchParams.get("offset"));
    assert.ok(forwardedLimit > 0 && forwardedLimit < 100000);
    assert.equal(forwardedOffset, 0);
    assert.equal(capture.url.searchParams.get("netuid"), null);
    assert.equal(capture.url.searchParams.get("from"), null);
    assert.equal(capture.url.searchParams.get("to"), null);
    assert.equal(capture.url.searchParams.get("cursor"), null);
  });

  test("a partial tier envelope degrades missing scalars to schema-stable defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_history, {
      schema_version: 1,
      ss58: SS58,
      day_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      days: [],
    });
  });

  test("a day row with missing fields degrades each to null / empty kinds", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: dataApi(Response.json({ days: [{}] })),
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_history.days, [
      {
        day: null,
        netuid: null,
        event_count: null,
        event_kinds: [],
        first_block: null,
        last_block: null,
      },
    ]);
  });

  // D1 fully eliminated (2026-07-17): loadAccountHistory (src/account-events.mjs)
  // now ignores its d1 argument entirely and always returns the empty shape --
  // even a "warm" D1 mock (real rows) must not change the response.
  test("no Postgres tier flag: never queries D1, returns a schema-stable empty series", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error(
            "D1 must not be queried -- account_history is retired",
          );
        },
      },
    };
    const { status, body } = await gql(query(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_history, {
      schema_version: 1,
      ss58: SS58,
      day_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      days: [],
    });
  });

  test("rejects a malformed ss58 before hitting the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { body } = await gql(query('(ss58: "not-an-address")'), env);
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/ss58/i.test(body.errors[0].message));
    assert.equal(body.data?.account_history ?? null, null);
    assert.equal(called, false);
  });

  test("account_history is weighted as a relationship field", () => {
    assert.equal(
      FIELD_COMPLEXITY.account_history,
      FIELD_COMPLEXITY.account_events,
    );
  });
});

describe("graphql — account_identity_history (#5709, Postgres-tier + D1-live fallback)", () => {
  const SS58 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";

  function historyQuery(argsClause) {
    return `{ account_identity_history${argsClause} {
      schema_version account entry_count limit offset next_cursor
      entries { observed_at name url github image discord description additional identity_hash }
    } }`;
  }

  // D1 fully eliminated (2026-07-17): account_identity_history is built
  // directly from an empty row set on a tier miss now
  // (buildAccountIdentityHistory([], ss58, { limit, offset, nextCursor: null })),
  // passing the raw (unclamped) GraphQL args straight through -- with no
  // args supplied, limit/offset resolve to null, not a clamped default.
  test("cold store, default args: schema-stable empty timeline, never null", async () => {
    const { status, body } = await gql(historyQuery(`(ss58: "${SS58}")`));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_identity_history, {
      schema_version: 1,
      account: SS58,
      entry_count: 0,
      limit: null,
      offset: null,
      next_cursor: null,
      entries: [],
    });
  });

  test("resolves Postgres-tier data as-is, forwarding limit/offset/cursor as query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            account: SS58,
            entry_count: 1,
            limit: 5,
            offset: 10,
            next_cursor: null,
            entries: [
              {
                observed_at: "2026-07-10T00:00:00.000Z",
                name: "Example",
                url: "https://example.com",
                github: "example",
                image: null,
                discord: null,
                description: null,
                additional: null,
                identity_hash: "abc123",
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      historyQuery(`(ss58: "${SS58}", limit: 5, offset: 10, cursor: "xyz")`),
      env,
    );
    assert.equal(status, 200);
    assert.equal(
      capturedUrl.pathname,
      `/api/v1/accounts/${SS58}/identity-history`,
    );
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(capturedUrl.searchParams.get("offset"), "10");
    assert.equal(capturedUrl.searchParams.get("cursor"), "xyz");
    assert.equal(body.data.account_identity_history.entry_count, 1);
    assert.equal(body.data.account_identity_history.entries[0].name, "Example");
    assert.equal(
      body.data.account_identity_history.entries[0].identity_hash,
      "abc123",
    );
  });

  test("a bare Postgres-tier response ({}) still resolves schema-stable defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(historyQuery(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_identity_history, {
      schema_version: 1,
      account: SS58,
      entry_count: 0,
      limit: null,
      offset: null,
      next_cursor: null,
      entries: [],
    });
  });

  test("an entry missing observed_at/name/identity_hash resolves those fields as null", async () => {
    const env = {
      METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({ entries: [{}] }) },
    };
    const { status, body } = await gql(historyQuery(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.account_identity_history.entries, [
      {
        observed_at: null,
        name: null,
        url: null,
        github: null,
        image: null,
        discord: null,
        description: null,
        additional: null,
        identity_hash: null,
      },
    ]);
  });

  // D1 fully eliminated (2026-07-17): account_identity_history's D1
  // write/read path is fully retired -- even a "warm" D1 mock (real rows)
  // must not change the response.
  test("no Postgres tier flag: never queries D1, returns a schema-stable empty timeline", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error(
            "D1 must not be queried -- account_identity_history is retired",
          );
        },
      },
    };
    const { status, body } = await gql(historyQuery(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.equal(body.data.account_identity_history.account, SS58);
    assert.equal(body.data.account_identity_history.entry_count, 0);
    assert.deepEqual(body.data.account_identity_history.entries, []);
  });

  test("a D1 query error degrades to a schema-stable empty timeline (no throw)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error("db unavailable");
        },
      },
    };
    const { status, body } = await gql(historyQuery(`(ss58: "${SS58}")`), env);
    assert.equal(status, 200);
    assert.equal(body.data.account_identity_history.entry_count, 0);
    assert.deepEqual(body.data.account_identity_history.entries, []);
  });

  test("an invalid ss58 is a GraphQL error, not a silent empty timeline", async () => {
    const { body } = await gql(historyQuery('(ss58: "not-an-address")'));
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/ss58/i.test(body.errors[0].message));
    assert.equal(body.data?.account_identity_history ?? null, null);
  });

  test("account_identity_history is weighted as a relationship field", () => {
    assert.equal(FIELD_COMPLEXITY.account_identity_history, 5);
  });
});

describe("graphql — economics_trends (#5663, Postgres-tier + D1-fallback time series)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag / no D1 rows returns a schema-stable empty series", async () => {
    const { status, body } = await gql(
      "{ economics_trends { schema_version window day_count days { snapshot_date } } }",
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.economics_trends, {
      schema_version: 1,
      window: "30d",
      day_count: 0,
      days: [],
    });
  });

  test("resolves Postgres-tier days when the tier flag is set", async () => {
    const env = {
      METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          window: "90d",
          day_count: 1,
          days: [
            {
              snapshot_date: "2026-07-01",
              subnet_count: 3,
              total_stake_tao: "1000.000000000",
              alpha_price_tao_weighted: 0.06,
              alpha_price_tao_median: 0.05,
              validator_count: 12,
              miner_count: 200,
              mean_emission_share: 0.02,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ economics_trends(window: "90d") {
          window day_count
          days { snapshot_date subnet_count total_stake_tao alpha_price_tao_weighted alpha_price_tao_median validator_count miner_count mean_emission_share }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.economics_trends.window, "90d");
    assert.equal(body.data.economics_trends.day_count, 1);
    const day = body.data.economics_trends.days[0];
    assert.equal(day.snapshot_date, "2026-07-01");
    assert.equal(day.subnet_count, 3);
    assert.equal(day.total_stake_tao, "1000.000000000");
    assert.equal(day.alpha_price_tao_weighted, 0.06);
    assert.equal(day.validator_count, 12);
    assert.equal(day.miner_count, 200);
    assert.equal(day.mean_emission_share, 0.02);
  });

  test("window is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            window: "7d",
            day_count: 0,
            days: [],
          });
        },
      },
    };
    await gql('{ economics_trends(window: "7d") { day_count } }', env);
    assert.equal(capturedUrl.pathname, "/api/v1/economics/trends");
    assert.equal(capturedUrl.searchParams.get("window"), "7d");
  });

  test("a malformed Postgres-tier body falls back to the D1 rollup (schema-stable empty on cold D1)", async () => {
    const env = {
      METAGRAPH_SUBNET_SNAPSHOTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(
      "{ economics_trends { day_count days { snapshot_date } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.economics_trends.day_count, 0);
    assert.deepEqual(body.data.economics_trends.days, []);
  });

  // D1 fully eliminated (2026-07-17): loadEconomicsTrends (src/economics-trends.mjs)
  // no longer takes a d1 argument and always returns the schema-stable empty
  // shape -- even a "warm" D1 mock (real rows) must not change the response.
  test("no Postgres tier flag: never queries D1, returns a schema-stable empty series", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error(
            "D1 must not be queried -- subnet_snapshots is retired",
          );
        },
      },
    };
    const { status, body } = await gql(
      `{ economics_trends(window: "7d") {
          window day_count days { snapshot_date total_stake_tao validator_count }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.economics_trends.window, "7d");
    assert.equal(body.data.economics_trends.day_count, 0);
    assert.deepEqual(body.data.economics_trends.days, []);
  });

  test("a D1 query error degrades to a schema-stable empty series (no throw)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error("db unavailable");
        },
      },
    };
    const { status, body } = await gql(
      "{ economics_trends { day_count days { snapshot_date } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.economics_trends.day_count, 0);
    assert.deepEqual(body.data.economics_trends.days, []);
  });

  test("an unsupported window is a GraphQL error, not a silently substituted default", async () => {
    const { status, body } = await gql(
      '{ economics_trends(window: "99d") { day_count } }',
    );
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.match(body.errors[0].message, /99d/);
  });

  test("economics_trends is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.economics_trends, 5);
  });
});

describe("graphql — subnet_movers (#5662, Postgres-tier + buildMovers fallback leaderboard)", () => {
  function moversQuery(argsClause) {
    return `{ subnet_movers${argsClause} {
      schema_version window start_date end_date sort subnet_count
      network {
        total_stake_start_tao total_stake_end_tao total_stake_delta_tao
        total_emission_start_tao total_emission_end_tao total_emission_delta_tao
        total_validators_start total_validators_end total_validators_delta
        gainers losers unchanged
      }
      movers { netuid stake_delta_tao emission_delta_tao validators_delta }
    } }`;
  }

  test("cold store, default args: schema-stable empty leaderboard", async () => {
    const { status, body } = await gql(moversQuery(""));
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_movers, {
      schema_version: 1,
      window: "30d",
      start_date: null,
      end_date: null,
      sort: "stake",
      subnet_count: 0,
      network: {
        total_stake_start_tao: "0.000000000",
        total_stake_end_tao: "0.000000000",
        total_stake_delta_tao: "0.000000000",
        total_emission_start_tao: "0.000000000",
        total_emission_end_tao: "0.000000000",
        total_emission_delta_tao: "0.000000000",
        total_validators_start: 0,
        total_validators_end: 0,
        total_validators_delta: 0,
        gainers: 0,
        losers: 0,
        unchanged: 0,
      },
      movers: [],
    });
  });

  test("resolves Postgres-tier movers for a valid non-default window/sort combination", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "7d",
            start_date: "2026-07-08",
            end_date: "2026-07-15",
            sort: "emission",
            subnet_count: 1,
            network: {
              total_stake_start_tao: "1000.000000000",
              total_stake_end_tao: "1200.000000000",
              total_stake_delta_tao: "200.000000000",
              total_emission_start_tao: "10.000000000",
              total_emission_end_tao: "12.000000000",
              total_emission_delta_tao: "2.000000000",
              total_validators_start: 5,
              total_validators_end: 6,
              total_validators_delta: 1,
              gainers: 1,
              losers: 0,
              unchanged: 0,
            },
            movers: [
              {
                netuid: 3,
                stake_start_tao: 1000,
                stake_end_tao: 1200,
                stake_delta_tao: 200,
                stake_pct_change: 20,
                stake_share_pct: 100,
                emission_start_tao: 10,
                emission_end_tao: 12,
                emission_delta_tao: 2,
                emission_pct_change: 20,
                emission_share_pct: 100,
                validators_start: 5,
                validators_end: 6,
                validators_delta: 1,
                neurons_start: 20,
                neurons_end: 21,
                neurons_delta: 1,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      moversQuery('(window: "7d", sort: "emission")'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/subnets/movers");
    assert.equal(capturedUrl.searchParams.get("window"), "7d");
    assert.equal(capturedUrl.searchParams.get("sort"), "emission");
    assert.equal(capturedUrl.searchParams.get("limit"), "20");
    assert.equal(body.data.subnet_movers.window, "7d");
    assert.equal(body.data.subnet_movers.sort, "emission");
    assert.equal(body.data.subnet_movers.subnet_count, 1);
    assert.equal(
      body.data.subnet_movers.network.total_stake_delta_tao,
      "200.000000000",
    );
    assert.equal(body.data.subnet_movers.movers.length, 1);
    assert.equal(body.data.subnet_movers.movers[0].netuid, 3);
    assert.equal(body.data.subnet_movers.movers[0].emission_delta_tao, 2);
  });

  test("a limit argument is forwarded as a query param to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({ schema_version: 1, movers: [] });
        },
      },
    };
    await gql(moversQuery("(limit: 5)"), env);
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
  });

  test("a malformed Postgres-tier body degrades to schema-stable defaults (no throw)", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(moversQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.data.subnet_movers.subnet_count, 0);
    assert.deepEqual(body.data.subnet_movers.movers, []);
    assert.equal(
      body.data.subnet_movers.network.total_stake_start_tao,
      "0.000000000",
    );
    assert.equal(body.data.subnet_movers.network.gainers, 0);
  });

  test("an unsupported window is a GraphQL error, not a silently substituted default", async () => {
    const { status, body } = await gql(moversQuery('(window: "1y")'));
    assert.equal(status, 200);
    assert.equal(body.data, null);
    const err = body.errors.find(
      (e) => e.extensions?.code === "BAD_USER_INPUT",
    );
    assert.ok(err);
    assert.match(err.message, /1y/);
  });

  test("an unsupported sort is a GraphQL error, not a silently substituted default", async () => {
    const { status, body } = await gql(moversQuery('(sort: "bogus")'));
    assert.equal(status, 200);
    assert.equal(body.data, null);
    const err = body.errors.find(
      (e) => e.extensions?.code === "BAD_USER_INPUT",
    );
    assert.ok(err);
    assert.match(err.message, /bogus/);
  });

  test("a limit above MOVERS_LIMIT_MAX is a GraphQL error, matching REST's exact rejection", async () => {
    const { status, body } = await gql(moversQuery("(limit: 101)"));
    assert.equal(status, 200);
    assert.equal(body.data, null);
    const err = body.errors.find(
      (e) => e.extensions?.code === "BAD_USER_INPUT",
    );
    assert.ok(err);
    assert.match(err.message, /1 to 100/);
  });

  test("a limit below 1 is a GraphQL error", async () => {
    const { status, body } = await gql(moversQuery("(limit: 0)"));
    assert.equal(status, 200);
    assert.equal(body.data, null);
    const err = body.errors.find(
      (e) => e.extensions?.code === "BAD_USER_INPUT",
    );
    assert.ok(err);
  });

  test("subnet_movers is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_movers, 5);
  });
});

describe("graphql — chain_turnover (#5686, Postgres-tier + cold-store fallback)", () => {
  function turnoverQuery(argsClause) {
    return `{ chain_turnover${argsClause} {
      schema_version window start_date end_date comparable subnet_count
      network { validators_start validators_end validators_entered validators_exited validator_retention stability_score }
      stability_distribution { count mean min p25 median p75 p90 max }
      subnets { netuid validators_start validators_end validators_entered validators_exited validator_retention stability_score }
    } }`;
  }

  test("cold store, default args: schema-stable non-comparable empty leaderboard", async () => {
    const { status, body } = await gql(turnoverQuery(""));
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_turnover, {
      schema_version: 1,
      window: "30d",
      start_date: null,
      end_date: null,
      comparable: false,
      subnet_count: 0,
      network: {
        validators_start: 0,
        validators_end: 0,
        validators_entered: 0,
        validators_exited: 0,
        validator_retention: null,
        stability_score: null,
      },
      stability_distribution: null,
      subnets: [],
    });
  });

  test("resolves Postgres-tier data for a valid non-default window/limit, forwarding both as query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "7d",
            start_date: "2026-07-03",
            end_date: "2026-07-10",
            comparable: true,
            subnet_count: 1,
            network: {
              validators_start: 10,
              validators_end: 12,
              validators_entered: 4,
              validators_exited: 2,
              validator_retention: 0.67,
              stability_score: 67,
            },
            stability_distribution: {
              count: 1,
              mean: 67,
              min: 67,
              p25: 67,
              median: 67,
              p75: 67,
              p90: 67,
              max: 67,
            },
            subnets: [
              {
                netuid: 3,
                validators_start: 10,
                validators_end: 12,
                validators_entered: 4,
                validators_exited: 2,
                validator_retention: 0.67,
                stability_score: 67,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      turnoverQuery('(window: "7d", limit: 5)'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/turnover");
    assert.equal(capturedUrl.searchParams.get("window"), "7d");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(body.data.chain_turnover.window, "7d");
    assert.equal(body.data.chain_turnover.comparable, true);
    assert.equal(body.data.chain_turnover.subnet_count, 1);
    assert.equal(body.data.chain_turnover.network.validators_entered, 4);
    assert.equal(body.data.chain_turnover.stability_distribution.median, 67);
    assert.equal(body.data.chain_turnover.subnets[0].netuid, 3);
  });

  test("a malformed Postgres-tier body falls back to schema-stable defaults (no throw)", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(turnoverQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_turnover.window, "30d");
    assert.equal(body.data.chain_turnover.comparable, false);
    assert.equal(body.data.chain_turnover.subnet_count, 0);
    assert.equal(body.data.chain_turnover.network.validators_start, 0);
    assert.equal(body.data.chain_turnover.network.validator_retention, null);
    assert.equal(body.data.chain_turnover.stability_distribution, null);
    assert.deepEqual(body.data.chain_turnover.subnets, []);
  });

  test("an unsupported window is a GraphQL error, not a silently substituted default", async () => {
    const { status, body } = await gql(turnoverQuery('(window: "99d")'));
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.match(body.errors[0].message, /99d/);
    assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
  });
});

describe("graphql — chain_weights (#5689, Postgres-tier + D1-live fallback)", () => {
  function weightsQuery(argsClause) {
    return `{ chain_weights${argsClause} {
      schema_version window observed_at subnet_count
      network { distinct_setters weight_sets sets_per_setter }
      intensity_distribution { count mean min p25 median p75 p90 max }
      subnets { netuid distinct_setters weight_sets sets_per_setter }
    } }`;
  }

  // The network aggregate (COUNT/COUNT DISTINCT/MAX(observed_at)) has no GROUP
  // BY; the per-subnet leaderboard is GROUP BY netuid -- same two-query shape
  // loadChainWeights always issues (mirrors the mcp-server.test.mjs fixture).
  function chainWeightsD1({ network, subnets = [] } = {}) {
    return {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes("GROUP BY netuid")) {
                  return { results: subnets };
                }
                return { results: network ? [network] : [] };
              },
            };
          },
        };
      },
    };
  }

  test("cold store, default args: schema-stable empty leaderboard", async () => {
    const { status, body } = await gql(weightsQuery(""));
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_weights, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      subnet_count: 0,
      network: { distinct_setters: 0, weight_sets: 0, sets_per_setter: null },
      intensity_distribution: null,
      subnets: [],
    });
  });

  test("resolves Postgres-tier data for a valid non-default window/limit, forwarding both as query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            observed_at: "2026-07-10T00:00:00.000Z",
            subnet_count: 1,
            network: {
              distinct_setters: 4,
              weight_sets: 40,
              sets_per_setter: 10,
            },
            intensity_distribution: {
              count: 1,
              mean: 10,
              min: 10,
              p25: 10,
              median: 10,
              p75: 10,
              p90: 10,
              max: 10,
            },
            subnets: [
              {
                netuid: 3,
                distinct_setters: 4,
                weight_sets: 40,
                sets_per_setter: 10,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      weightsQuery('(window: "30d", limit: 5)'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/weights");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(body.data.chain_weights.window, "30d");
    assert.equal(body.data.chain_weights.subnet_count, 1);
    assert.equal(body.data.chain_weights.network.weight_sets, 40);
    assert.equal(body.data.chain_weights.intensity_distribution.median, 10);
    assert.equal(body.data.chain_weights.subnets[0].netuid, 3);
  });

  test("a malformed Postgres-tier body falls back to schema-stable defaults (no throw)", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(weightsQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_weights.window, "7d");
    assert.equal(body.data.chain_weights.subnet_count, 0);
    assert.equal(body.data.chain_weights.network.weight_sets, 0);
    assert.equal(body.data.chain_weights.intensity_distribution, null);
    assert.deepEqual(body.data.chain_weights.subnets, []);
  });

  // #4772 D1 retirement: the `account_events` D1 table is dropped in
  // production, so this resolver no longer queries D1 at all -- even a
  // "warm" D1 mock (real rows) must not change the response.
  test("no Postgres tier flag: never queries D1, returns the schema-stable empty leaderboard (retired -- #4772)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: chainWeightsD1({
        network: {
          weight_sets: 40,
          distinct_setters: 4,
          newest_observed: 1_750_000_000_000,
        },
        subnets: [{ netuid: 3, weight_sets: 40, distinct_setters: 4 }],
      }),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      throw new Error("D1 must not be queried -- account_events is retired");
    };
    const { status, body } = await gql(weightsQuery('(window: "7d")'), env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_weights.window, "7d");
    assert.equal(body.data.chain_weights.subnet_count, 0);
    assert.deepEqual(body.data.chain_weights.subnets, []);
  });

  test("a D1 query error degrades to a schema-stable empty leaderboard (no throw)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error("db unavailable");
        },
      },
    };
    const { status, body } = await gql(weightsQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_weights.subnet_count, 0);
    assert.deepEqual(body.data.chain_weights.subnets, []);
  });

  test("an unsupported window is a GraphQL error, not a silently substituted default", async () => {
    const { status, body } = await gql(weightsQuery('(window: "99d")'));
    assert.equal(status, 200);
    assert.equal(body.data, null);
    const err = body.errors.find(
      (e) => e.extensions?.code === "BAD_USER_INPUT",
    );
    assert.ok(err);
    assert.match(err.message, /99d/);
  });

  test("chain_weights is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.chain_weights, 5);
  });
});

describe("graphql — chain_calls (#5880, Postgres-tier call-mix + cold-store fallback)", () => {
  function callsQuery(argsClause) {
    return `{ chain_calls${argsClause} {
      schema_version window group_by observed_at total_extrinsics call_count
      calls { call_module call_function count share }
    } }`;
  }

  test("cold store, default args: schema-stable empty breakdown (7d/module)", async () => {
    const { status, body } = await gql(callsQuery(""));
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_calls, {
      schema_version: 1,
      window: "7d",
      group_by: "module",
      observed_at: null,
      total_extrinsics: 0,
      call_count: 0,
      calls: [],
    });
  });

  test("resolves Postgres-tier call-mix rows", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            window: "30d",
            group_by: "module_function",
            observed_at: "2026-07-14T00:00:00.000Z",
            total_extrinsics: 8,
            call_count: 1,
            calls: [
              {
                call_module: "SubtensorModule",
                call_function: "set_weights",
                count: 6,
                share: 0.75,
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(
      callsQuery(`(window: "30d", group_by: "module_function")`),
      env,
    );
    assert.equal(status, 200);
    const d = body.data.chain_calls;
    assert.equal(d.window, "30d");
    assert.equal(d.group_by, "module_function");
    assert.equal(d.total_extrinsics, 8);
    assert.equal(d.call_count, 1);
    const c = d.calls[0];
    assert.equal(c.call_module, "SubtensorModule");
    assert.equal(c.call_function, "set_weights");
    assert.equal(c.count, 6);
    assert.equal(c.share, 0.75);
  });

  test("a partial Postgres-tier body degrades every missing field to its schema-stable default", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      // Only a row's call_module present; envelope + row omit the rest, so
      // every ?? default fallback must fire (not surface undefined).
      DATA_API: {
        fetch: async () =>
          Response.json({ calls: [{ call_module: "Balances" }] }),
      },
    };
    const { status, body } = await gql(callsQuery(""), env);
    assert.equal(status, 200);
    const d = body.data.chain_calls;
    assert.equal(d.schema_version, 1);
    assert.equal(d.window, "7d");
    assert.equal(d.group_by, "module");
    assert.equal(d.observed_at, null);
    assert.equal(d.total_extrinsics, 0);
    assert.equal(d.call_count, 0);
    const c = d.calls[0];
    assert.equal(c.call_module, "Balances");
    assert.equal(c.call_function, null);
    assert.equal(c.count, 0);
    assert.equal(c.share, null);
  });

  test("an empty Postgres-tier body (no calls key) degrades to a schema-stable empty breakdown", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(callsQuery(""), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_calls, {
      schema_version: 1,
      window: "7d",
      group_by: "module",
      observed_at: null,
      total_extrinsics: 0,
      call_count: 0,
      calls: [],
    });
  });

  test("window/group_by/limit/call_module args are forwarded to the /chain/calls path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            group_by: "module",
            total_extrinsics: 0,
            call_count: 0,
            calls: [],
          });
        },
      },
    };
    await gql(
      callsQuery(
        `(window: "30d", group_by: "module", limit: 5, call_module: "SubtensorModule")`,
      ),
      env,
    );
    assert.equal(capturedUrl.pathname, "/api/v1/chain/calls");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("group_by"), "module");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(
      capturedUrl.searchParams.get("call_module"),
      "SubtensorModule",
    );
  });

  test("rejects an unsupported window with BAD_USER_INPUT", async () => {
    const { body } = await gql(callsQuery(`(window: "99d")`));
    assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
  });

  test("rejects an unsupported group_by with BAD_USER_INPUT", async () => {
    const { body } = await gql(callsQuery(`(group_by: "signer")`));
    assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
  });

  test("rejects an over-long call_module with BAD_USER_INPUT", async () => {
    const { body } = await gql(
      callsQuery(`(call_module: "${"x".repeat(101)}")`),
    );
    assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
  });

  test("chain_calls is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.chain_calls, 5);
  });
});

describe("graphql — chain_activity (#5879, Postgres-tier activity series + cold-store fallback)", () => {
  function activityQuery(argsClause) {
    return `{ chain_activity${argsClause} {
      schema_version window observed_at day_count
      days { day block_count extrinsic_count event_count successful_extrinsics success_rate unique_signers }
    } }`;
  }

  test("cold store, default args: schema-stable empty series (7d)", async () => {
    const { status, body } = await gql(activityQuery(""));
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_activity, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      day_count: 0,
      days: [],
    });
  });

  test("resolves the Postgres-tier per-day series", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            window: "30d",
            observed_at: "2026-07-14T00:00:00.000Z",
            day_count: 1,
            days: [
              {
                day: "2026-07-14",
                block_count: 7,
                extrinsic_count: 4,
                event_count: 12,
                successful_extrinsics: 3,
                success_rate: 0.75,
                unique_signers: 2,
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(activityQuery(`(window: "30d")`), env);
    assert.equal(status, 200);
    const d = body.data.chain_activity;
    assert.equal(d.window, "30d");
    assert.equal(d.day_count, 1);
    assert.equal(d.days[0].day, "2026-07-14");
    assert.equal(d.days[0].block_count, 7);
    assert.equal(d.days[0].success_rate, 0.75);
    assert.equal(d.days[0].unique_signers, 2);
  });

  test("partial day rows degrade missing fields to their schema-stable defaults", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      // The day row carries only its required key; every other field is omitted
      // so the per-item ?? default fallbacks must fire.
      DATA_API: {
        fetch: async () => Response.json({ days: [{ day: "2026-07-14" }] }),
      },
    };
    const { status, body } = await gql(activityQuery(""), env);
    assert.equal(status, 200);
    const d = body.data.chain_activity;
    assert.equal(d.schema_version, 1);
    assert.equal(d.window, "7d");
    assert.equal(d.observed_at, null);
    assert.equal(d.day_count, 0);
    const day = d.days[0];
    assert.equal(day.block_count, 0);
    assert.equal(day.extrinsic_count, 0);
    assert.equal(day.event_count, 0);
    assert.equal(day.successful_extrinsics, 0);
    assert.equal(day.success_rate, null);
    assert.equal(day.unique_signers, 0);
  });

  test("an empty Postgres-tier body (no days key) degrades to an empty series", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(activityQuery(""), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_activity, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      day_count: 0,
      days: [],
    });
  });

  test("the window arg is forwarded to the /chain/activity path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            day_count: 0,
            days: [],
          });
        },
      },
    };
    await gql(activityQuery(`(window: "30d")`), env);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/activity");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
  });

  test("rejects an unsupported window with BAD_USER_INPUT", async () => {
    const { body } = await gql(activityQuery(`(window: "99d")`));
    assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
  });

  test("chain_activity is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.chain_activity, 5);
  });
});

describe("graphql — chain_fees (#5881, Postgres-tier fee series + cold-store fallback)", () => {
  function feesQuery(argsClause) {
    return `{ chain_fees${argsClause} {
      schema_version window observed_at day_count
      daily { day extrinsic_count total_fee_tao avg_fee_tao median_fee_tao total_tip_tao avg_tip_tao median_tip_tao }
      top_fee_payers { signer total_fee_tao total_tip_tao extrinsic_count }
    } }`;
  }

  test("cold store, default args: schema-stable empty series (7d)", async () => {
    const { status, body } = await gql(feesQuery(""));
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_fees, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      day_count: 0,
      daily: [],
      top_fee_payers: [],
    });
  });

  test("resolves Postgres-tier daily series + top payers", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () =>
          Response.json({
            schema_version: 1,
            window: "30d",
            observed_at: "2026-07-14T00:00:00.000Z",
            day_count: 1,
            daily: [
              {
                day: "2026-07-14",
                extrinsic_count: 4,
                total_fee_tao: 0.4,
                avg_fee_tao: 0.1,
                median_fee_tao: 0.1,
                total_tip_tao: 0.02,
                avg_tip_tao: 0.005,
                median_tip_tao: 0.004,
              },
            ],
            top_fee_payers: [
              {
                signer: "5Signer",
                total_fee_tao: 0.4,
                total_tip_tao: 0.02,
                extrinsic_count: 4,
              },
            ],
          }),
      },
    };
    const { status, body } = await gql(feesQuery(`(window: "30d")`), env);
    assert.equal(status, 200);
    const d = body.data.chain_fees;
    assert.equal(d.window, "30d");
    assert.equal(d.day_count, 1);
    assert.equal(d.daily[0].day, "2026-07-14");
    assert.equal(d.daily[0].total_fee_tao, 0.4);
    assert.equal(d.daily[0].median_tip_tao, 0.004);
    assert.equal(d.top_fee_payers[0].signer, "5Signer");
    assert.equal(d.top_fee_payers[0].extrinsic_count, 4);
  });

  test("partial rows in each list degrade missing fields to their schema-stable defaults", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      // Each row carries only its required key; every other field is omitted so
      // the per-item ?? default fallbacks (both lists) must fire.
      DATA_API: {
        fetch: async () =>
          Response.json({
            daily: [{ day: "2026-07-14" }],
            top_fee_payers: [{ signer: "5Signer" }],
          }),
      },
    };
    const { status, body } = await gql(feesQuery(""), env);
    assert.equal(status, 200);
    const d = body.data.chain_fees;
    assert.equal(d.schema_version, 1);
    assert.equal(d.window, "7d");
    assert.equal(d.observed_at, null);
    assert.equal(d.day_count, 0);
    const day = d.daily[0];
    assert.equal(day.extrinsic_count, 0);
    assert.equal(day.total_fee_tao, null);
    assert.equal(day.avg_fee_tao, null);
    assert.equal(day.median_fee_tao, null);
    assert.equal(day.total_tip_tao, null);
    assert.equal(day.avg_tip_tao, null);
    assert.equal(day.median_tip_tao, null);
    const payer = d.top_fee_payers[0];
    assert.equal(payer.total_fee_tao, null);
    assert.equal(payer.total_tip_tao, null);
    assert.equal(payer.extrinsic_count, 0);
  });

  test("an empty Postgres-tier body (no daily/top_fee_payers keys) degrades to empty lists", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(feesQuery(""), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_fees, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      day_count: 0,
      daily: [],
      top_fee_payers: [],
    });
  });

  test("window/limit/call_module args are forwarded to the /chain/fees path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            day_count: 0,
            daily: [],
            top_fee_payers: [],
          });
        },
      },
    };
    await gql(
      feesQuery(`(window: "30d", limit: 5, call_module: "Balances")`),
      env,
    );
    assert.equal(capturedUrl.pathname, "/api/v1/chain/fees");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(capturedUrl.searchParams.get("call_module"), "Balances");
  });

  test("rejects an unsupported window with BAD_USER_INPUT", async () => {
    const { body } = await gql(feesQuery(`(window: "99d")`));
    assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
  });

  test("rejects an over-long call_module with BAD_USER_INPUT", async () => {
    const { body } = await gql(
      feesQuery(`(call_module: "${"x".repeat(101)}")`),
    );
    assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
  });

  test("chain_fees is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.chain_fees, 5);
  });
});

describe("graphql — chain_serving (#5873, Postgres-tier + D1-live fallback)", () => {
  function servingQuery(argsClause) {
    return `{ chain_serving${argsClause} {
      schema_version window observed_at subnet_count
      network { distinct_servers announcements announcements_per_server }
      intensity_distribution { count mean min p25 median p75 p90 max }
      subnets { netuid distinct_servers announcements announcements_per_server }
    } }`;
  }

  // The network aggregate (COUNT DISTINCT hotkey / MAX(observed_at)) has no
  // GROUP BY; the per-subnet leaderboard is GROUP BY netuid -- same two-query
  // shape loadChainServing always issues. The subnet query only fires when the
  // network row carries a non-null newest_observed.
  function chainServingD1({ network, subnets = [] } = {}) {
    return {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes("GROUP BY netuid")) {
                  return { results: subnets };
                }
                return { results: network ? [network] : [] };
              },
            };
          },
        };
      },
    };
  }

  test("cold store, default args: schema-stable empty leaderboard", async () => {
    const { status, body } = await gql(servingQuery(""));
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_serving, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      subnet_count: 0,
      network: {
        distinct_servers: 0,
        announcements: 0,
        announcements_per_server: null,
      },
      intensity_distribution: null,
      subnets: [],
    });
  });

  test("resolves Postgres-tier data for a valid non-default window/limit, forwarding both as query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            observed_at: "2026-07-10T00:00:00.000Z",
            subnet_count: 1,
            network: {
              distinct_servers: 4,
              announcements: 40,
              announcements_per_server: 10,
            },
            intensity_distribution: {
              count: 1,
              mean: 10,
              min: 10,
              p25: 10,
              median: 10,
              p75: 10,
              p90: 10,
              max: 10,
            },
            subnets: [
              {
                netuid: 3,
                distinct_servers: 4,
                announcements: 40,
                announcements_per_server: 10,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      servingQuery('(window: "30d", limit: 5)'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/serving");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(body.data.chain_serving.window, "30d");
    assert.equal(body.data.chain_serving.subnet_count, 1);
    assert.equal(body.data.chain_serving.network.distinct_servers, 4);
    assert.equal(body.data.chain_serving.network.announcements_per_server, 10);
    assert.equal(body.data.chain_serving.intensity_distribution.median, 10);
    assert.equal(body.data.chain_serving.subnets[0].netuid, 3);
  });

  test("a malformed Postgres-tier body falls back to schema-stable defaults (no throw)", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(servingQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_serving.window, "7d");
    assert.equal(body.data.chain_serving.subnet_count, 0);
    assert.equal(body.data.chain_serving.network.announcements, 0);
    assert.equal(
      body.data.chain_serving.network.announcements_per_server,
      null,
    );
    assert.equal(body.data.chain_serving.intensity_distribution, null);
    assert.deepEqual(body.data.chain_serving.subnets, []);
  });

  // #4909/#6013: account_events' D1 write path is retired and the table is
  // dropped in production, so this resolver no longer queries D1 at all --
  // even a "warm" D1 mock (real rows) must not change the response.
  test("no Postgres tier flag: never queries D1, returns the schema-stable empty leaderboard (retired -- #4909/#6013)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: chainServingD1({
        network: {
          distinct_servers: 4,
          newest_observed: 1_750_000_000_000,
        },
        subnets: [{ netuid: 3, announcements: 40, distinct_servers: 4 }],
      }),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      throw new Error("D1 must not be queried -- account_events is retired");
    };
    const { status, body } = await gql(servingQuery('(window: "7d")'), env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_serving.window, "7d");
    assert.equal(body.data.chain_serving.subnet_count, 0);
    assert.deepEqual(body.data.chain_serving.subnets, []);
  });

  test("an unsupported window is a GraphQL error, not a silently substituted default", async () => {
    const { status, body } = await gql(servingQuery('(window: "99d")'));
    assert.equal(status, 200);
    assert.equal(body.data, null);
    const err = body.errors.find(
      (e) => e.extensions?.code === "BAD_USER_INPUT",
    );
    assert.ok(err);
    assert.match(err.message, /99d/);
  });

  test("chain_serving is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.chain_serving, 5);
  });
});

describe("graphql — chain_weight_setters (#5689, Postgres-tier, D1 fully eliminated)", () => {
  function weightSettersQuery(argsClause) {
    return `{ chain_weight_setters${argsClause} {
      schema_version window observed_at distinct_setters weight_sets setter_count
      setters { hotkey netuid uid weight_sets share first_set_at last_set_at }
    } }`;
  }

  test("cold store, default args: schema-stable empty leaderboard", async () => {
    const { status, body } = await gql(weightSettersQuery(""));
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_weight_setters, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      distinct_setters: 0,
      weight_sets: 0,
      setter_count: 0,
      setters: [],
    });
  });

  test("resolves Postgres-tier data for a valid non-default window/limit, forwarding both as query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            observed_at: "2026-07-10T00:00:00.000Z",
            distinct_setters: 2,
            weight_sets: 40,
            setter_count: 1,
            setters: [
              {
                hotkey: "5Setter",
                netuid: null,
                uid: null,
                weight_sets: 40,
                share: 1,
                first_set_at: "2026-06-20T00:00:00.000Z",
                last_set_at: "2026-07-10T00:00:00.000Z",
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      weightSettersQuery('(window: "30d", limit: 5)'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/weights/setters");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(body.data.chain_weight_setters.window, "30d");
    assert.equal(body.data.chain_weight_setters.setter_count, 1);
    assert.equal(body.data.chain_weight_setters.setters[0].hotkey, "5Setter");
    assert.equal(body.data.chain_weight_setters.setters[0].share, 1);
  });

  test("a malformed Postgres-tier body falls back to schema-stable defaults (no throw)", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(weightSettersQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_weight_setters.window, "7d");
    assert.equal(body.data.chain_weight_setters.distinct_setters, 0);
    assert.equal(body.data.chain_weight_setters.weight_sets, 0);
    assert.equal(body.data.chain_weight_setters.setter_count, 0);
    assert.deepEqual(body.data.chain_weight_setters.setters, []);
  });

  test("an unsupported window is a GraphQL error, not a silently substituted default", async () => {
    const { status, body } = await gql(weightSettersQuery('(window: "99d")'));
    assert.equal(status, 200);
    assert.equal(body.data, null);
    const err = body.errors.find(
      (e) => e.extensions?.code === "BAD_USER_INPUT",
    );
    assert.ok(err);
    assert.match(err.message, /99d/);
  });

  test("chain_weight_setters is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.chain_weight_setters, 5);
  });
});

describe("graphql — chain_alpha_volume (#5685, Postgres-tier + D1-live fallback)", () => {
  function alphaVolumeQuery(argsClause = "") {
    return `{ chain_alpha_volume${argsClause} {
      schema_version window observed_at subnet_count
      network {
        buy_volume_alpha sell_volume_alpha total_volume_alpha
        buy_volume_tao sell_volume_tao total_volume_tao
        buy_count sell_count net_volume_alpha sentiment_ratio sentiment
      }
      volume_distribution { count mean min p25 median p75 p90 max }
      subnets {
        schema_version netuid window
        buy_volume_alpha sell_volume_alpha total_volume_alpha
        buy_volume_tao sell_volume_tao total_volume_tao
        buy_count sell_count net_volume_alpha sentiment_ratio sentiment vol_mcap_ratio
      }
    } }`;
  }

  // loadChainAlphaVolume issues a single (netuid, event_kind) GROUP BY over
  // account_events; the mock returns those aggregate rows for the one query.
  function chainAlphaVolumeD1(rows = []) {
    return {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return { results: rows };
              },
            };
          },
        };
      },
    };
  }

  test("cold store, default args: schema-stable zeroed card", async () => {
    const { status, body } = await gql(alphaVolumeQuery());
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_alpha_volume, {
      schema_version: 1,
      window: "24h",
      observed_at: null,
      subnet_count: 0,
      network: {
        buy_volume_alpha: 0,
        sell_volume_alpha: 0,
        total_volume_alpha: 0,
        buy_volume_tao: 0,
        sell_volume_tao: 0,
        total_volume_tao: 0,
        buy_count: 0,
        sell_count: 0,
        net_volume_alpha: 0,
        sentiment_ratio: null,
        sentiment: "neutral",
      },
      volume_distribution: null,
      subnets: [],
    });
  });

  test("resolves Postgres-tier data for an explicit limit, forwarding it as a query param", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "24h",
            observed_at: "2026-07-10T00:00:00.000Z",
            subnet_count: 1,
            network: {
              buy_volume_alpha: 100,
              sell_volume_alpha: 40,
              total_volume_alpha: 140,
              buy_volume_tao: 50,
              sell_volume_tao: 20,
              total_volume_tao: 70,
              buy_count: 10,
              sell_count: 5,
              net_volume_alpha: 60,
              sentiment_ratio: 0.4286,
              sentiment: "bullish",
            },
            volume_distribution: {
              count: 1,
              mean: 70,
              min: 70,
              p25: 70,
              median: 70,
              p75: 70,
              p90: 70,
              max: 70,
            },
            subnets: [
              {
                schema_version: 1,
                netuid: 3,
                window: "24h",
                buy_volume_alpha: 100,
                sell_volume_alpha: 40,
                total_volume_alpha: 140,
                buy_volume_tao: 50,
                sell_volume_tao: 20,
                total_volume_tao: 70,
                buy_count: 10,
                sell_count: 5,
                net_volume_alpha: 60,
                sentiment_ratio: 0.4286,
                sentiment: "bullish",
                vol_mcap_ratio: null,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(alphaVolumeQuery("(limit: 5)"), env);
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/alpha-volume");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    const card = body.data.chain_alpha_volume;
    assert.equal(card.window, "24h");
    assert.equal(card.subnet_count, 1);
    assert.equal(card.observed_at, "2026-07-10T00:00:00.000Z");
    assert.equal(card.network.total_volume_tao, 70);
    assert.equal(card.network.sentiment, "bullish");
    assert.equal(card.volume_distribution.median, 70);
    assert.equal(card.subnets[0].netuid, 3);
    assert.equal(card.subnets[0].vol_mcap_ratio, null);
  });

  test("clamps an over-max limit before forwarding it to the Postgres tier", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({});
        },
      },
    };
    const { status } = await gql(alphaVolumeQuery("(limit: 9999)"), env);
    assert.equal(status, 200);
    assert.equal(capturedUrl.searchParams.get("limit"), "100");
  });

  test("a malformed Postgres-tier body falls back to schema-stable defaults (no throw)", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(alphaVolumeQuery(), env);
    assert.equal(status, 200);
    const card = body.data.chain_alpha_volume;
    assert.equal(card.schema_version, 1);
    assert.equal(card.window, "24h");
    assert.equal(card.observed_at, null);
    assert.equal(card.subnet_count, 0);
    assert.equal(card.network.total_volume_tao, 0);
    assert.equal(card.network.sentiment, "neutral");
    assert.equal(card.volume_distribution, null);
    assert.deepEqual(card.subnets, []);
  });

  // #4772 D1 retirement: the `account_events` D1 table is dropped in
  // production, so this resolver no longer queries D1 at all -- even a
  // "warm" D1 mock (real rows) must not change the response.
  test("no Postgres tier flag: never queries D1, returns the schema-stable zeroed card (retired -- #4772)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: chainAlphaVolumeD1([
        {
          netuid: 3,
          event_kind: "StakeAdded",
          alpha_volume: 100,
          tao_volume: 50,
          event_count: 10,
          last_observed: 1_750_000_000_000,
        },
        {
          netuid: 3,
          event_kind: "StakeRemoved",
          alpha_volume: 40,
          tao_volume: 20,
          event_count: 5,
          last_observed: 1_749_000_000_000,
        },
      ]),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      throw new Error("D1 must not be queried -- account_events is retired");
    };
    const { status, body } = await gql(alphaVolumeQuery(), env);
    assert.equal(status, 200);
    const card = body.data.chain_alpha_volume;
    assert.equal(card.subnet_count, 0);
    assert.equal(card.network.total_volume_tao, 0);
    assert.deepEqual(card.subnets, []);
  });

  test("a D1 query error degrades to a schema-stable zeroed card (no throw)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error("db unavailable");
        },
      },
    };
    const { status, body } = await gql(alphaVolumeQuery(), env);
    assert.equal(status, 200);
    const card = body.data.chain_alpha_volume;
    assert.equal(card.subnet_count, 0);
    assert.equal(card.network.total_volume_tao, 0);
    assert.deepEqual(card.subnets, []);
  });

  test("chain_alpha_volume is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.chain_alpha_volume, 5);
  });
});

describe("graphql — health_trends (#5722, Postgres-tier + D1-live fallback)", () => {
  function trendsQuery() {
    return `{ health_trends { schema_version observed_at source windows } }`;
  }

  // No GROUP BY window label -- loadBulkHealthTrends issues a single query
  // over the full 30d cutoff and buckets rows into 7d/30d itself.
  function bulkTrendsD1(rows = []) {
    return {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return { results: rows };
              },
            };
          },
        };
      },
    };
  }

  test("cold store: schema-stable zeroed windows", async () => {
    const { status, body } = await gql(trendsQuery());
    assert.equal(status, 200);
    assert.equal(body.data.health_trends.schema_version, 1);
    assert.equal(body.data.health_trends.observed_at, null);
    assert.equal(body.data.health_trends.windows["7d"].subnet_count, 0);
    assert.deepEqual(body.data.health_trends.windows["7d"].subnets, []);
    assert.equal(body.data.health_trends.windows["30d"].subnet_count, 0);
    assert.deepEqual(body.data.health_trends.windows["30d"].subnets, []);
  });

  test("resolves Postgres-tier data, forwarding the request unchanged", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            observed_at: "2026-07-10T00:00:00.000Z",
            source: "live-cron-prober",
            windows: {
              "7d": {
                days: 7,
                granularity: "1d",
                subnet_count: 1,
                subnets: [{ netuid: 3, samples: 10 }],
              },
              "30d": {
                days: 30,
                granularity: "1d",
                subnet_count: 1,
                subnets: [{ netuid: 3, samples: 40 }],
              },
            },
          });
        },
      },
    };
    const { status, body } = await gql(trendsQuery(), env);
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/health/trends");
    assert.equal(
      body.data.health_trends.observed_at,
      "2026-07-10T00:00:00.000Z",
    );
    assert.equal(body.data.health_trends.windows["7d"].subnet_count, 1);
    assert.equal(body.data.health_trends.windows["30d"].subnets[0].netuid, 3);
  });

  test("a malformed Postgres-tier body falls back to schema-stable defaults (no throw)", async () => {
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(trendsQuery(), env);
    assert.equal(status, 200);
    assert.equal(body.data.health_trends.schema_version, 1);
    assert.equal(body.data.health_trends.observed_at, null);
    assert.equal(body.data.health_trends.source, null);
    assert.deepEqual(body.data.health_trends.windows, {});
  });

  // D1 fully eliminated (2026-07-17): surface_uptime_daily is Postgres-only
  // now, so a tier miss always yields zeroed windows -- even a "warm" D1
  // mock (real rows) must not change the response.
  test("no Postgres tier flag: never queries D1, returns schema-stable zeroed windows", async () => {
    const recentDay = new Date(Date.now() - 2 * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const env = {
      METAGRAPH_HEALTH_DB: bulkTrendsD1([
        {
          netuid: 7,
          date: recentDay,
          total: 10,
          ok_count: 9,
          avg_latency_ms: 50,
        },
      ]),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      throw new Error(
        "D1 must not be queried -- surface_uptime_daily is retired",
      );
    };
    const { status, body } = await gql(trendsQuery(), env);
    assert.equal(status, 200);
    assert.equal(body.data.health_trends.schema_version, 1);
    assert.equal(body.data.health_trends.windows["7d"].subnet_count, 0);
    assert.deepEqual(body.data.health_trends.windows["7d"].subnets, []);
    assert.equal(body.data.health_trends.windows["30d"].subnet_count, 0);
  });

  test("observed_at is stamped from the health:meta KV freshness on the D1-live path", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        async get(key) {
          return key === KV_HEALTH_META
            ? { last_run_at: "2026-06-23T00:00:00.000Z" }
            : null;
        },
      },
      METAGRAPH_HEALTH_DB: bulkTrendsD1([]),
    };
    const { body } = await gql(trendsQuery(), env);
    assert.equal(
      body.data.health_trends.observed_at,
      "2026-06-23T00:00:00.000Z",
    );
  });

  test("a D1 query error degrades to a schema-stable empty matrix (no throw)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error("db unavailable");
        },
      },
    };
    const { status, body } = await gql(trendsQuery(), env);
    assert.equal(status, 200);
    assert.equal(body.data.health_trends.windows["7d"].subnet_count, 0);
    assert.deepEqual(body.data.health_trends.windows["7d"].subnets, []);
  });

  test("health_trends is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.health_trends, 5);
  });
});

describe("graphql — subnet_health_trends (#5883, Postgres-tier + D1-live fallback)", () => {
  const NETUID = 3;

  function trendsQuery(netuid) {
    return `{ subnet_health_trends(netuid: ${netuid}) { schema_version netuid observed_at source windows } }`;
  }

  test("cold store: schema-stable zeroed windows via the D1-live loader", async () => {
    const { status, body } = await gql(trendsQuery(NETUID));
    assert.equal(status, 200);
    const d = body.data.subnet_health_trends;
    assert.equal(d.schema_version, 1);
    assert.equal(d.netuid, NETUID);
    assert.equal(d.observed_at, null);
    assert.equal(d.source, "live-cron-prober");
    assert.equal(d.windows["7d"].samples, 0);
    assert.deepEqual(d.windows["7d"].surfaces, []);
    assert.equal(d.windows["30d"].samples, 0);
  });

  test("resolves Postgres-tier data, forwarding the netuid in the path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            netuid: NETUID,
            observed_at: "2026-07-10T00:00:00.000Z",
            source: "live-cron-prober",
            windows: {
              "7d": {
                samples: 20,
                uptime_ratio: 0.95,
                latency_sample_count: 18,
                surfaces: [{ surface_id: "srf-1", samples: 20 }],
              },
              "30d": {
                samples: 80,
                uptime_ratio: 0.9,
                latency_sample_count: 70,
                surfaces: [{ surface_id: "srf-1", samples: 80 }],
              },
            },
          });
        },
      },
    };
    const { status, body } = await gql(trendsQuery(NETUID), env);
    assert.equal(status, 200);
    assert.equal(
      capturedUrl.pathname,
      `/api/v1/subnets/${NETUID}/health/trends`,
    );
    const d = body.data.subnet_health_trends;
    assert.equal(d.netuid, NETUID);
    assert.equal(d.observed_at, "2026-07-10T00:00:00.000Z");
    assert.equal(d.windows["7d"].uptime_ratio, 0.95);
    assert.equal(d.windows["30d"].surfaces[0].surface_id, "srf-1");
  });

  test("a malformed Postgres-tier body falls back to schema-stable defaults (no throw)", async () => {
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(trendsQuery(NETUID), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_health_trends, {
      schema_version: 1,
      netuid: NETUID,
      observed_at: null,
      source: null,
      windows: {},
    });
  });

  test("subnet_health_trends is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_health_trends, 5);
  });
});

describe("graphql — subnet_uptime (#5885, Postgres-tier + D1-live fallback)", () => {
  const NETUID = 7;

  function uptimeQuery(args = `netuid: ${NETUID}`) {
    return `{ subnet_uptime(${args}) {
      schema_version netuid window observed_at source
      reliability { score grade uptime_ratio sample_count window }
      surfaces {
        surface_id day_count samples uptime_ratio
        days { day samples uptime_ratio status avg_latency_ms }
      }
    } }`;
  }

  // loadSubnetUptime issues a single GROUP BY over surface_uptime_daily; the
  // mock only needs to answer all() with the aggregated day rows.
  function uptimeD1(rows = []) {
    return {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return { results: rows };
              },
            };
          },
        };
      },
    };
  }

  test("cold store: schema-stable empty surfaces via the D1-live loader", async () => {
    const { status, body } = await gql(uptimeQuery());
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_uptime, {
      schema_version: 1,
      netuid: NETUID,
      window: "90d",
      observed_at: null,
      source: "live-cron-prober",
      reliability: null,
      surfaces: [],
    });
  });

  test("resolves Postgres-tier data and forwards window + min_samples", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            netuid: NETUID,
            window: "1y",
            observed_at: "2026-07-10T00:00:00.000Z",
            source: "live-cron-prober",
            reliability: {
              score: 99,
              grade: "A",
              uptime_ratio: 0.995,
              sample_count: 100,
              window: "1y",
            },
            surfaces: [
              {
                surface_id: "api-root",
                day_count: 1,
                samples: 100,
                uptime_ratio: 0.995,
                days: [
                  {
                    day: "2026-07-09",
                    samples: 100,
                    uptime_ratio: 0.995,
                    status: "ok",
                    avg_latency_ms: 80,
                  },
                ],
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      uptimeQuery(`netuid: ${NETUID}, window: "1y", min_samples: 5`),
      env,
    );
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, `/api/v1/subnets/${NETUID}/uptime`);
    assert.equal(capturedUrl.searchParams.get("window"), "1y");
    assert.equal(capturedUrl.searchParams.get("min_samples"), "5");
    const d = body.data.subnet_uptime;
    assert.equal(d.window, "1y");
    assert.equal(d.reliability.score, 99);
    assert.equal(d.surfaces[0].surface_id, "api-root");
    assert.equal(d.surfaces[0].days[0].uptime_ratio, 0.995);
  });

  test("a malformed Postgres-tier body falls back to schema-stable defaults (no throw)", async () => {
    const env = {
      METAGRAPH_HEALTH_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(uptimeQuery(), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_uptime, {
      schema_version: 1,
      netuid: NETUID,
      window: "90d",
      observed_at: null,
      source: null,
      reliability: null,
      surfaces: [],
    });
  });

  // D1 fully eliminated (2026-07-17): surface_uptime_daily is Postgres-only
  // now, so a tier miss always yields an empty surfaces card -- even a
  // "warm" D1 mock (real rows) must not change the response.
  test("no Postgres tier flag: never queries D1, returns a schema-stable empty surfaces card", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: uptimeD1([
        {
          surface_id: "api-root",
          surface_key: "api-root",
          day: "2026-07-09",
          samples: 50,
          ok_count: 45,
          uptime_ratio: 0.9,
          avg_latency_ms: 90,
          latency_samples: 45,
          p50: 80,
          p95: 110,
          p99: 130,
          status: "degraded",
        },
      ]),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      throw new Error(
        "D1 must not be queried -- surface_uptime_daily is retired",
      );
    };
    const { status, body } = await gql(uptimeQuery(), env);
    assert.equal(status, 200);
    assert.deepEqual(body.data.subnet_uptime, {
      schema_version: 1,
      netuid: NETUID,
      window: "90d",
      observed_at: null,
      // formatUptime always stamps this literal, independent of whether
      // any rows were found -- unlike the malformed-Postgres-tier-body case
      // above (a genuine tier hit whose body happens to omit `source`).
      source: "live-cron-prober",
      reliability: null,
      surfaces: [],
    });
  });

  test("unsupported window is a BAD_USER_INPUT error", async () => {
    const { status, body } = await gql(
      uptimeQuery(`netuid: ${NETUID}, window: "7d"`),
    );
    assert.equal(status, 200);
    assert.ok(
      body.errors?.find((e) => e.extensions?.code === "BAD_USER_INPUT"),
      `expected BAD_USER_INPUT, got: ${JSON.stringify(body.errors)}`,
    );
  });

  test("negative min_samples is a BAD_USER_INPUT error", async () => {
    const { status, body } = await gql(
      uptimeQuery(`netuid: ${NETUID}, min_samples: -1`),
    );
    assert.equal(status, 200);
    assert.ok(
      body.errors?.find((e) => e.extensions?.code === "BAD_USER_INPUT"),
      `expected BAD_USER_INPUT, got: ${JSON.stringify(body.errors)}`,
    );
  });

  test("observed_at is stamped from the health:meta KV freshness on the D1-live path", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        async get(key) {
          return key === KV_HEALTH_META
            ? { last_run_at: "2026-06-23T00:00:00.000Z" }
            : null;
        },
      },
      METAGRAPH_HEALTH_DB: uptimeD1([]),
    };
    const { body } = await gql(uptimeQuery(), env);
    assert.equal(
      body.data.subnet_uptime.observed_at,
      "2026-06-23T00:00:00.000Z",
    );
  });

  test("subnet_uptime is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_uptime, 5);
  });
});

describe("graphql — rpc_usage (#5899, Postgres-tier + D1-live fallback)", () => {
  function usageQuery(argsClause = "") {
    return `{ rpc_usage${argsClause} {
      schema_version window bucket_granularity observed_at source
      summary {
        total_requests ok_requests error_requests error_rate
        failover_requests failover_rate cache_hits cache_hit_rate
        latency_ms { p50 p95 avg }
      }
      endpoints { rank endpoint_id provider requests ok_requests error_rate avg_latency_ms }
      networks { network requests ok_requests error_rate }
      buckets { ts requests errors avg_latency_ms }
    } }`;
  }

  // loadRpcUsage issues five parallel queries over rpc_proxy_events; the D1
  // runner sees each SQL string, so route rows by the clause unique to each:
  // the endpoint/network/bucket leaderboards GROUP BY their key, the latency
  // query is the ROW_NUMBER percentile CTE, and the aggregate totals row has
  // no GROUP BY at all.
  function rpcUsageD1({
    totals,
    latency,
    endpoints = [],
    networks = [],
    buckets = [],
  } = {}) {
    return {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes("GROUP BY endpoint_id")) {
                  return { results: endpoints };
                }
                if (sql.includes("GROUP BY network")) {
                  return { results: networks };
                }
                if (sql.includes("GROUP BY ts")) {
                  return { results: buckets };
                }
                if (sql.includes("ROW_NUMBER")) {
                  return { results: latency ? [latency] : [] };
                }
                return { results: totals ? [totals] : [] };
              },
            };
          },
        };
      },
    };
  }

  test("cold store, default args: schema-stable zeroed card", async () => {
    const { status, body } = await gql(usageQuery());
    assert.equal(status, 200);
    assert.deepEqual(body.data.rpc_usage, {
      schema_version: 1,
      window: "7d",
      bucket_granularity: "1h",
      observed_at: null,
      source: "rpc-proxy",
      summary: {
        total_requests: 0,
        ok_requests: 0,
        error_requests: 0,
        error_rate: null,
        failover_requests: 0,
        failover_rate: null,
        cache_hits: 0,
        cache_hit_rate: null,
        latency_ms: { p50: null, p95: null, avg: null },
      },
      endpoints: [],
      networks: [],
      buckets: [],
    });
  });

  test("resolves Postgres-tier data for a valid non-default window, forwarding it as a query param", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_RPC_USAGE_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            bucket_granularity: "6h",
            observed_at: "2026-07-10T00:00:00.000Z",
            source: "rpc-proxy",
            summary: {
              total_requests: 100,
              ok_requests: 95,
              error_requests: 5,
              error_rate: 0.05,
              failover_requests: 3,
              failover_rate: 0.03,
              cache_hits: 40,
              cache_hit_rate: 0.4,
              latency_ms: { p50: 20, p95: 80, avg: 30 },
            },
            endpoints: [
              {
                rank: 1,
                endpoint_id: "ep-a",
                provider: "prov-a",
                requests: 60,
                ok_requests: 58,
                error_rate: 0.0333,
                avg_latency_ms: 25,
              },
            ],
            networks: [
              {
                network: "finney",
                requests: 100,
                ok_requests: 95,
                error_rate: 0.05,
              },
            ],
            buckets: [
              {
                ts: 1_750_000_000_000,
                requests: 10,
                errors: 1,
                avg_latency_ms: 22,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(usageQuery('(window: "30d")'), env);
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/rpc/usage");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    const usage = body.data.rpc_usage;
    assert.equal(usage.window, "30d");
    assert.equal(usage.bucket_granularity, "6h");
    assert.equal(usage.observed_at, "2026-07-10T00:00:00.000Z");
    assert.equal(usage.summary.total_requests, 100);
    assert.equal(usage.summary.error_rate, 0.05);
    assert.equal(usage.summary.cache_hit_rate, 0.4);
    assert.equal(usage.summary.latency_ms.p95, 80);
    assert.equal(usage.endpoints[0].endpoint_id, "ep-a");
    assert.equal(usage.endpoints[0].error_rate, 0.0333);
    assert.equal(usage.networks[0].network, "finney");
    assert.equal(usage.buckets[0].ts, 1_750_000_000_000);
  });

  test("a malformed Postgres-tier body falls back to schema-stable defaults (no throw)", async () => {
    const env = {
      METAGRAPH_RPC_USAGE_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(usageQuery(), env);
    assert.equal(status, 200);
    const usage = body.data.rpc_usage;
    assert.equal(usage.schema_version, 1);
    assert.equal(usage.window, "7d");
    assert.equal(usage.bucket_granularity, null);
    assert.equal(usage.observed_at, null);
    assert.equal(usage.source, null);
    assert.deepEqual(usage.summary, {
      total_requests: 0,
      ok_requests: 0,
      error_requests: 0,
      error_rate: null,
      failover_requests: 0,
      failover_rate: null,
      cache_hits: 0,
      cache_hit_rate: null,
      latency_ms: { p50: null, p95: null, avg: null },
    });
    assert.deepEqual(usage.endpoints, []);
    assert.deepEqual(usage.networks, []);
    assert.deepEqual(usage.buckets, []);
  });

  // D1 fully eliminated (2026-07-17): rpc_proxy_events is Postgres-only now,
  // so a tier miss always yields the schema-stable empty card -- even a
  // "warm" D1 mock (real rows) must not change the response.
  test("no Postgres tier flag: never queries D1, returns the schema-stable zeroed card", async () => {
    const env = {
      METAGRAPH_RPC_USAGE_SOURCE: "d1",
      METAGRAPH_HEALTH_DB: rpcUsageD1({
        totals: {
          total: 200,
          ok_count: 190,
          failover_count: 8,
          cache_hits: 120,
          avg_latency_ms: 27,
        },
        latency: { p50: 18, p95: 70 },
        endpoints: [
          {
            endpoint_id: "ep-1",
            provider: "prov-1",
            requests: 120,
            ok_count: 116,
            avg_latency_ms: 24,
          },
        ],
        networks: [{ network: "finney", requests: 200, ok_count: 190 }],
        buckets: [
          {
            ts: 1_750_000_000_000,
            requests: 30,
            errors: 2,
            avg_latency_ms: 26,
          },
        ],
      }),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      throw new Error("D1 must not be queried -- rpc_proxy_events is retired");
    };
    const { status, body } = await gql(usageQuery('(window: "7d")'), env);
    assert.equal(status, 200);
    const usage = body.data.rpc_usage;
    assert.equal(usage.window, "7d");
    assert.equal(usage.bucket_granularity, "1h");
    assert.equal(usage.source, "rpc-proxy");
    assert.equal(usage.summary.total_requests, 0);
    assert.deepEqual(usage.endpoints, []);
    assert.deepEqual(usage.networks, []);
    assert.deepEqual(usage.buckets, []);
  });

  test("observed_at is stamped from the health:meta KV freshness on the D1-live path", async () => {
    const env = {
      METAGRAPH_CONTROL: {
        async get(key) {
          return key === KV_HEALTH_META
            ? { last_run_at: "2026-06-23T00:00:00.000Z" }
            : null;
        },
      },
      METAGRAPH_HEALTH_DB: rpcUsageD1(),
    };
    const { body } = await gql(usageQuery(), env);
    assert.equal(body.data.rpc_usage.observed_at, "2026-06-23T00:00:00.000Z");
  });

  test("a D1 query error degrades to a schema-stable zeroed card (no throw)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error("db unavailable");
        },
      },
    };
    const { status, body } = await gql(usageQuery(), env);
    assert.equal(status, 200);
    assert.equal(body.data.rpc_usage.summary.total_requests, 0);
    assert.deepEqual(body.data.rpc_usage.endpoints, []);
    assert.deepEqual(body.data.rpc_usage.buckets, []);
  });

  test("an unsupported window is a GraphQL error, not a silently substituted default", async () => {
    const { status, body } = await gql(usageQuery('(window: "99d")'));
    assert.equal(status, 200);
    assert.equal(body.data, null);
    const err = body.errors.find(
      (e) => e.extensions?.code === "BAD_USER_INPUT",
    );
    assert.ok(err);
    assert.match(err.message, /99d/);
  });

  test("rpc_usage is weighted as a fan-out field", () => {
    assert.equal(FIELD_COMPLEXITY.rpc_usage, 5);
  });
});

describe("Subscription.chainEvents", () => {
  test("yields a properly-shaped GraphQL execution result for each pushed payload", async () => {
    const hub = fakeChainFirehose((repeater) => {
      // subscribeChainEvents is only invoked once the async generator is
      // first pulled (async generator function BODIES don't run until
      // next() is called) -- pushing here, synchronously inside that same
      // call, lands in the repeater's buffer before the resolver's
      // `for await` loop starts pulling, so no setTimeout/await gap is
      // needed.
      repeater.push({ table: "blocks", block_number: 42 });
    });
    const result = await subscribeChainEvents(
      "subscription { chainEvents { table block_number } }",
      hub,
    );
    const { value, done } = await result[Symbol.asyncIterator]().next();
    assert.equal(done, false);
    assert.deepEqual(asPlainJson(value), {
      data: { chainEvents: { table: "blocks", block_number: 42 } },
    });
  });

  test("passes the tables argument through to subscribeChainEvents as a Set", async () => {
    let receivedTopics;
    const hub = fakeChainFirehose();
    const originalSubscribe = hub.subscribeChainEvents.bind(hub);
    hub.subscribeChainEvents = (topics) => {
      receivedTopics = topics;
      return originalSubscribe(topics);
    };
    const result = await subscribeChainEvents(
      "subscription { chainEvents(tables: [blocks, extrinsics]) { table } }",
      hub,
    );
    // Pull once to actually run the generator body up to (and past) the
    // hub.subscribeChainEvents(topics) call -- calling an async generator
    // function only creates the generator object, it doesn't execute any of
    // the body until the first next().
    const pending = result[Symbol.asyncIterator]().next();
    assert.deepEqual([...receivedTopics].sort(), ["blocks", "extrinsics"]);
    await hub.unsubscribeChainEvents(hub.subscriptions[0]?.repeater);
    pending.catch(() => {}); // left permanently pending; not under test here
  });

  test("an omitted tables argument means no filter (null, matches everything)", async () => {
    let receivedTopics = "unset";
    const hub = fakeChainFirehose();
    const originalSubscribe = hub.subscribeChainEvents.bind(hub);
    hub.subscribeChainEvents = (topics) => {
      receivedTopics = topics;
      return originalSubscribe(topics);
    };
    const result = await subscribeChainEvents(
      "subscription { chainEvents { table } }",
      hub,
    );
    result[Symbol.asyncIterator]().next(); // trigger the generator body
    assert.equal(receivedTopics, null);
  });

  test("an EXPLICIT empty tables argument means an empty Set (matches nothing) -- consistent with the SSE/WS firehose's own all-unrecognized-topics semantics, not silently 'everything'", async () => {
    let receivedTopics = "unset";
    const hub = fakeChainFirehose();
    const originalSubscribe = hub.subscribeChainEvents.bind(hub);
    hub.subscribeChainEvents = (topics) => {
      receivedTopics = topics;
      return originalSubscribe(topics);
    };
    const result = await subscribeChainEvents(
      "subscription { chainEvents(tables: []) { table } }",
      hub,
    );
    result[Symbol.asyncIterator]().next(); // trigger the generator body
    assert.ok(receivedTopics instanceof Set);
    assert.equal(receivedTopics.size, 0);
  });

  test("returns a clear GraphQLError when reached without the graphql-ws WS transport (no context.chainFirehose)", async () => {
    const result = await subscribeChainEvents(
      "subscription { chainEvents { table } }",
      undefined,
    );
    // The subscribe field resolver is an async generator, so the throw only
    // happens once the first value is pulled -- and since it's thrown before
    // any yield (a setup-phase failure, not a mid-stream one), graphql-js
    // propagates it as a REJECTED next() rather than an {errors: [...]}
    // iteration result. A real graphql-ws server catches this per-operation
    // and sends the client an ErrorMessage -- this test only needs to prove
    // the resolver actually rejects with a clear, actionable message.
    await assert.rejects(
      () => result[Symbol.asyncIterator]().next(),
      /graphql-transport-ws/,
    );
  });

  test("passes context.clientIp through to subscribeChainEvents as the second argument (#5004 item 2)", async () => {
    // context.clientIp is populated by workers/chain-firehose-hub.mjs's
    // graphqlWsServer context() callback (from ctx.extra.ip, itself set by
    // handleSubscribe's opened(adapterSocket, { ip: clientIp }) call) -- not
    // Node-testable end-to-end, so this proves the resolver's half of that
    // wiring: it reads context.clientIp and forwards it, letting
    // ChainFirehoseHub.subscribeChainEvents enforce its per-IP cap.
    let receivedClientIp = "unset";
    const hub = fakeChainFirehose();
    const originalSubscribe = hub.subscribeChainEvents.bind(hub);
    hub.subscribeChainEvents = (topics, clientIp) => {
      receivedClientIp = clientIp;
      return originalSubscribe(topics);
    };
    const result = await subscribeChainEvents(
      "subscription { chainEvents { table } }",
      hub,
      "203.0.113.9",
    );
    result[Symbol.asyncIterator]().next(); // trigger the generator body
    assert.equal(receivedClientIp, "203.0.113.9");
  });

  test("an absent context.clientIp is passed through as undefined, not crashing or defaulting to a fabricated IP", async () => {
    let receivedClientIp = "unset";
    const hub = fakeChainFirehose();
    const originalSubscribe = hub.subscribeChainEvents.bind(hub);
    hub.subscribeChainEvents = (topics, clientIp) => {
      receivedClientIp = clientIp;
      return originalSubscribe(topics);
    };
    const result = await subscribeChainEvents(
      "subscription { chainEvents { table } }",
      hub,
    );
    result[Symbol.asyncIterator]().next(); // trigger the generator body
    assert.equal(receivedClientIp, undefined);
  });

  test("returns a clear GraphQLError when subscribeChainEvents reports the hub is at capacity (CHAIN_FIREHOSE_MAX_GRAPHQL_SUBSCRIPTIONS)", async () => {
    // subscribeChainEvents returns null (not a repeater) once
    // ChainFirehoseHub.chainEventSubscribers is at its cap -- the resolver
    // must throw immediately rather than treating null as an empty stream
    // (which would otherwise hang the client forever with no error and no
    // events).
    const hub = {
      subscribeChainEvents: () => null,
      unsubscribeChainEvents() {},
    };
    const result = await subscribeChainEvents(
      "subscription { chainEvents { table } }",
      hub,
    );
    await assert.rejects(
      () => result[Symbol.asyncIterator]().next(),
      /maximum number of concurrent GraphQL subscriptions/,
    );
  });

  test("unsubscribeChainEvents is called when the async generator is returned early (client disconnects/completes)", async () => {
    // Calling .return() while a .next() is still unresolved deadlocks
    // graphql-js's internal withConcurrentAbruptClose handling (it waits for
    // the in-flight next() before honoring return()) -- push a value so the
    // pending next() actually resolves first, matching how a real client
    // completes a subscription only after having received at least one
    // event, not mid-flight on an empty stream.
    const hub = fakeChainFirehose((repeater) => {
      repeater.push({ table: "blocks" });
    });
    const result = await subscribeChainEvents(
      "subscription { chainEvents { table } }",
      hub,
    );
    const it = result[Symbol.asyncIterator]();
    await it.next(); // starts the generator body (-> subscribeChainEvents) and resolves with the pushed value
    assert.equal(hub.subscriptions.length, 1);
    await it.return();
    assert.equal(hub.subscriptions.length, 0);
  });

  test("POSTing a subscription operation to the regular query endpoint returns a standard GraphQL error, not a crash", async () => {
    const { status, body } = await gql(
      "subscription { chainEvents { table } }",
    );
    assert.equal(status, 200);
    assert.ok(body.errors?.length);
  });
});

describe("graphql — validator_nominators (#5692, Postgres-tier + D1-live fallback)", () => {
  const HOTKEY = "5FTestValidatorHotkeyAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

  function nominatorsQuery(argsClause) {
    return `{ validator_nominators${argsClause} {
      schema_version hotkey window sort limit offset nominator_count
      nominators { coldkey staked_tao unstaked_tao net_staked_tao gross_staked_tao event_count last_observed_at }
    } }`;
  }

  // loadValidatorNominators issues TWO queries: a COUNT(DISTINCT coldkey) total
  // (paging-independent) and the per-coldkey GROUP BY rows -- same two-query shape
  // the chainWeightsD1 fixture above models, so branch on the SQL.
  function nominatorsD1(rows = [], nominatorCount = rows.length) {
    return {
      prepare(sql) {
        return {
          bind: () => ({
            all: async () =>
              sql.includes("COUNT(DISTINCT coldkey)")
                ? { results: [{ nominator_count: nominatorCount }] }
                : { results: rows },
          }),
        };
      },
    };
  }

  test("cold store, default args: schema-stable empty list (never a GraphQL error)", async () => {
    const { status, body } = await gql(
      nominatorsQuery(`(hotkey: "${HOTKEY}")`),
    );
    assert.equal(status, 200);
    assert.equal(body.data.validator_nominators.hotkey, HOTKEY);
    assert.equal(body.data.validator_nominators.window, "30d");
    assert.equal(body.data.validator_nominators.sort, "net_staked");
    assert.equal(body.data.validator_nominators.nominator_count, 0);
    assert.deepEqual(body.data.validator_nominators.nominators, []);
  });

  test("resolves Postgres-tier data for a valid non-default window/sort, forwarding both as query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            data: {
              schema_version: 1,
              hotkey: HOTKEY,
              window: "7d",
              sort: "gross_staked",
              limit: 20,
              offset: 0,
              nominator_count: 1,
              nominators: [
                {
                  coldkey: "5FNominatorColdkeyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
                  staked_tao: 12.5,
                  unstaked_tao: 2.5,
                  net_staked_tao: 10,
                  gross_staked_tao: 15,
                  event_count: 3,
                  last_observed_at: "2026-07-10T00:00:00.000Z",
                },
              ],
            },
            generatedAt: "2026-07-10T00:00:00.000Z",
          });
        },
      },
    };
    const { status, body } = await gql(
      nominatorsQuery(
        `(hotkey: "${HOTKEY}", window: "7d", sort: "gross_staked")`,
      ),
      env,
    );
    assert.equal(status, 200);
    assert.equal(
      capturedUrl.pathname,
      `/api/v1/validators/${HOTKEY}/nominators`,
    );
    assert.equal(capturedUrl.searchParams.get("window"), "7d");
    assert.equal(capturedUrl.searchParams.get("sort"), "gross_staked");
    assert.equal(body.data.validator_nominators.window, "7d");
    assert.equal(body.data.validator_nominators.sort, "gross_staked");
    assert.equal(body.data.validator_nominators.nominator_count, 1);
    assert.equal(
      body.data.validator_nominators.nominators[0].net_staked_tao,
      10,
    );
    assert.equal(body.data.validator_nominators.nominators[0].event_count, 3);
  });

  // #4772 D1 retirement: the `account_events` D1 table is dropped in
  // production, so this resolver no longer queries D1 at all -- even a
  // "warm" D1 mock (real rows) must not change the response.
  test("no Postgres tier flag: never queries D1, returns the schema-stable empty list (retired -- #4772)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: nominatorsD1([
        {
          coldkey: "5FNominatorColdkeyBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          staked_tao: 12.5,
          unstaked_tao: 2.5,
          event_count: 3,
          last_observed: 1_750_000_000_000,
        },
      ]),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      throw new Error("D1 must not be queried -- account_events is retired");
    };
    const { status, body } = await gql(
      nominatorsQuery(`(hotkey: "${HOTKEY}")`),
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.validator_nominators.nominator_count, 0);
    assert.deepEqual(body.data.validator_nominators.nominators, []);
  });

  test("a malformed Postgres-tier body falls back to schema-stable defaults (no throw)", async () => {
    // The tier answers with the right { data, generatedAt } envelope but an empty
    // data object -- every field falls through to its own default rather than
    // surfacing undefined or throwing.
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => Response.json({ data: {}, generatedAt: null }),
      },
    };
    const { status, body } = await gql(
      nominatorsQuery(`(hotkey: "${HOTKEY}")`),
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.validator_nominators, {
      schema_version: 1,
      hotkey: HOTKEY,
      window: "30d",
      sort: "net_staked",
      limit: 0,
      offset: 0,
      nominator_count: 0,
      nominators: [],
    });
  });

  test("an unsupported window is a GraphQL error, not a silently substituted default", async () => {
    const { status, body } = await gql(
      nominatorsQuery(`(hotkey: "${HOTKEY}", window: "99d")`),
    );
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.match(body.errors[0].message, /99d/);
    assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
  });

  test("an unsupported sort is a GraphQL error listing the supported values", async () => {
    const { status, body } = await gql(
      nominatorsQuery(`(hotkey: "${HOTKEY}", sort: "bogus")`),
    );
    assert.equal(status, 200);
    assert.equal(body.data, null);
    assert.match(body.errors[0].message, /not a supported sort/);
    assert.match(body.errors[0].message, /net_staked/);
    assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
  });
});

describe("graphql — chain_performance (#5688, Postgres-tier + zeroed-card fallback)", () => {
  const PERFORMANCE_QUERY = `{ chain_performance {
    schema_version subnet_count neuron_count validator_count active_count captured_at
    incentive { holders total gini hhi hhi_normalized nakamoto_coefficient top_1pct_share top_5pct_share top_10pct_share top_20pct_share entropy entropy_normalized }
    dividends { holders gini nakamoto_coefficient }
    trust { count mean min max p10 p25 p50 p75 p90 }
    consensus { count mean }
    validator_trust { count mean }
  } }`;

  test("cold store: schema-stable zeroed card with every metric block null", async () => {
    const { status, body } = await gql(PERFORMANCE_QUERY);
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_performance, {
      schema_version: 1,
      subnet_count: 0,
      neuron_count: 0,
      validator_count: 0,
      active_count: 0,
      captured_at: null,
      incentive: null,
      dividends: null,
      trust: null,
      consensus: null,
      validator_trust: null,
    });
  });

  test("resolves Postgres-tier data, requesting the mirrored REST path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            subnet_count: 2,
            neuron_count: 3,
            validator_count: 2,
            active_count: 3,
            captured_at: "2026-07-10T00:00:00.000Z",
            incentive: {
              holders: 3,
              total: 6,
              gini: 0.22,
              hhi: 0.38,
              hhi_normalized: 0.07,
              nakamoto_coefficient: 2,
              top_1pct_share: 0.5,
              top_5pct_share: 0.5,
              top_10pct_share: 0.5,
              top_20pct_share: 0.5,
              entropy: 1.46,
              entropy_normalized: 0.92,
            },
            dividends: { holders: 2, gini: 0.11, nakamoto_coefficient: 1 },
            trust: {
              count: 3,
              mean: 0.5,
              min: 0.2,
              max: 0.8,
              p10: 0.2,
              p25: 0.3,
              p50: 0.5,
              p75: 0.7,
              p90: 0.8,
            },
            consensus: { count: 3, mean: 0.4 },
            validator_trust: { count: 2, mean: 0.6 },
          });
        },
      },
    };
    const { status, body } = await gql(PERFORMANCE_QUERY, env);
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/performance");
    assert.equal(body.data.chain_performance.subnet_count, 2);
    assert.equal(body.data.chain_performance.neuron_count, 3);
    assert.equal(body.data.chain_performance.incentive.nakamoto_coefficient, 2);
    assert.equal(body.data.chain_performance.dividends.holders, 2);
    assert.equal(body.data.chain_performance.trust.p90, 0.8);
    assert.equal(body.data.chain_performance.validator_trust.mean, 0.6);
  });

  test("a malformed Postgres-tier body falls back to schema-stable defaults (no throw)", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(PERFORMANCE_QUERY, env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_performance.schema_version, 1);
    assert.equal(body.data.chain_performance.subnet_count, 0);
    assert.equal(body.data.chain_performance.captured_at, null);
    assert.equal(body.data.chain_performance.incentive, null);
    assert.equal(body.data.chain_performance.trust, null);
  });
});

describe("graphql — chain_concentration (#5872, Postgres-tier + zeroed-card fallback)", () => {
  const CONCENTRATION_QUERY = `{ chain_concentration {
    schema_version subnet_count neuron_count entity_count uids_per_entity captured_at
    stake { holders total gini hhi hhi_normalized nakamoto_coefficient top_1pct_share top_5pct_share top_10pct_share top_20pct_share entropy entropy_normalized }
    emission { holders gini nakamoto_coefficient }
    entity_stake { holders gini }
    entity_emission { holders gini }
    validator_stake { holders total gini }
  } }`;

  test("cold store: schema-stable zeroed card with every metric block null", async () => {
    const { status, body } = await gql(CONCENTRATION_QUERY);
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_concentration, {
      schema_version: 1,
      subnet_count: 0,
      neuron_count: 0,
      entity_count: 0,
      uids_per_entity: null,
      captured_at: null,
      stake: null,
      emission: null,
      entity_stake: null,
      entity_emission: null,
      validator_stake: null,
    });
  });

  test("resolves Postgres-tier data, requesting the mirrored REST path", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            subnet_count: 2,
            neuron_count: 3,
            entity_count: 2,
            uids_per_entity: 1.5,
            captured_at: "2026-07-10T00:00:00.000Z",
            stake: {
              holders: 3,
              total: 6,
              gini: 0.22,
              hhi: 0.38,
              hhi_normalized: 0.07,
              nakamoto_coefficient: 2,
              top_1pct_share: 0.5,
              top_5pct_share: 0.5,
              top_10pct_share: 0.5,
              top_20pct_share: 0.5,
              entropy: 1.46,
              entropy_normalized: 0.92,
            },
            emission: { holders: 3, gini: 0.11, nakamoto_coefficient: 1 },
            entity_stake: { holders: 2, gini: 0.33 },
            entity_emission: { holders: 2, gini: 0.25 },
            validator_stake: { holders: 2, total: 4, gini: 0.15 },
          });
        },
      },
    };
    const { status, body } = await gql(CONCENTRATION_QUERY, env);
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/concentration");
    assert.equal(body.data.chain_concentration.subnet_count, 2);
    assert.equal(body.data.chain_concentration.neuron_count, 3);
    assert.equal(body.data.chain_concentration.entity_count, 2);
    assert.equal(body.data.chain_concentration.uids_per_entity, 1.5);
    assert.equal(body.data.chain_concentration.stake.nakamoto_coefficient, 2);
    assert.equal(body.data.chain_concentration.emission.holders, 3);
    assert.equal(body.data.chain_concentration.entity_stake.gini, 0.33);
    assert.equal(body.data.chain_concentration.entity_emission.gini, 0.25);
    assert.equal(body.data.chain_concentration.validator_stake.total, 4);
  });

  test("a malformed Postgres-tier body falls back to schema-stable defaults (no throw)", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(CONCENTRATION_QUERY, env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_concentration.schema_version, 1);
    assert.equal(body.data.chain_concentration.subnet_count, 0);
    assert.equal(body.data.chain_concentration.entity_count, 0);
    assert.equal(body.data.chain_concentration.uids_per_entity, null);
    assert.equal(body.data.chain_concentration.captured_at, null);
    assert.equal(body.data.chain_concentration.stake, null);
    assert.equal(body.data.chain_concentration.entity_stake, null);
    assert.equal(body.data.chain_concentration.validator_stake, null);
  });
});

describe("graphql — chain_yield (Postgres-tier + cold-store fallback)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold store: no Postgres flag returns a schema-stable zeroed card, never null", async () => {
    const { status, body } = await gql(
      `{ chain_yield {
          schema_version subnet_count neuron_count validator_count miner_count
          captured_at total_stake_tao total_emission_tao
          network_yield validator_yield miner_yield
          distribution { count mean median min max p10 p25 p75 p90 }
        } }`,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_yield, {
      schema_version: 1,
      subnet_count: 0,
      neuron_count: 0,
      validator_count: 0,
      miner_count: 0,
      captured_at: null,
      total_stake_tao: 0,
      total_emission_tao: 0,
      network_yield: null,
      validator_yield: null,
      miner_yield: null,
      distribution: null,
    });
  });

  test("resolves the Postgres-tier card, including the nested distribution", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          subnet_count: 3,
          neuron_count: 500,
          validator_count: 40,
          miner_count: 460,
          captured_at: "2026-07-15T00:00:00.000Z",
          total_stake_tao: 1200000,
          total_emission_tao: 84,
          network_yield: 0.00007,
          validator_yield: 0.00009,
          miner_yield: 0.00002,
          distribution: {
            count: 460,
            mean: 0.00006,
            median: 0.00005,
            min: 0.000001,
            max: 0.0009,
            p10: 0.000005,
            p25: 0.00002,
            p75: 0.00008,
            p90: 0.0002,
          },
        }),
      ),
    };
    const { status, body } = await gql(
      `{ chain_yield {
          subnet_count neuron_count validator_count miner_count captured_at
          network_yield validator_yield miner_yield
          distribution { count mean p90 }
        } }`,
      env,
    );
    assert.equal(status, 200);
    const c = body.data.chain_yield;
    assert.equal(c.subnet_count, 3);
    assert.equal(c.neuron_count, 500);
    assert.equal(c.validator_count, 40);
    assert.equal(c.miner_count, 460);
    assert.equal(c.captured_at, "2026-07-15T00:00:00.000Z");
    assert.equal(c.network_yield, 0.00007);
    assert.equal(c.validator_yield, 0.00009);
    assert.equal(c.miner_yield, 0.00002);
    assert.equal(c.distribution.count, 460);
    assert.equal(c.distribution.mean, 0.00006);
    assert.equal(c.distribution.p90, 0.0002);
  });

  test("forwards to /api/v1/chain/yield with no query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({ schema_version: 1, subnet_count: 0 });
        },
      },
    };
    await gql("{ chain_yield { subnet_count } }", env);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/yield");
    assert.equal(capturedUrl.search, "");
  });

  test("a partial Postgres-tier body degrades to the schema-stable defaults, never null", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      // Every field absent -- the resolver's own ?? defaults must fill them in.
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      `{ chain_yield {
          schema_version subnet_count neuron_count validator_count miner_count
          captured_at total_stake_tao total_emission_tao
          network_yield validator_yield miner_yield distribution { count }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_yield, {
      schema_version: 1,
      subnet_count: 0,
      neuron_count: 0,
      validator_count: 0,
      miner_count: 0,
      captured_at: null,
      total_stake_tao: 0,
      total_emission_tao: 0,
      network_yield: null,
      validator_yield: null,
      miner_yield: null,
      distribution: null,
    });
  });

  test("a distribution present but missing individual fields degrades those to zero, not null, since the field is non-null", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: dataApi(
        Response.json({
          schema_version: 1,
          distribution: {},
        }),
      ),
    };
    const { status, body } = await gql(
      `{ chain_yield { distribution { count mean median min max p10 p25 p75 p90 } } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_yield.distribution, {
      count: 0,
      mean: 0,
      median: 0,
      min: 0,
      max: 0,
      p10: 0,
      p25: 0,
      p75: 0,
      p90: 0,
    });
  });

  test("chain_yield carries the same relationship field complexity weight as its siblings", () => {
    assert.equal(FIELD_COMPLEXITY.chain_yield, FIELD_COMPLEXITY.blocks_summary);
  });
});

describe("graphql — sudo_key (#5896, live chain RPC via sudo-key.mjs)", () => {
  // Stub globalThis.fetch for one test, restore after — mirrors withFetchStub
  // in tests/sudo-key.test.mjs.
  function withFetchStub(stub, fn) {
    const orig = globalThis.fetch;
    globalThis.fetch = stub;
    return Promise.resolve(fn()).finally(() => {
      globalThis.fetch = orig;
    });
  }

  test("resolves the sudo hotkey from a live RPC hit", async () => {
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: "0x" + "11".repeat(32), // a valid 32-byte AccountId32
        }),
      }),
      async () => {
        const { status, body } = await gql(
          "{ sudo_key { schema_version hotkey queried_at } }",
        );
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        const r = body.data.sudo_key;
        assert.equal(r.schema_version, 1);
        assert.equal(typeof r.hotkey, "string");
        assert.ok(r.hotkey.length > 0);
        assert.ok(r.queried_at);
      },
    );
  });

  test("RPC failure degrades hotkey to null, never a GraphQL error", async () => {
    await withFetchStub(
      async () => {
        throw new Error("network unreachable");
      },
      async () => {
        const { status, body } = await gql(
          "{ sudo_key { schema_version hotkey queried_at } }",
        );
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        const r = body.data.sudo_key;
        assert.equal(r.schema_version, 1);
        assert.equal(r.hotkey, null);
        assert.ok(r.queried_at);
      },
    );
  });

  test("a renounced sudo (null storage) resolves hotkey to null without error", async () => {
    await withFetchStub(
      async () => ({ ok: true, json: async () => ({ result: null }) }),
      async () => {
        const { status, body } = await gql("{ sudo_key { hotkey } }");
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        assert.equal(body.data.sudo_key.hotkey, null);
      },
    );
  });
});

describe("graphql — network_parameters (#6343, live chain RPC via network-parameters.mjs)", () => {
  // Stub globalThis.fetch for one test, restore after — mirrors withFetchStub
  // in tests/network-parameters.test.mjs.
  function withFetchStub(stub, fn) {
    const orig = globalThis.fetch;
    globalThis.fetch = stub;
    return Promise.resolve(fn()).finally(() => {
      globalThis.fetch = orig;
    });
  }

  const TAO_WEIGHT_KEY =
    "0x658faa385070e074c85bf6b568cf05556b2684762c3b1e22ffb4a92939298741";
  const STAKE_THRESHOLD_KEY =
    "0x658faa385070e074c85bf6b568cf0555782d99ebaa64a1ba18b3e8cda1047327";
  const COOLDOWN_KEY =
    "0x658faa385070e074c85bf6b568cf0555503e4fe5f139cae8b9d045e82e1c83a2";

  function goldenFetchStub() {
    return async (_url, init) => {
      const key = JSON.parse(init.body).params[0];
      const byKey = {
        [TAO_WEIGHT_KEY]: "0x7a14ae47e17a142e",
        [STAKE_THRESHOLD_KEY]: "0x0010a5d4e8000000", // 1e12 rao = 1000 TAO
        [COOLDOWN_KEY]: "0x201c000000000000", // 7200 blocks
      };
      return {
        ok: true,
        json: async () => ({ jsonrpc: "2.0", id: 1, result: byKey[key] }),
      };
    };
  }

  test("resolves all three fields from live RPC hits", async () => {
    await withFetchStub(goldenFetchStub(), async () => {
      const { status, body } = await gql(
        "{ network_parameters { schema_version tao_weight stake_threshold_tao pending_childkey_cooldown_blocks queried_at } }",
      );
      assert.equal(status, 200);
      assert.equal(body.errors, undefined);
      const r = body.data.network_parameters;
      assert.equal(r.schema_version, 1);
      assert.equal(r.tao_weight, 0.18);
      assert.equal(r.stake_threshold_tao, 1000);
      assert.equal(r.pending_childkey_cooldown_blocks, 7200);
      assert.ok(r.queried_at);
    });
  });

  test("RPC failure degrades every field to null, never a GraphQL error", async () => {
    await withFetchStub(
      async () => {
        throw new Error("network unreachable");
      },
      async () => {
        const { status, body } = await gql(
          "{ network_parameters { schema_version tao_weight stake_threshold_tao pending_childkey_cooldown_blocks queried_at } }",
        );
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        const r = body.data.network_parameters;
        assert.equal(r.schema_version, 1);
        assert.equal(r.tao_weight, null);
        assert.equal(r.stake_threshold_tao, null);
        assert.equal(r.pending_childkey_cooldown_blocks, null);
        assert.ok(r.queried_at);
      },
    );
  });

  test("network_parameters is weighted heavier than a Postgres-tier relationship field, since it hits live chain RPC", () => {
    assert.equal(FIELD_COMPLEXITY.network_parameters, 10);
    assert.ok(
      FIELD_COMPLEXITY.network_parameters > FIELD_COMPLEXITY.chain_weights,
    );
  });
});

describe("graphql — network_randomness (#6990, live chain RPC via randomness.mjs)", () => {
  function kvEnv(payload) {
    return { METAGRAPH_CONTROL: { get: async () => payload } };
  }

  test("resolves the beacon-round status snapshot", async () => {
    const env = kvEnv({
      schema_version: 1,
      last_stored_round: 1200,
      oldest_stored_round: 900,
      stored_round_span: 301,
      queried_at: "2026-07-20T00:00:00.000Z",
    });
    const { status, body } = await gql(
      "{ network_randomness { schema_version last_stored_round oldest_stored_round stored_round_span queried_at } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.network_randomness;
    assert.equal(r.schema_version, 1);
    assert.equal(r.last_stored_round, 1200);
    assert.equal(r.oldest_stored_round, 900);
    assert.equal(r.stored_round_span, 301);
    assert.equal(r.queried_at, "2026-07-20T00:00:00.000Z");
  });

  test("null rounds resolve as a schema-stable card, never a GraphQL error", async () => {
    const env = kvEnv({
      schema_version: 1,
      last_stored_round: null,
      oldest_stored_round: null,
      stored_round_span: null,
      queried_at: "2026-07-20T00:00:00.000Z",
    });
    const { status, body } = await gql(
      "{ network_randomness { last_stored_round stored_round_span queried_at } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.network_randomness;
    assert.equal(r.last_stored_round, null);
    assert.equal(r.stored_round_span, null);
    assert.ok(r.queried_at);
  });

  test("network_randomness is weighted as a live-RPC field", () => {
    assert.equal(
      FIELD_COMPLEXITY.network_randomness,
      FIELD_COMPLEXITY.network_parameters,
    );
  });
});

describe("graphql — evm_address (#6990, live chain RPC via address-mapping.mjs)", () => {
  function kvEnv(payload) {
    return { METAGRAPH_CONTROL: { get: async () => payload } };
  }
  const H160 = "0x1234567890abcdef1234567890abcdef12345678";

  test("resolves the h160 -> ss58 mapping", async () => {
    const env = kvEnv({
      schema_version: 1,
      h160: H160,
      ss58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      queried_at: "2026-07-20T00:00:00.000Z",
    });
    const { status, body } = await gql(
      `{ evm_address(h160: "${H160}") { schema_version h160 ss58 queried_at } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.evm_address;
    assert.equal(r.schema_version, 1);
    assert.equal(r.h160, H160);
    assert.equal(r.ss58, "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
    assert.ok(r.queried_at);
  });

  test("an unresolved mapping resolves with null ss58, never a GraphQL error", async () => {
    const env = kvEnv({
      schema_version: 1,
      h160: H160,
      ss58: null,
      queried_at: "2026-07-20T00:00:00.000Z",
    });
    const { status, body } = await gql(
      `{ evm_address(h160: "${H160}") { h160 ss58 } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.evm_address.ss58, null);
  });

  test("a malformed h160 is a GraphQL BAD_USER_INPUT error, not a card", async () => {
    const { body } = await gql(
      '{ evm_address(h160: "not-an-address") { ss58 } }',
    );
    assert.ok(body.errors, "expected a GraphQL error");
    assert.ok(/h160/i.test(body.errors[0].message));
    assert.equal(body.data?.evm_address ?? null, null);
  });

  test("evm_address is weighted as a live-RPC field", () => {
    assert.equal(
      FIELD_COMPLEXITY.evm_address,
      FIELD_COMPLEXITY.network_parameters,
    );
  });
});

describe("graphql — subnet_recycled (#5691, live chain RPC via subnet-recycled.mjs)", () => {
  // Stub globalThis.fetch for one test, restore after — mirrors withFetchStub
  // in tests/subnet-recycled.test.mjs.
  function withFetchStub(stub, fn) {
    const orig = globalThis.fetch;
    globalThis.fetch = stub;
    return Promise.resolve(fn()).finally(() => {
      globalThis.fetch = orig;
    });
  }

  test("resolves recycled_tao from a live RPC hit", async () => {
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: "0x626ac0f623000000", // little-endian u64 for 154463660642 rao
        }),
      }),
      async () => {
        const { status, body } = await gql(
          "{ subnet_recycled(netuid: 101) { schema_version netuid recycled_tao queried_at } }",
        );
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        const r = body.data.subnet_recycled;
        assert.equal(r.schema_version, 1);
        assert.equal(r.netuid, 101);
        assert.equal(r.recycled_tao, 154.463660642);
        assert.ok(r.queried_at);
      },
    );
  });

  test("RPC failure degrades recycled_tao to null, never a GraphQL error", async () => {
    await withFetchStub(
      async () => {
        throw new Error("network unreachable");
      },
      async () => {
        const { status, body } = await gql(
          "{ subnet_recycled(netuid: 1) { recycled_tao } }",
        );
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        assert.equal(body.data.subnet_recycled.recycled_tao, null);
      },
    );
  });

  test("an out-of-range netuid is BAD_USER_INPUT and never reaches the RPC", async () => {
    let called = false;
    await withFetchStub(
      async () => {
        called = true;
        return { ok: true, json: async () => ({ result: "0x0" }) };
      },
      async () => {
        const { status, body } = await gql(
          "{ subnet_recycled(netuid: 99999) { recycled_tao } }",
        );
        assert.equal(status, 200);
        assert.equal(body.data.subnet_recycled, null);
        assert.ok(
          body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"),
        );
        assert.equal(called, false);
      },
    );
  });

  test("a negative netuid is BAD_USER_INPUT", async () => {
    const { status, body } = await gql(
      "{ subnet_recycled(netuid: -1) { recycled_tao } }",
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });

  test("subnet_recycled is weighted heavier than a Postgres-tier relationship field, since it hits live chain RPC", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_recycled, 10);
    assert.ok(
      FIELD_COMPLEXITY.subnet_recycled > FIELD_COMPLEXITY.chain_weights,
    );
  });
});

describe("graphql — subnet_burn (#6321, live chain RPC via subnet-burn.mjs)", () => {
  // Stub globalThis.fetch for one test, restore after — mirrors withFetchStub
  // in tests/subnet-burn.test.mjs.
  function withFetchStub(stub, fn) {
    const orig = globalThis.fetch;
    globalThis.fetch = stub;
    return Promise.resolve(fn()).finally(() => {
      globalThis.fetch = orig;
    });
  }

  test("resolves burn_tao from a live RPC hit", async () => {
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          result: "0x20a1070000000000", // little-endian u64 for 500000 rao
        }),
      }),
      async () => {
        const { status, body } = await gql(
          "{ subnet_burn(netuid: 1) { schema_version netuid burn_tao queried_at } }",
        );
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        const r = body.data.subnet_burn;
        assert.equal(r.schema_version, 1);
        assert.equal(r.netuid, 1);
        assert.equal(r.burn_tao, 0.0005);
        assert.ok(r.queried_at);
      },
    );
  });

  test("RPC failure degrades burn_tao to null, never a GraphQL error", async () => {
    await withFetchStub(
      async () => {
        throw new Error("network unreachable");
      },
      async () => {
        const { status, body } = await gql(
          "{ subnet_burn(netuid: 1) { burn_tao } }",
        );
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        assert.equal(body.data.subnet_burn.burn_tao, null);
      },
    );
  });

  test("an out-of-range netuid is BAD_USER_INPUT and never reaches the RPC", async () => {
    let called = false;
    await withFetchStub(
      async () => {
        called = true;
        return { ok: true, json: async () => ({ result: "0x0" }) };
      },
      async () => {
        const { status, body } = await gql(
          "{ subnet_burn(netuid: 99999) { burn_tao } }",
        );
        assert.equal(status, 200);
        assert.equal(body.data.subnet_burn, null);
        assert.ok(
          body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"),
        );
        assert.equal(called, false);
      },
    );
  });

  test("a negative netuid is BAD_USER_INPUT", async () => {
    const { status, body } = await gql(
      "{ subnet_burn(netuid: -1) { burn_tao } }",
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
  });

  test("subnet_burn is weighted heavier than a Postgres-tier relationship field, since it hits live chain RPC", () => {
    assert.equal(FIELD_COMPLEXITY.subnet_burn, 10);
    assert.ok(FIELD_COMPLEXITY.subnet_burn > FIELD_COMPLEXITY.chain_weights);
  });
});

describe("graphql — account_balance (#5700, live chain RPC via account-balance.mjs)", () => {
  const SS58 = "5G9hfkx9wGB1CLMT9WXkpHSAiYzjZb5o1Boyq4KAdDhjwrc5";

  // Stub globalThis.fetch for one test, restore after — mirrors withFetchStub
  // in tests/account-balance.test.mjs.
  function withFetchStub(stub, fn) {
    const orig = globalThis.fetch;
    globalThis.fetch = stub;
    return Promise.resolve(fn()).finally(() => {
      globalThis.fetch = orig;
    });
  }

  test("resolves balance_tao (free + reserved) from a live RPC hit", async () => {
    await withFetchStub(
      async () => ({
        ok: true,
        json: async () => ({
          jsonrpc: "2.0",
          id: 1,
          // SCALE AccountInfo (#6506): u32 nonce/consumers/providers/sufficients,
          // then free 2_000_000_000 + reserved 500_000_000 rao (u128 LE) = 2.5 TAO.
          result:
            "0x" +
            "00000000".repeat(4) +
            "00943577000000000000000000000000" +
            "0065cd1d000000000000000000000000",
        }),
      }),
      async () => {
        const { status, body } = await gql(
          `{ account_balance(ss58: "${SS58}") { schema_version ss58 balance_tao queried_at } }`,
        );
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        const r = body.data.account_balance;
        assert.equal(r.schema_version, 1);
        assert.equal(r.ss58, SS58);
        assert.equal(r.balance_tao, 2.5);
        assert.ok(r.queried_at);
      },
    );
  });

  test("RPC failure degrades balance_tao to null, never a GraphQL error", async () => {
    await withFetchStub(
      async () => {
        throw new Error("network unreachable");
      },
      async () => {
        const { status, body } = await gql(
          `{ account_balance(ss58: "${SS58}") { balance_tao } }`,
        );
        assert.equal(status, 200);
        assert.equal(body.errors, undefined);
        assert.equal(body.data.account_balance.balance_tao, null);
      },
    );
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the RPC", async () => {
    let called = false;
    await withFetchStub(
      async () => {
        called = true;
        return { ok: true, json: async () => ({ result: { data: {} } }) };
      },
      async () => {
        const { status, body } = await gql(
          '{ account_balance(ss58: "not-an-address") { balance_tao } }',
        );
        assert.equal(status, 200);
        assert.equal(body.data.account_balance, null);
        assert.ok(
          body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"),
        );
        assert.equal(called, false);
      },
    );
  });

  test("account_balance is weighted at the live-RPC complexity, heavier than a Postgres-tier relationship field", () => {
    assert.equal(FIELD_COMPLEXITY.account_balance, 10);
    assert.ok(
      FIELD_COMPLEXITY.account_balance > FIELD_COMPLEXITY.chain_weights,
    );
  });
});

describe("graphql — registry_leaderboards (#5661, shared composer + REST-matching validation)", () => {
  // Every D1 query in the composer returns no rows, so the boards resolve from
  // an empty projection without a live DB. No profiles artifact is injected, so
  // leaderboardProfilesProjection's module-level cache is never populated —
  // these tests can't leak a projection into each other.
  const emptyHealthDb = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
  };

  // Same shape handleLeaderboards' surface_status aggregate yields; the stub
  // ignores the SQL, so a single board is asserted at a time.
  function healthDb(results) {
    return {
      prepare: () => ({ bind: () => ({ all: async () => ({ results }) }) }),
    };
  }

  test("cold store: every board resolves schema-stable and empty, never null", async () => {
    const { status, body } = await gql(
      `{ registry_leaderboards { schema_version board observed_at source boards } }`,
      { METAGRAPH_HEALTH_DB: emptyHealthDb },
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.registry_leaderboards;
    assert.equal(r.schema_version, 1);
    // No board filter -> every board key present, each an empty ranked list.
    assert.equal(r.board, null);
    assert.equal(r.source, "registry+live-cron-prober");
    for (const key of LEADERBOARD_BOARDS) {
      assert.deepEqual(
        r.boards[key],
        [],
        `board ${key} should be an empty list`,
      );
    }
  });

  // D1 fully eliminated (2026-07-17): this route never had a Postgres-tier
  // mirror for the health/rpc/growth/reliability boards, so composeLeaderboardsData
  // always passes healthRows: [] now rather than adding new tier plumbing --
  // even a "warm" D1 mock (real rows) must not change the response.
  test("an explicit board returns only that board, always empty now that health has no D1 read", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: healthDb([
        { netuid: 7, total: 4, ok_count: 2, avg_latency_ms: 90 },
        { netuid: 3, total: 4, ok_count: 4, avg_latency_ms: 42 },
      ]),
    };
    const { status, body } = await gql(
      `{ registry_leaderboards(board: "healthiest") { board boards } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const r = body.data.registry_leaderboards;
    assert.equal(r.board, "healthiest");
    // Filtered response carries just the requested board, matching REST.
    assert.deepEqual(Object.keys(r.boards), ["healthiest"]);
    assert.deepEqual(r.boards.healthiest, []);
  });

  test("an unknown board is a BAD_USER_INPUT error, not a silent empty board", async () => {
    const { status, body } = await gql(
      `{ registry_leaderboards(board: "not-a-board") { board } }`,
      { METAGRAPH_HEALTH_DB: emptyHealthDb },
    );
    assert.equal(status, 200);
    assert.ok(body.errors?.length, "expected a GraphQL error");
    assert.match(body.errors[0].message, /Unknown board "not-a-board"/);
    assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
    assert.equal(body.data?.registry_leaderboards ?? null, null);
  });

  test("a limit outside REST's 1..100 range is a BAD_USER_INPUT error", async () => {
    for (const limit of [0, 101]) {
      const { body } = await gql(
        `{ registry_leaderboards(limit: ${limit}) { board } }`,
        { METAGRAPH_HEALTH_DB: emptyHealthDb },
      );
      assert.ok(body.errors?.length, `limit ${limit} should error`);
      assert.equal(body.errors[0].extensions.code, "BAD_USER_INPUT");
      assert.match(body.errors[0].message, /between 1 and 100/);
    }
  });

  test("the boundary limits REST accepts are accepted here too", async () => {
    for (const limit of [1, 100]) {
      const { body } = await gql(
        `{ registry_leaderboards(limit: ${limit}) { board } }`,
        { METAGRAPH_HEALTH_DB: emptyHealthDb },
      );
      assert.equal(body.errors, undefined, `limit ${limit} should be accepted`);
    }
  });

  test("is priced as a relationship field — it fans out into several D1 reads", () => {
    assert.equal(
      FIELD_COMPLEXITY.registry_leaderboards,
      FIELD_COMPLEXITY.health_trends,
    );
  });
});

describe("Query.subnet_hyperparameters / subnet_hyperparameters_history", () => {
  const HP_FIELDS =
    "kappa_ratio immunity_period tempo registration_allowed min_burn_tao bonds_moving_avg_raw liquid_alpha_enabled min_childkey_take_ratio";
  const HP_ROW = {
    kappa_ratio: 0.5,
    immunity_period: 4096,
    tempo: 360,
    registration_allowed: true,
    min_burn_tao: 0.5,
    bonds_moving_avg_raw: 900000,
    liquid_alpha_enabled: false,
    min_childkey_take_ratio: 0.1,
  };

  function hpEnv(body) {
    return {
      METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json(body) },
    };
  }

  test("subnet_hyperparameters resolves the Postgres-tier card", async () => {
    const { status, body } = await gql(
      `{ subnet_hyperparameters(netuid: 1) { schema_version netuid captured_at block_number hyperparameters { ${HP_FIELDS} } } }`,
      hpEnv({
        schema_version: 1,
        netuid: 1,
        captured_at: "2026-07-01T00:00:00.000Z",
        block_number: 5000000,
        hyperparameters: HP_ROW,
      }),
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_hyperparameters, {
      schema_version: 1,
      netuid: 1,
      captured_at: "2026-07-01T00:00:00.000Z",
      block_number: 5000000,
      hyperparameters: HP_ROW,
    });
  });

  test("subnet_hyperparameters: a subnet with no captured row resolves to a card with a null block, never an error", async () => {
    const { status, body } = await gql(
      `{ subnet_hyperparameters(netuid: 99) { schema_version netuid captured_at block_number hyperparameters { tempo } } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_hyperparameters, {
      schema_version: 1,
      netuid: 99,
      captured_at: null,
      block_number: null,
      hyperparameters: null,
    });
  });

  test("subnet_hyperparameters: a sparse upstream payload still resolves a schema-stable card", async () => {
    const { status, body } = await gql(
      `{ subnet_hyperparameters(netuid: 7) { schema_version netuid captured_at block_number hyperparameters { tempo } } }`,
      hpEnv({}),
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_hyperparameters, {
      schema_version: 1,
      netuid: 7,
      captured_at: null,
      block_number: null,
      hyperparameters: null,
    });
  });

  test("subnet_hyperparameters requests the subnet's own hyperparameters route", async () => {
    let seen = null;
    await gql(`{ subnet_hyperparameters(netuid: 12) { netuid } }`, {
      METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          seen = new URL(req.url);
          return Response.json({});
        },
      },
    });
    assert.equal(seen.pathname, "/api/v1/subnets/12/hyperparameters");
  });

  test("subnet_hyperparameters_history resolves the Postgres-tier page", async () => {
    const { status, body } = await gql(
      `{ subnet_hyperparameters_history(netuid: 1) { schema_version netuid entry_count limit offset next_cursor entries { block_number observed_at hyperparams_hash hyperparameters { tempo } } } }`,
      hpEnv({
        schema_version: 1,
        netuid: 1,
        entry_count: 1,
        limit: 100,
        offset: 0,
        next_cursor: "abc",
        entries: [
          {
            block_number: 5000000,
            observed_at: "2026-07-01T00:00:00.000Z",
            hyperparams_hash: "deadbeef",
            hyperparameters: { tempo: 360 },
          },
        ],
      }),
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_hyperparameters_history, {
      schema_version: 1,
      netuid: 1,
      entry_count: 1,
      limit: 100,
      offset: 0,
      next_cursor: "abc",
      entries: [
        {
          block_number: 5000000,
          observed_at: "2026-07-01T00:00:00.000Z",
          hyperparams_hash: "deadbeef",
          hyperparameters: { tempo: 360 },
        },
      ],
    });
  });

  test("subnet_hyperparameters_history: no recorded changes resolves to an empty list, never null", async () => {
    const { status, body } = await gql(
      `{ subnet_hyperparameters_history(netuid: 99) { schema_version netuid entry_count limit offset next_cursor entries { block_number } } }`,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_hyperparameters_history, {
      schema_version: 1,
      netuid: 99,
      entry_count: 0,
      limit: 100,
      offset: 0,
      next_cursor: null,
      entries: [],
    });
  });

  test("subnet_hyperparameters_history: a sparse upstream payload falls back to the requested page bounds", async () => {
    const { status, body } = await gql(
      `{ subnet_hyperparameters_history(netuid: 3, limit: 5, offset: 10) { schema_version netuid entry_count limit offset next_cursor entries { block_number } } }`,
      hpEnv({}),
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.subnet_hyperparameters_history, {
      schema_version: 1,
      netuid: 3,
      entry_count: 0,
      limit: 5,
      offset: 10,
      next_cursor: null,
      entries: [],
    });
  });

  test("subnet_hyperparameters_history forwards limit/offset, clamped to the REST feed bounds", async () => {
    let seen = null;
    const env = {
      METAGRAPH_SUBNET_HYPERPARAMS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          seen = new URL(req.url);
          return Response.json({ entries: [] });
        },
      },
    };
    await gql(
      `{ subnet_hyperparameters_history(netuid: 2, limit: 5, offset: 10) { netuid } }`,
      env,
    );
    assert.equal(seen.pathname, "/api/v1/subnets/2/hyperparameters/history");
    assert.equal(seen.searchParams.get("limit"), "5");
    assert.equal(seen.searchParams.get("offset"), "10");

    // Over-wide pages are clamped to MAX_LIMIT rather than forwarded verbatim.
    await gql(
      `{ subnet_hyperparameters_history(netuid: 2, limit: 99999) { netuid } }`,
      env,
    );
    assert.equal(seen.searchParams.get("limit"), "1000");

    // An absent limit/offset falls back to the feed defaults.
    await gql(`{ subnet_hyperparameters_history(netuid: 2) { netuid } }`, env);
    assert.equal(seen.searchParams.get("limit"), "100");
    assert.equal(seen.searchParams.get("offset"), "0");
  });

  test("both fields are priced at the relationship-field complexity weight", () => {
    assert.equal(
      FIELD_COMPLEXITY.subnet_hyperparameters,
      FIELD_COMPLEXITY.subnet_registrations,
    );
    assert.equal(
      FIELD_COMPLEXITY.subnet_hyperparameters_history,
      FIELD_COMPLEXITY.subnet_registrations,
    );
  });
});

describe("Query.account_identity", () => {
  const AI_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
  const AI_FIELDS =
    "schema_version account has_identity name url github image discord description additional captured_at";

  // Same D1 stub shape the account_identity_history tests use.
  function identityD1(rows) {
    return {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: rows }) }),
      }),
    };
  }

  // D1 fully eliminated (2026-07-16): account_identity's D1 write/read path
  // is fully retired, so a tier miss always resolves through
  // buildAccountIdentity(null, ss58) -- even a "warm" D1 mock (real rows)
  // must not change the response.
  test("never queries D1 even when mocked with real rows: has_identity is always false on a tier miss", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: identityD1([
        {
          account: AI_SS58,
          name: "Alice",
          url: "https://example.com",
          github: "https://github.com/alice",
          image: "https://example.com/a.png",
          discord: "alice#1",
          description: "a validator",
          additional: "extra",
          captured_at: 1780000000000,
        },
      ]),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      throw new Error("D1 must not be queried -- account_identity is retired");
    };
    const { status, body } = await gql(
      `{ account_identity(ss58: "${AI_SS58}") { ${AI_FIELDS} } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const got = body.data.account_identity;
    assert.equal(got.schema_version, 1);
    assert.equal(got.account, AI_SS58);
    assert.equal(got.has_identity, false);
    assert.equal(got.name, null);
  });

  test("an account that never set an identity resolves to has_identity:false with null fields, never null", async () => {
    const { status, body } = await gql(
      `{ account_identity(ss58: "${AI_SS58}") { ${AI_FIELDS} } }`,
      { METAGRAPH_HEALTH_DB: identityD1([]) },
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_identity, {
      schema_version: 1,
      account: AI_SS58,
      has_identity: false,
      name: null,
      url: null,
      github: null,
      image: null,
      discord: null,
      description: null,
      additional: null,
      captured_at: null,
    });
  });

  test("the Postgres tier takes precedence over D1", async () => {
    let d1Called = false;
    let seen = null;
    const env = {
      METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          seen = new URL(req.url);
          return Response.json({
            schema_version: 1,
            account: AI_SS58,
            has_identity: true,
            name: "FromPostgres",
            url: null,
            github: null,
            image: null,
            discord: null,
            description: null,
            additional: null,
            captured_at: "2026-07-01T00:00:00.000Z",
          });
        },
      },
      METAGRAPH_HEALTH_DB: {
        prepare: () => {
          d1Called = true;
          return { bind: () => ({ all: async () => ({ results: [] }) }) };
        },
      },
    };
    const { status, body } = await gql(
      `{ account_identity(ss58: "${AI_SS58}") { ${AI_FIELDS} } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.account_identity.name, "FromPostgres");
    assert.equal(body.data.account_identity.has_identity, true);
    assert.equal(seen.pathname, `/api/v1/accounts/${AI_SS58}/identity`);
    // The `??` short-circuits: D1 is only read when the tier returns nothing.
    assert.equal(d1Called, false);
  });

  test("a sparse upstream payload still resolves a schema-stable card", async () => {
    const { status, body } = await gql(
      `{ account_identity(ss58: "${AI_SS58}") { ${AI_FIELDS} } }`,
      {
        METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres",
        DATA_API: { fetch: async () => Response.json({}) },
      },
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.account_identity, {
      schema_version: 1,
      account: AI_SS58,
      has_identity: false,
      name: null,
      url: null,
      github: null,
      image: null,
      discord: null,
      description: null,
      additional: null,
      captured_at: null,
    });
  });

  test("an invalid ss58 is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_IDENTITY_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      '{ account_identity(ss58: "not-a-valid-address") { account } }',
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(
      FIELD_COMPLEXITY.account_identity,
      FIELD_COMPLEXITY.account_identity_history,
    );
  });
});

describe("graphql — chain_prometheus (#5874, Postgres-tier + D1-live fallback)", () => {
  function prometheusQuery(argsClause) {
    return `{ chain_prometheus${argsClause} {
      schema_version window observed_at subnet_count
      network { distinct_exporters announcements announcements_per_exporter }
      intensity_distribution { count mean min p25 median p75 p90 max }
      subnets { netuid distinct_exporters announcements announcements_per_exporter }
    } }`;
  }

  // Mirrors chainServingD1: loadChainPrometheus issues the network aggregate
  // (COUNT DISTINCT hotkey / MAX(observed_at), no GROUP BY) and only then the
  // GROUP BY netuid leaderboard, and only when newest_observed is non-null.
  function chainPrometheusD1({ network, subnets = [] } = {}) {
    return {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes("GROUP BY netuid")) {
                  return { results: subnets };
                }
                return { results: network ? [network] : [] };
              },
            };
          },
        };
      },
    };
  }

  test("cold store, default args: schema-stable empty leaderboard, never an error", async () => {
    const { status, body } = await gql(prometheusQuery(""));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_prometheus, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      subnet_count: 0,
      network: {
        distinct_exporters: 0,
        announcements: 0,
        announcements_per_exporter: null,
      },
      intensity_distribution: null,
      subnets: [],
    });
  });

  // #4909/#6013: account_events' D1 write path is retired and the table is
  // dropped in production, so this resolver no longer queries D1 at all --
  // even a "warm" D1 mock (real rows) must not change the response.
  test("never queries D1 even when mocked with real rows (retired -- #4909/#6013)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: chainPrometheusD1({
        network: { distinct_exporters: 3, newest_observed: 1780000000000 },
        subnets: [
          { netuid: 1, announcements: 10, distinct_exporters: 2 },
          { netuid: 7, announcements: 4, distinct_exporters: 2 },
        ],
      }),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      throw new Error("D1 must not be queried -- account_events is retired");
    };
    const { status, body } = await gql(prometheusQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const got = body.data.chain_prometheus;
    assert.equal(got.subnet_count, 0);
    assert.deepEqual(got.subnets, []);
  });

  test("resolves Postgres-tier data for a valid non-default window/limit, forwarding both as query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            observed_at: "2026-07-01T00:00:00.000Z",
            subnet_count: 1,
            network: {
              distinct_exporters: 5,
              announcements: 20,
              announcements_per_exporter: 4,
            },
            intensity_distribution: {
              count: 1,
              mean: 4,
              min: 4,
              p25: 4,
              median: 4,
              p75: 4,
              p90: 4,
              max: 4,
            },
            subnets: [
              {
                netuid: 3,
                distinct_exporters: 5,
                announcements: 20,
                announcements_per_exporter: 4,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      prometheusQuery('(window: "30d", limit: 5)'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/prometheus");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(body.data.chain_prometheus.window, "30d");
    assert.equal(body.data.chain_prometheus.subnet_count, 1);
    assert.equal(body.data.chain_prometheus.network.distinct_exporters, 5);
  });

  test("a sparse Postgres-tier payload still resolves a schema-stable card", async () => {
    // The tier's shape is upstream-controlled, so every field falls back rather
    // than surfacing null through a non-null SDL field.
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(prometheusQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_prometheus, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      subnet_count: 0,
      network: {
        distinct_exporters: 0,
        announcements: 0,
        announcements_per_exporter: null,
      },
      intensity_distribution: null,
      subnets: [],
    });
  });

  test("clamps an over-max limit to the route's own ceiling", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(prometheusQuery("(limit: 99999)"), env);
    assert.equal(capturedUrl.searchParams.get("limit"), "100");
  });

  test("every documented window is accepted", async () => {
    for (const window of Object.keys(CHAIN_PROMETHEUS_WINDOWS)) {
      const { status, body } = await gql(
        prometheusQuery(`(window: "${window}")`),
      );
      assert.equal(status, 200, window);
      assert.equal(body.errors, undefined);
      assert.equal(body.data.chain_prometheus.window, window);
    }
  });

  test("an unsupported window is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(prometheusQuery('(window: "1y")'), env);
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(
      FIELD_COMPLEXITY.chain_prometheus,
      FIELD_COMPLEXITY.chain_serving,
    );
  });
});

describe("graphql — chain_axon_removals (#5875, Postgres-tier + D1-live fallback)", () => {
  function removalsQuery(argsClause) {
    return `{ chain_axon_removals${argsClause} {
      schema_version window observed_at subnet_count
      network { distinct_removers removals removals_per_remover }
      intensity_distribution { count mean min p25 median p75 p90 max }
      subnets { netuid distinct_removers removals removals_per_remover }
    } }`;
  }

  // loadChainAxonRemovals issues the network aggregate (COUNT DISTINCT hotkey /
  // MAX(observed_at), no GROUP BY) and only then the GROUP BY netuid
  // leaderboard, and only when newest_observed is non-null.
  function chainAxonRemovalsD1({ network, subnets = [] } = {}) {
    return {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes("GROUP BY netuid")) {
                  return { results: subnets };
                }
                return { results: network ? [network] : [] };
              },
            };
          },
        };
      },
    };
  }

  test("cold store, default args: schema-stable empty leaderboard, never an error", async () => {
    const { status, body } = await gql(removalsQuery(""));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_axon_removals, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      subnet_count: 0,
      network: {
        distinct_removers: 0,
        removals: 0,
        removals_per_remover: null,
      },
      intensity_distribution: null,
      subnets: [],
    });
  });

  // #4909/#6013: account_events' D1 write path is retired and the table is
  // dropped in production, so this resolver no longer queries D1 at all --
  // even a "warm" D1 mock (real rows) must not change the response.
  test("never queries D1 even when mocked with real rows (retired -- #4909/#6013)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: chainAxonRemovalsD1({
        network: { distinct_removers: 3, newest_observed: 1780000000000 },
        subnets: [
          { netuid: 1, removals: 9, distinct_removers: 3 },
          { netuid: 7, removals: 3, distinct_removers: 1 },
        ],
      }),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      throw new Error("D1 must not be queried -- account_events is retired");
    };
    const { status, body } = await gql(removalsQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const got = body.data.chain_axon_removals;
    assert.equal(got.subnet_count, 0);
    assert.deepEqual(got.subnets, []);
  });

  test("resolves Postgres-tier data for a valid non-default window/limit, forwarding both as query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            observed_at: "2026-07-01T00:00:00.000Z",
            subnet_count: 1,
            network: {
              distinct_removers: 5,
              removals: 20,
              removals_per_remover: 4,
            },
            intensity_distribution: {
              count: 1,
              mean: 4,
              min: 4,
              p25: 4,
              median: 4,
              p75: 4,
              p90: 4,
              max: 4,
            },
            subnets: [
              {
                netuid: 3,
                distinct_removers: 5,
                removals: 20,
                removals_per_remover: 4,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      removalsQuery('(window: "30d", limit: 5)'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/axon-removals");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(body.data.chain_axon_removals.window, "30d");
    assert.equal(body.data.chain_axon_removals.network.distinct_removers, 5);
  });

  test("a sparse Postgres-tier payload still resolves a schema-stable card", async () => {
    // The tier's shape is upstream-controlled, so every field falls back rather
    // than surfacing null through a non-null SDL field.
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(removalsQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_axon_removals, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      subnet_count: 0,
      network: {
        distinct_removers: 0,
        removals: 0,
        removals_per_remover: null,
      },
      intensity_distribution: null,
      subnets: [],
    });
  });

  test("clamps an over-max limit to the route's own ceiling", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(removalsQuery("(limit: 99999)"), env);
    assert.equal(capturedUrl.searchParams.get("limit"), "100");
  });

  test("every documented window is accepted", async () => {
    for (const window of Object.keys(CHAIN_AXON_REMOVALS_WINDOWS)) {
      const { status, body } = await gql(
        removalsQuery(`(window: "${window}")`),
      );
      assert.equal(status, 200, window);
      assert.equal(body.errors, undefined);
      assert.equal(body.data.chain_axon_removals.window, window);
    }
  });

  test("an unsupported window is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(removalsQuery('(window: "1y")'), env);
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(
      FIELD_COMPLEXITY.chain_axon_removals,
      FIELD_COMPLEXITY.chain_serving,
    );
  });
});

describe("graphql — chain_registrations (#5876, Postgres-tier + D1-live fallback)", () => {
  function regQuery(argsClause) {
    return `{ chain_registrations${argsClause} {
      schema_version window observed_at subnet_count
      network { distinct_registrants registrations registrations_per_registrant }
      intensity_distribution { count mean min p25 median p75 p90 max }
      subnets { netuid distinct_registrants registrations registrations_per_registrant }
    } }`;
  }

  // loadChainRegistrations issues the network aggregate (COUNT DISTINCT hotkey
  // / MAX(observed_at), no GROUP BY) and only then the GROUP BY netuid
  // leaderboard, and only when newest_observed is non-null.
  function chainRegD1({ network, subnets = [] } = {}) {
    return {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes("GROUP BY netuid")) {
                  return { results: subnets };
                }
                return { results: network ? [network] : [] };
              },
            };
          },
        };
      },
    };
  }

  test("cold store, default args: schema-stable empty leaderboard, never an error", async () => {
    const { status, body } = await gql(regQuery(""));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_registrations, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      subnet_count: 0,
      network: {
        distinct_registrants: 0,
        registrations: 0,
        registrations_per_registrant: null,
      },
      intensity_distribution: null,
      subnets: [],
    });
  });

  // #4909/#6013: account_events' D1 write path is retired and the table is
  // dropped in production, so this resolver no longer queries D1 at all --
  // even a "warm" D1 mock (real rows) must not change the response.
  test("never queries D1 even when mocked with real rows (retired -- #4909/#6013)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: chainRegD1({
        network: {
          distinct_registrants: 3,
          newest_observed: 1780000000000,
        },
        subnets: [
          { netuid: 1, registrations: 9, distinct_registrants: 3 },
          { netuid: 7, registrations: 3, distinct_registrants: 1 },
        ],
      }),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      throw new Error("D1 must not be queried -- account_events is retired");
    };
    const { status, body } = await gql(regQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const got = body.data.chain_registrations;
    assert.equal(got.subnet_count, 0);
    assert.deepEqual(got.subnets, []);
  });

  test("resolves Postgres-tier data for a valid non-default window/limit, forwarding both as query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            observed_at: "2026-07-01T00:00:00.000Z",
            subnet_count: 1,
            network: {
              distinct_registrants: 5,
              registrations: 20,
              registrations_per_registrant: 4,
            },
            intensity_distribution: {
              count: 1,
              mean: 4,
              min: 4,
              p25: 4,
              median: 4,
              p75: 4,
              p90: 4,
              max: 4,
            },
            subnets: [
              {
                netuid: 3,
                distinct_registrants: 5,
                registrations: 20,
                registrations_per_registrant: 4,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      regQuery('(window: "30d", limit: 5)'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/registrations");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(body.data.chain_registrations.window, "30d");
    assert.equal(body.data.chain_registrations.network.distinct_registrants, 5);
  });

  test("a sparse Postgres-tier payload still resolves a schema-stable card", async () => {
    // The tier's shape is upstream-controlled, so every field falls back rather
    // than surfacing null through a non-null SDL field.
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(regQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_registrations, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      subnet_count: 0,
      network: {
        distinct_registrants: 0,
        registrations: 0,
        registrations_per_registrant: null,
      },
      intensity_distribution: null,
      subnets: [],
    });
  });

  test("clamps an over-max limit to the route's own ceiling", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(regQuery("(limit: 99999)"), env);
    assert.equal(capturedUrl.searchParams.get("limit"), "100");
  });

  test("every documented window is accepted", async () => {
    for (const window of Object.keys(CHAIN_REGISTRATIONS_WINDOWS)) {
      const { status, body } = await gql(regQuery(`(window: "${window}")`));
      assert.equal(status, 200, window);
      assert.equal(body.errors, undefined);
      assert.equal(body.data.chain_registrations.window, window);
    }
  });

  test("an unsupported window is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(regQuery('(window: "1y")'), env);
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(
      FIELD_COMPLEXITY.chain_registrations,
      FIELD_COMPLEXITY.chain_serving,
    );
  });
});

describe("graphql — chain_deregistrations (#5877, Postgres-tier + D1-live fallback)", () => {
  function deregQuery(argsClause) {
    return `{ chain_deregistrations${argsClause} {
      schema_version window observed_at subnet_count
      network { distinct_deregistered_hotkeys deregistrations deregistrations_per_hotkey }
      intensity_distribution { count mean min p25 median p75 p90 max }
      subnets { netuid distinct_deregistered_hotkeys deregistrations deregistrations_per_hotkey }
    } }`;
  }

  // loadChainDeregistrations issues the network aggregate (COUNT DISTINCT hotkey
  // / MAX(observed_at), no GROUP BY) and only then the GROUP BY netuid
  // leaderboard, and only when newest_observed is non-null.
  function chainDeregD1({ network, subnets = [] } = {}) {
    return {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes("GROUP BY netuid")) {
                  return { results: subnets };
                }
                return { results: network ? [network] : [] };
              },
            };
          },
        };
      },
    };
  }

  test("cold store, default args: schema-stable empty leaderboard, never an error", async () => {
    const { status, body } = await gql(deregQuery(""));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_deregistrations, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      subnet_count: 0,
      network: {
        distinct_deregistered_hotkeys: 0,
        deregistrations: 0,
        deregistrations_per_hotkey: null,
      },
      intensity_distribution: null,
      subnets: [],
    });
  });

  // #4909/#6013: account_events' D1 write path is retired and the table is
  // dropped in production, so this resolver no longer queries D1 at all --
  // even a "warm" D1 mock (real rows) must not change the response.
  test("never queries D1 even when mocked with real rows (retired -- #4909/#6013)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: chainDeregD1({
        network: {
          distinct_deregistered_hotkeys: 3,
          newest_observed: 1780000000000,
        },
        subnets: [
          { netuid: 1, deregistrations: 9, distinct_deregistered_hotkeys: 3 },
          { netuid: 7, deregistrations: 3, distinct_deregistered_hotkeys: 1 },
        ],
      }),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      throw new Error("D1 must not be queried -- account_events is retired");
    };
    const { status, body } = await gql(deregQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const got = body.data.chain_deregistrations;
    assert.equal(got.subnet_count, 0);
    assert.deepEqual(got.subnets, []);
  });

  test("resolves Postgres-tier data for a valid non-default window/limit, forwarding both as query params", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            observed_at: "2026-07-01T00:00:00.000Z",
            subnet_count: 1,
            network: {
              distinct_deregistered_hotkeys: 5,
              deregistrations: 20,
              deregistrations_per_hotkey: 4,
            },
            intensity_distribution: {
              count: 1,
              mean: 4,
              min: 4,
              p25: 4,
              median: 4,
              p75: 4,
              p90: 4,
              max: 4,
            },
            subnets: [
              {
                netuid: 3,
                distinct_deregistered_hotkeys: 5,
                deregistrations: 20,
                deregistrations_per_hotkey: 4,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      deregQuery('(window: "30d", limit: 5)'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/deregistrations");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(body.data.chain_deregistrations.window, "30d");
    assert.equal(
      body.data.chain_deregistrations.network.distinct_deregistered_hotkeys,
      5,
    );
  });

  test("a sparse Postgres-tier payload still resolves a schema-stable card", async () => {
    // The tier's shape is upstream-controlled, so every field falls back rather
    // than surfacing null through a non-null SDL field.
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(deregQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_deregistrations, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      subnet_count: 0,
      network: {
        distinct_deregistered_hotkeys: 0,
        deregistrations: 0,
        deregistrations_per_hotkey: null,
      },
      intensity_distribution: null,
      subnets: [],
    });
  });

  test("clamps an over-max limit to the route's own ceiling", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(deregQuery("(limit: 99999)"), env);
    assert.equal(capturedUrl.searchParams.get("limit"), "100");
  });

  test("every documented window is accepted", async () => {
    for (const window of Object.keys(CHAIN_DEREGISTRATIONS_WINDOWS)) {
      const { status, body } = await gql(deregQuery(`(window: "${window}")`));
      assert.equal(status, 200, window);
      assert.equal(body.errors, undefined);
      assert.equal(body.data.chain_deregistrations.window, window);
    }
  });

  test("an unsupported window is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(deregQuery('(window: "1y")'), env);
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(
      FIELD_COMPLEXITY.chain_deregistrations,
      FIELD_COMPLEXITY.chain_serving,
    );
  });
});

describe("graphql — chain_signers (#5882, Postgres-tier + D1-live fallback)", () => {
  const SIGNER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  function signersQuery(argsClause) {
    return `{ chain_signers${argsClause} {
      schema_version window sort observed_at signer_count
      signers { signer tx_count total_fee_tao total_tip_tao last_tx_block }
    } }`;
  }

  // loadChainSigners issues one ranked extrinsics-tier read; the rows carry the
  // per-signer aggregate.
  function signersD1(rows = []) {
    return {
      prepare: () => ({
        bind: () => ({ all: async () => ({ results: rows }) }),
      }),
    };
  }

  test("cold store, default args: schema-stable empty leaderboard, never an error", async () => {
    const { status, body } = await gql(signersQuery(""));
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_signers, {
      schema_version: 1,
      window: "7d",
      sort: "tx_count",
      observed_at: null,
      signer_count: 0,
      signers: [],
    });
  });

  // #4772 D1 retirement: the `extrinsics` D1 table is dropped in
  // production, so this resolver no longer queries D1 at all -- even a
  // "warm" D1 mock (real rows) must not change the response.
  test("never queries D1 even when mocked with real rows (retired -- #4772)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: signersD1([
        {
          signer: SIGNER,
          tx_count: 12,
          total_fee_tao: 1.5,
          total_tip_tao: 0.25,
          last_tx_block: 5000000,
        },
      ]),
    };
    env.METAGRAPH_HEALTH_DB.prepare = () => {
      throw new Error("D1 must not be queried -- extrinsics is retired");
    };
    const { status, body } = await gql(signersQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    const got = body.data.chain_signers;
    assert.equal(got.signer_count, 0);
    assert.deepEqual(got.signers, []);
  });

  test("resolves Postgres-tier data, forwarding window/limit/sort/call_module", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            sort: "total_fee_tao",
            observed_at: "2026-07-01T00:00:00.000Z",
            signer_count: 1,
            signers: [
              {
                signer: SIGNER,
                tx_count: 3,
                total_fee_tao: 9.5,
                total_tip_tao: 0,
                last_tx_block: 42,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      signersQuery(
        '(window: "30d", limit: 5, sort: "total_fee_tao", call_module: "Balances")',
      ),
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/signers");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(capturedUrl.searchParams.get("sort"), "total_fee_tao");
    assert.equal(capturedUrl.searchParams.get("call_module"), "Balances");
    assert.equal(body.data.chain_signers.sort, "total_fee_tao");
    assert.equal(body.data.chain_signers.signers[0].total_fee_tao, 9.5);
  });

  test("omits the optional sort/call_module params when the caller supplies neither", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({ signers: [] });
        },
      },
    };
    await gql(signersQuery(""), env);
    assert.equal(capturedUrl.searchParams.get("sort"), null);
    assert.equal(capturedUrl.searchParams.get("call_module"), null);
    assert.equal(capturedUrl.searchParams.get("window"), "7d");
    assert.equal(capturedUrl.searchParams.get("limit"), "50");
  });

  test("a sparse Postgres-tier payload still resolves a schema-stable card", async () => {
    // The tier's shape is upstream-controlled, so every field falls back rather
    // than surfacing null through a non-null SDL field.
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(signersQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_signers, {
      schema_version: 1,
      window: "7d",
      sort: "tx_count",
      observed_at: null,
      signer_count: 0,
      signers: [],
    });
  });

  test("a signer row missing every optional metric resolves to nulls, not an error", async () => {
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => Response.json({ signers: [{ signer: SIGNER }] }),
      },
    };
    const { status, body } = await gql(signersQuery(""), env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_signers.signers, [
      {
        signer: SIGNER,
        tx_count: 0,
        total_fee_tao: null,
        total_tip_tao: null,
        last_tx_block: null,
      },
    ]);
  });

  test("clamps an over-max limit to the route's own ceiling", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({});
        },
      },
    };
    await gql(signersQuery("(limit: 99999)"), env);
    assert.equal(capturedUrl.searchParams.get("limit"), "100");
  });

  test("every documented sort is accepted", async () => {
    for (const sort of CHAIN_SIGNERS_SORTS) {
      const { status, body } = await gql(signersQuery(`(sort: "${sort}")`));
      assert.equal(status, 200, sort);
      assert.equal(body.errors, undefined);
      assert.equal(body.data.chain_signers.sort, sort);
    }
  });

  test("an unsupported sort is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      signersQuery('(sort: "not_a_real_sort")'),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("an unsupported window is BAD_USER_INPUT and never reaches the Postgres tier", async () => {
    let called = false;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(signersQuery('(window: "1y")'), env);
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("an over-long call_module is BAD_USER_INPUT, matching REST's 100-char bound", async () => {
    let called = false;
    const env = {
      METAGRAPH_EXTRINSICS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(
      signersQuery(`(call_module: "${"x".repeat(101)}")`),
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(called, false);
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(
      FIELD_COMPLEXITY.chain_signers,
      FIELD_COMPLEXITY.chain_weight_setters,
    );
  });
});

describe("graphql — chain_idle_stake (#6975, Postgres-tier + cold-store fallback)", () => {
  const query = `{ chain_idle_stake {
    schema_version captured_at subnet_count total_idle_stake_tao
    subnets { netuid neuron_count idle_neuron_count idle_stake_tao }
  } }`;

  test("cold store: schema-stable empty ranking, never an error", async () => {
    const { status, body } = await gql(query);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_idle_stake, {
      schema_version: 1,
      captured_at: null,
      subnet_count: 0,
      total_idle_stake_tao: 0,
      subnets: [],
    });
  });

  test("resolves Postgres-tier data", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            captured_at: "2026-07-20T00:00:00.000Z",
            subnet_count: 1,
            total_idle_stake_tao: 12.5,
            subnets: [
              {
                netuid: 7,
                neuron_count: 10,
                idle_neuron_count: 3,
                idle_stake_tao: 12.5,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(query, env);
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/idle-stake");
    assert.equal(body.data.chain_idle_stake.subnet_count, 1);
    assert.equal(body.data.chain_idle_stake.total_idle_stake_tao, 12.5);
    assert.equal(body.data.chain_idle_stake.subnets[0].netuid, 7);
  });

  test("a malformed Postgres-tier body falls back to schema-stable defaults", async () => {
    const env = {
      METAGRAPH_NEURONS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(query, env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_idle_stake.subnet_count, 0);
    assert.equal(body.data.chain_idle_stake.total_idle_stake_tao, 0);
    assert.deepEqual(body.data.chain_idle_stake.subnets, []);
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(
      FIELD_COMPLEXITY.chain_idle_stake,
      FIELD_COMPLEXITY.chain_yield,
    );
  });
});

describe("graphql — chain_stake_flow (#6975, Postgres-tier + cold-store fallback)", () => {
  function flowQuery(argsClause = "") {
    return `{ chain_stake_flow${argsClause} {
      schema_version window observed_at subnet_count
      network {
        total_staked_tao total_unstaked_tao net_flow_tao gross_flow_tao
        stake_events unstake_events gaining losing flat
      }
      net_flow_distribution { count mean min p25 median p75 p90 max }
      subnets {
        netuid total_staked_tao total_unstaked_tao net_flow_tao gross_flow_tao
        stake_events unstake_events direction
      }
    } }`;
  }

  test("cold store, default args: schema-stable zeroed card", async () => {
    const { status, body } = await gql(flowQuery());
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_stake_flow, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      subnet_count: 0,
      network: {
        total_staked_tao: 0,
        total_unstaked_tao: 0,
        net_flow_tao: 0,
        gross_flow_tao: 0,
        stake_events: 0,
        unstake_events: 0,
        gaining: 0,
        losing: 0,
        flat: 0,
      },
      net_flow_distribution: null,
      subnets: [],
    });
  });

  test("resolves Postgres-tier data for a non-default window/limit", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            observed_at: "2026-07-20T00:00:00.000Z",
            subnet_count: 1,
            network: {
              total_staked_tao: 100,
              total_unstaked_tao: 40,
              net_flow_tao: 60,
              gross_flow_tao: 140,
              stake_events: 5,
              unstake_events: 2,
              gaining: 1,
              losing: 0,
              flat: 0,
            },
            net_flow_distribution: {
              count: 1,
              mean: 60,
              min: 60,
              p25: 60,
              median: 60,
              p75: 60,
              p90: 60,
              max: 60,
            },
            subnets: [
              {
                netuid: 3,
                total_staked_tao: 100,
                total_unstaked_tao: 40,
                net_flow_tao: 60,
                gross_flow_tao: 140,
                stake_events: 5,
                unstake_events: 2,
                direction: "inflow",
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      flowQuery('(window: "30d", limit: 5)'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/stake-flow");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("limit"), "5");
    assert.equal(body.data.chain_stake_flow.window, "30d");
    assert.equal(body.data.chain_stake_flow.subnet_count, 1);
    assert.equal(body.data.chain_stake_flow.network.net_flow_tao, 60);
    assert.equal(body.data.chain_stake_flow.subnets[0].direction, "inflow");
  });

  test("unsupported window is BAD_USER_INPUT", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(flowQuery('(window: "1y")'), env);
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("malformed Postgres body falls back to schema-stable defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(flowQuery(), env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_stake_flow.subnet_count, 0);
    assert.equal(body.data.chain_stake_flow.network.stake_events, 0);
    assert.deepEqual(body.data.chain_stake_flow.subnets, []);
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(
      FIELD_COMPLEXITY.chain_stake_flow,
      FIELD_COMPLEXITY.chain_weights,
    );
  });
});

describe("graphql — chain_stake_moves (#6975, Postgres-tier + cold-store fallback)", () => {
  function movesQuery(argsClause = "") {
    return `{ chain_stake_moves${argsClause} {
      schema_version window observed_at subnet_count
      network { distinct_movers movements movements_per_mover }
      intensity_distribution { count mean min p25 median p75 p90 max }
      subnets { netuid distinct_movers movements movements_per_mover }
    } }`;
  }

  test("cold store, default args: schema-stable zeroed card", async () => {
    const { status, body } = await gql(movesQuery());
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_stake_moves, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      subnet_count: 0,
      network: {
        distinct_movers: 0,
        movements: 0,
        movements_per_mover: null,
      },
      intensity_distribution: null,
      subnets: [],
    });
  });

  test("resolves Postgres-tier data for a non-default window/limit", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            observed_at: "2026-07-20T00:00:00.000Z",
            subnet_count: 1,
            network: {
              distinct_movers: 4,
              movements: 12,
              movements_per_mover: 3,
            },
            intensity_distribution: {
              count: 1,
              mean: 3,
              min: 3,
              p25: 3,
              median: 3,
              p75: 3,
              p90: 3,
              max: 3,
            },
            subnets: [
              {
                netuid: 5,
                distinct_movers: 4,
                movements: 12,
                movements_per_mover: 3,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      movesQuery('(window: "30d", limit: 8)'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/stake-moves");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("limit"), "8");
    assert.equal(body.data.chain_stake_moves.network.movements, 12);
    assert.equal(body.data.chain_stake_moves.subnets[0].netuid, 5);
  });

  test("unsupported window is BAD_USER_INPUT", async () => {
    const { status, body } = await gql(movesQuery('(window: "90d")'));
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
  });

  test("malformed Postgres body falls back to schema-stable defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(movesQuery(), env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_stake_moves.window, "7d");
    assert.equal(body.data.chain_stake_moves.subnet_count, 0);
    assert.equal(body.data.chain_stake_moves.network.movements, 0);
    assert.equal(body.data.chain_stake_moves.intensity_distribution, null);
    assert.deepEqual(body.data.chain_stake_moves.subnets, []);
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(
      FIELD_COMPLEXITY.chain_stake_moves,
      FIELD_COMPLEXITY.chain_registrations,
    );
  });
});

describe("graphql — chain_stake_transfers (#6975, Postgres-tier + cold-store fallback)", () => {
  function transfersQuery(argsClause = "") {
    return `{ chain_stake_transfers${argsClause} {
      schema_version window observed_at subnet_count
      network { distinct_senders transfers transfers_per_sender }
      intensity_distribution { count mean min p25 median p75 p90 max }
      subnets { netuid distinct_senders transfers transfers_per_sender }
    } }`;
  }

  test("cold store, default args: schema-stable zeroed card", async () => {
    const { status, body } = await gql(transfersQuery());
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_stake_transfers, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      subnet_count: 0,
      network: {
        distinct_senders: 0,
        transfers: 0,
        transfers_per_sender: null,
      },
      intensity_distribution: null,
      subnets: [],
    });
  });

  test("resolves Postgres-tier data for a non-default window/limit", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            observed_at: "2026-07-20T00:00:00.000Z",
            subnet_count: 1,
            network: {
              distinct_senders: 2,
              transfers: 6,
              transfers_per_sender: 3,
            },
            intensity_distribution: {
              count: 1,
              mean: 3,
              min: 3,
              p25: 3,
              median: 3,
              p75: 3,
              p90: 3,
              max: 3,
            },
            subnets: [
              {
                netuid: 9,
                distinct_senders: 2,
                transfers: 6,
                transfers_per_sender: 3,
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      transfersQuery('(window: "30d", limit: 3)'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/stake-transfers");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("limit"), "3");
    assert.equal(body.data.chain_stake_transfers.network.transfers, 6);
    assert.equal(body.data.chain_stake_transfers.subnets[0].netuid, 9);
  });

  test("unsupported window is BAD_USER_INPUT", async () => {
    const { status, body } = await gql(transfersQuery('(window: "1y")'));
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
  });

  test("malformed Postgres body falls back to schema-stable defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(transfersQuery(), env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_stake_transfers.subnet_count, 0);
    assert.deepEqual(body.data.chain_stake_transfers.subnets, []);
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(
      FIELD_COMPLEXITY.chain_stake_transfers,
      FIELD_COMPLEXITY.chain_stake_moves,
    );
  });
});

describe("graphql — chain_transfer_pairs (#6975, Postgres-tier + cold-store fallback)", () => {
  function pairsQuery(argsClause = "") {
    return `{ chain_transfer_pairs${argsClause} {
      schema_version window sort observed_at
      total_volume_tao transfer_count unique_pairs pair_count top_pair_share
      pairs { from to volume_tao transfer_count last_block last_observed_at }
    } }`;
  }

  test("cold store, default args: schema-stable zeroed card", async () => {
    const { status, body } = await gql(pairsQuery());
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_transfer_pairs, {
      schema_version: 1,
      window: "7d",
      sort: "volume",
      observed_at: null,
      total_volume_tao: 0,
      transfer_count: 0,
      unique_pairs: 0,
      pair_count: 0,
      top_pair_share: null,
      pairs: [],
    });
  });

  test("resolves Postgres-tier data forwarding window/sort/limit", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            sort: "count",
            observed_at: "2026-07-20T00:00:00.000Z",
            total_volume_tao: 250,
            transfer_count: 10,
            unique_pairs: 2,
            pair_count: 1,
            top_pair_share: 0.8,
            pairs: [
              {
                from: "5Sender",
                to: "5Receiver",
                volume_tao: 200,
                transfer_count: 8,
                last_block: 1000,
                last_observed_at: "2026-07-20T00:00:00.000Z",
              },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      pairsQuery('(window: "30d", sort: "count", limit: 10)'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/transfer-pairs");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("sort"), "count");
    assert.equal(capturedUrl.searchParams.get("limit"), "10");
    assert.equal(body.data.chain_transfer_pairs.sort, "count");
    assert.equal(body.data.chain_transfer_pairs.pairs[0].from, "5Sender");
  });

  test("unsupported window is BAD_USER_INPUT", async () => {
    const { status, body } = await gql(pairsQuery('(window: "90d")'));
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
  });

  test("unsupported sort is BAD_USER_INPUT", async () => {
    let called = false;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async () => {
          called = true;
          return Response.json({});
        },
      },
    };
    const { status, body } = await gql(pairsQuery('(sort: "fee")'), env);
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
    assert.equal(called, false);
  });

  test("malformed Postgres body falls back to schema-stable defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(pairsQuery(), env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_transfer_pairs.pair_count, 0);
    assert.deepEqual(body.data.chain_transfer_pairs.pairs, []);
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(
      FIELD_COMPLEXITY.chain_transfer_pairs,
      FIELD_COMPLEXITY.chain_transfers,
    );
  });
});

describe("graphql — chain_transfers (#6975, Postgres-tier + cold-store fallback)", () => {
  function xfersQuery(argsClause = "") {
    return `{ chain_transfers${argsClause} {
      schema_version window observed_at
      total_volume_tao transfer_count unique_senders unique_receivers top_sender_share
      top_senders { address volume_tao transfer_count }
      top_receivers { address volume_tao transfer_count }
    } }`;
  }

  test("cold store, default args: schema-stable zeroed card", async () => {
    const { status, body } = await gql(xfersQuery());
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_transfers, {
      schema_version: 1,
      window: "7d",
      observed_at: null,
      total_volume_tao: 0,
      transfer_count: 0,
      unique_senders: 0,
      unique_receivers: 0,
      top_sender_share: null,
      top_senders: [],
      top_receivers: [],
    });
  });

  test("resolves Postgres-tier data for a non-default window/limit", async () => {
    let capturedUrl;
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: {
        fetch: async (r) => {
          capturedUrl = new URL(r.url);
          return Response.json({
            schema_version: 1,
            window: "30d",
            observed_at: "2026-07-20T00:00:00.000Z",
            total_volume_tao: 500,
            transfer_count: 20,
            unique_senders: 3,
            unique_receivers: 4,
            top_sender_share: 0.6,
            top_senders: [
              { address: "5Alice", volume_tao: 300, transfer_count: 10 },
            ],
            top_receivers: [
              { address: "5Bob", volume_tao: 200, transfer_count: 8 },
            ],
          });
        },
      },
    };
    const { status, body } = await gql(
      xfersQuery('(window: "30d", limit: 15)'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(capturedUrl.pathname, "/api/v1/chain/transfers");
    assert.equal(capturedUrl.searchParams.get("window"), "30d");
    assert.equal(capturedUrl.searchParams.get("limit"), "15");
    assert.equal(body.data.chain_transfers.total_volume_tao, 500);
    assert.equal(body.data.chain_transfers.top_senders[0].address, "5Alice");
    assert.equal(body.data.chain_transfers.top_receivers[0].address, "5Bob");
  });

  test("unsupported window is BAD_USER_INPUT", async () => {
    const { status, body } = await gql(xfersQuery('(window: "1y")'));
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data, null);
  });

  test("malformed Postgres body falls back to schema-stable defaults", async () => {
    const env = {
      METAGRAPH_ACCOUNT_EVENTS_SOURCE: "postgres",
      DATA_API: { fetch: async () => Response.json({}) },
    };
    const { status, body } = await gql(xfersQuery(), env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_transfers.transfer_count, 0);
    assert.deepEqual(body.data.chain_transfers.top_senders, []);
    assert.deepEqual(body.data.chain_transfers.top_receivers, []);
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(
      FIELD_COMPLEXITY.chain_transfers,
      FIELD_COMPLEXITY.chain_weights,
    );
  });
});

describe("graphql — adapter (#6984, reuses loadAdapter / MCP get_adapter)", () => {
  const SAMPLE = {
    schema_version: 1,
    contract_version: "2026-07-01",
    generated_at: "2026-07-01T00:00:00.000Z",
    slug: "gittensor",
    subnet: "Gittensor",
    netuid: 74,
    notes: ["public-safe only"],
    snapshot: { status: "captured", adapter_kind: "gittensor" },
    extensions: { gittensor: { kind: "gittensor" } },
  };

  const query = `{ adapter(slug: "gittensor") {
    schema_version contract_version generated_at slug subnet netuid
    notes snapshot extensions
  } }`;

  test("resolves a baked adapter artifact via loadAdapter", async () => {
    const env = fixtureEnv({ "/metagraph/adapters/gittensor.json": SAMPLE });
    const { status, body } = await gql(query, env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.adapter, SAMPLE);
  });

  test("a missing slug resolves to null (schema-stable), never a GraphQL error", async () => {
    const env = fixtureEnv({
      "/metagraph/adapters/gittensor.json": SAMPLE,
    });
    const { status, body } = await gql(
      '{ adapter(slug: "missing") { slug } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.adapter, null);
  });

  test("cold/absent store resolves to null", async () => {
    const { status, body } = await gql(query);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.adapter, null);
  });

  test("an invalid slug is BAD_USER_INPUT, matching MCP get_adapter", async () => {
    const { status, body } = await gql(
      '{ adapter(slug: "Gittensor") { slug } }',
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data?.adapter ?? null, null);
  });

  test("an empty slug is BAD_USER_INPUT", async () => {
    const { status, body } = await gql('{ adapter(slug: "  ") { slug } }');
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.equal(body.data?.adapter ?? null, null);
  });

  test("a non-toolError from the artifact read is propagated", async () => {
    const env = {
      METAGRAPH_R2_LATEST_PREFIX: "latest/",
      METAGRAPH_ARCHIVE: {
        async get() {
          return {
            async json() {
              throw new Error("corrupt adapter artifact");
            },
          };
        },
      },
    };
    const { status, body } = await gql(query, env);
    assert.equal(status, 200);
    assert.ok(body.errors?.length > 0);
    assert.equal(body.data?.adapter ?? null, null);
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(FIELD_COMPLEXITY.adapter, FIELD_COMPLEXITY.provider);
  });
});

// #7171: GraphQL parity for GET /api/v1/gaps, reusing list_gaps' loader.
describe("graphql — gaps", () => {
  const GAPS_BLOB = {
    generated_at: "2026-07-01T00:00:00.000Z",
    notes: ["fixture"],
    gaps: [
      {
        netuid: 7,
        slug: "allways",
        name: "Allways",
        coverage_level: "probed",
        curation_level: "maintainer-reviewed",
        gaps: {
          missing_kinds: ["openapi"],
          supported_kinds: [],
          gap_notes: [],
        },
        gap_count: 2,
      },
      {
        netuid: 31,
        slug: "candles",
        name: "Candles",
        coverage_level: "manifested",
        curation_level: "community-submitted",
        gaps: { missing_kinds: [], supported_kinds: ["docs"], gap_notes: [] },
        gap_count: 5,
      },
    ],
  };

  test("filters by netuid and paginates", async () => {
    const env = fixtureEnv({ "/metagraph/gaps.json": GAPS_BLOB });
    const filtered = await gql(
      "{ gaps(netuid: 7) { gaps total generated_at } }",
      env,
    );
    assert.equal(filtered.status, 200);
    assert.equal(filtered.body.errors, undefined);
    assert.equal(filtered.body.data.gaps.total, 1);
    assert.equal(filtered.body.data.gaps.gaps[0].slug, "allways");
    assert.equal(
      filtered.body.data.gaps.generated_at,
      "2026-07-01T00:00:00.000Z",
    );

    const paged = await gql(
      "{ gaps(limit: 1) { gaps total returned next_cursor } }",
      env,
    );
    assert.equal(paged.body.data.gaps.gaps.length, 1);
    assert.equal(paged.body.data.gaps.total, 2);
    assert.equal(paged.body.data.gaps.returned, 1);
    assert.ok(paged.body.data.gaps.next_cursor != null);
  });

  test("sorts by gap_count and filters coverage_level", async () => {
    const env = fixtureEnv({ "/metagraph/gaps.json": GAPS_BLOB });
    const { status, body } = await gql(
      '{ gaps(sort: "gap_count", order: "desc", coverage_level: "manifested") { gaps total } }',
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.gaps.total, 1);
    assert.equal(body.data.gaps.gaps[0].netuid, 31);
  });

  test("surfaces an invalid sort as a GraphQL error, not a silent default", async () => {
    const env = fixtureEnv({ "/metagraph/gaps.json": GAPS_BLOB });
    const { body } = await gql('{ gaps(sort: "bogus") { total } }', env);
    assert.ok(body.errors?.length);
  });

  test("surfaces a cold/missing artifact as a GraphQL error, matching REST/MCP", async () => {
    const { body } = await gql("{ gaps { total } }", emptyEnv);
    assert.ok(body.errors?.length);
    assert.equal(body.data, null);
  });

  test("FIELD_COMPLEXITY weights it like its sibling relationship fields", () => {
    assert.equal(FIELD_COMPLEXITY.gaps, FIELD_COMPLEXITY.source_snapshots);
  });
});

// #7171: GraphQL parity for GET /api/v1/evidence, reusing list_evidence' loader.
describe("graphql — evidence", () => {
  const EVIDENCE_BLOB = {
    generated_at: "2026-07-01T00:00:00.000Z",
    schema_version: 1,
    summary: { claim_count: 2 },
    claims: [
      {
        subject: "sn-7",
        claim: "Allways publishes an OpenAPI",
        source_url: "https://example.org/a",
        support_summary: "README documents the API",
        verified_at: "2026-06-01T00:00:00.000Z",
      },
      {
        subject: "sn-31",
        claim: "Candles has a dashboard",
        source_url: "https://example.org/b",
        support_summary: "operator site links it",
        verified_at: null,
      },
    ],
  };

  test("searches with q and paginates", async () => {
    const env = fixtureEnv({
      "/metagraph/evidence-ledger.json": EVIDENCE_BLOB,
    });
    const searched = await gql(
      '{ evidence(q: "OpenAPI") { claims total generated_at summary } }',
      env,
    );
    assert.equal(searched.status, 200);
    assert.equal(searched.body.errors, undefined);
    assert.equal(searched.body.data.evidence.total, 1);
    assert.equal(searched.body.data.evidence.claims[0].subject, "sn-7");
    assert.equal(searched.body.data.evidence.summary.claim_count, 2);

    const paged = await gql(
      "{ evidence(limit: 1) { claims total returned next_cursor } }",
      env,
    );
    assert.equal(paged.body.data.evidence.claims.length, 1);
    assert.equal(paged.body.data.evidence.total, 2);
    assert.ok(paged.body.data.evidence.next_cursor != null);
  });

  test("sorts by subject and exposes schema_version", async () => {
    const env = fixtureEnv({
      "/metagraph/evidence-ledger.json": EVIDENCE_BLOB,
    });
    const { status, body } = await gql(
      '{ evidence(sort: "subject", order: "desc") { claims schema_version } }',
      env,
    );
    assert.equal(status, 200);
    // Lexicographic desc: "sn-7" > "sn-31".
    assert.equal(body.data.evidence.claims[0].subject, "sn-7");
    assert.equal(String(body.data.evidence.schema_version), "1");
  });

  test("surfaces an invalid sort as a GraphQL error", async () => {
    const env = fixtureEnv({
      "/metagraph/evidence-ledger.json": EVIDENCE_BLOB,
    });
    const { body } = await gql('{ evidence(sort: "bogus") { total } }', env);
    assert.ok(body.errors?.length);
  });

  test("surfaces a cold/missing artifact as a GraphQL error", async () => {
    const { body } = await gql("{ evidence { total } }", emptyEnv);
    assert.ok(body.errors?.length);
    assert.equal(body.data, null);
  });

  test("FIELD_COMPLEXITY weights it like its sibling relationship fields", () => {
    assert.equal(FIELD_COMPLEXITY.evidence, FIELD_COMPLEXITY.source_snapshots);
  });
});

// #7171: GraphQL parity for GET /api/v1/chain-events (Query feed).
describe("graphql — chain_events (#7171, DATA_API all-events feed)", () => {
  function dataApi(response) {
    return { fetch: async () => response };
  }

  test("cold/unbound tier returns a schema-stable empty feed, never an error", async () => {
    const { status, body } = await gql(
      "{ chain_events { count next_cursor next_before events { pallet } } }",
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_events, {
      count: 0,
      next_cursor: null,
      next_before: null,
      events: [],
    });
  });

  test("resolves DATA_API rows and maps event fields", async () => {
    const env = {
      DATA_API: dataApi(
        Response.json({
          count: 1,
          next_before: 100,
          next_cursor: "1.100.0",
          events: [
            {
              block_number: 100,
              event_index: 0,
              pallet: "SubtensorModule",
              method: "WeightsSet",
              args: { netuid: 7 },
              phase: "ApplyExtrinsic",
              extrinsic_index: 2,
              observed_at: 1_720_000_000_000,
            },
          ],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ chain_events {
          count next_before next_cursor
          events {
            block_number event_index pallet method args phase extrinsic_index observed_at
          }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.chain_events.count, 1);
    assert.equal(body.data.chain_events.next_cursor, "1.100.0");
    assert.equal(body.data.chain_events.next_before, 100);
    const event = body.data.chain_events.events[0];
    assert.equal(event.pallet, "SubtensorModule");
    assert.equal(event.method, "WeightsSet");
    assert.deepEqual(event.args, { netuid: 7 });
    assert.equal(event.observed_at, 1_720_000_000_000);
  });

  test("forwards filter args as query params, including legacy before", async () => {
    let capturedUrl;
    const env = {
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            count: 0,
            next_before: null,
            next_cursor: null,
            events: [],
          });
        },
      },
    };
    await gql(
      '{ chain_events(pallet: "SubtensorModule", method: "WeightsSet", block: 9, extrinsic: 1, before: 8, limit: 25) { count } }',
      env,
    );
    assert.equal(capturedUrl.pathname, "/api/v1/chain-events");
    assert.equal(capturedUrl.searchParams.get("pallet"), "SubtensorModule");
    assert.equal(capturedUrl.searchParams.get("method"), "WeightsSet");
    assert.equal(capturedUrl.searchParams.get("block"), "9");
    assert.equal(capturedUrl.searchParams.get("extrinsic"), "1");
    assert.equal(capturedUrl.searchParams.get("before"), "8");
    assert.equal(capturedUrl.searchParams.get("limit"), "25");
  });

  test("prefers cursor over before when both are set", async () => {
    let capturedUrl;
    const env = {
      DATA_API: {
        fetch: async (req) => {
          capturedUrl = new URL(req.url);
          return Response.json({
            count: 0,
            next_before: null,
            next_cursor: null,
            events: [],
          });
        },
      },
    };
    await gql('{ chain_events(cursor: "1.2.3", before: 99) { count } }', env);
    assert.equal(capturedUrl.searchParams.get("cursor"), "1.2.3");
    assert.equal(capturedUrl.searchParams.get("before"), null);
  });

  test("a DATA_API 400 is BAD_USER_INPUT, not an empty feed", async () => {
    const env = {
      DATA_API: dataApi(
        new Response(JSON.stringify({ error: "method requires pallet" }), {
          status: 400,
        }),
      ),
    };
    const { status, body } = await gql(
      '{ chain_events(method: "WeightsSet") { count } }',
      env,
    );
    assert.equal(status, 200);
    assert.ok(body.errors.find((e) => e.extensions?.code === "BAD_USER_INPUT"));
    assert.match(body.errors[0].message, /method requires pallet/);
    assert.equal(body.data?.chain_events ?? null, null);
  });

  test("a partial DATA_API body degrades to resolver defaults", async () => {
    const env = {
      DATA_API: dataApi(Response.json({})),
    };
    const { status, body } = await gql(
      "{ chain_events { count next_before next_cursor events { pallet } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_events, {
      count: 0,
      next_before: null,
      next_cursor: null,
      events: [],
    });
  });

  test("sparse event rows fill null defaults", async () => {
    const env = {
      DATA_API: dataApi(
        Response.json({
          count: 1,
          events: [{}],
        }),
      ),
    };
    const { status, body } = await gql(
      `{ chain_events {
          events {
            block_number event_index pallet method args phase extrinsic_index observed_at
          }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.deepEqual(body.data.chain_events.events[0], {
      block_number: null,
      event_index: null,
      pallet: null,
      method: null,
      args: null,
      phase: null,
      extrinsic_index: null,
      observed_at: null,
    });
  });

  test("a data_rate_limited loader failure degrades to an empty feed", async () => {
    const env = {
      DATA_API: dataApi(
        Response.json({ count: 99, events: [{ pallet: "X" }] }),
      ),
      DATA_RATE_LIMITER: {
        async limit() {
          return { success: false };
        },
      },
    };
    const { status, body } = await gql(
      "{ chain_events { count events { pallet } } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.deepEqual(body.data.chain_events, {
      count: 0,
      events: [],
    });
  });

  test("is priced at the relationship-field complexity weight", () => {
    assert.equal(FIELD_COMPLEXITY.chain_events, FIELD_COMPLEXITY.extrinsics);
  });
});

// --- curation parity (#6982) ---
describe("graphql — curation parity (#6982)", () => {
  test("curation resolves the baked curation-states artifact", async () => {
    const env = fixtureEnv({
      "/metagraph/curation.json": {
        subnets: [
          { netuid: 1, level: "core", review_state: "maintainer-reviewed" },
        ],
      },
    });
    const { status, body } = await gql("{ curation }", env);
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.curation.subnets[0].level, "core");
  });

  test("curation degrades to null when the artifact has not been baked", async () => {
    const { status, body } = await gql("{ curation }");
    assert.equal(status, 200);
    assert.equal(body.errors, undefined);
    assert.equal(body.data.curation, null);
  });

  test("curation is weighted as a fan-out field like its sibling artifact resolvers", () => {
    assert.equal(FIELD_COMPLEXITY.curation, FIELD_COMPLEXITY.agent_resources);
  });
});

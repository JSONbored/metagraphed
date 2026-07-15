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
import { handleRequest } from "../workers/api.mjs";
import { resolveClientIp } from "../workers/config.mjs";
import {
  KV_ECONOMICS_CURRENT,
  KV_HEALTH_CURRENT,
  KV_HEALTH_META,
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

  test("the health dimension runs the D1 surface_status aggregate", async () => {
    const env = profilesEnv();
    env.METAGRAPH_HEALTH_DB = {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return {
                  results: [
                    {
                      netuid: 1,
                      surface_count: 3,
                      ok_count: 3,
                      avg_latency_ms: 42,
                    },
                  ],
                };
              },
            };
          },
        };
      },
    };
    const { status, body } = await gql(
      `{ compare(netuids: [1], dimensions: ["health"]) {
          subnets { netuid health { surface_count ok_count avg_latency_ms } }
        } }`,
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.compare.subnets[0].health.ok_count, 3);
    assert.equal(body.data.compare.subnets[0].health.avg_latency_ms, 42);
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

  test("D1 fallback path shapes rows through loadSubnetIdentityHistory", async () => {
    const observedAt = Date.parse("2026-06-15T12:00:00.000Z");
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind() {
              return {
                async all() {
                  return {
                    results: [
                      {
                        id: 11,
                        block_number: 100,
                        observed_at: observedAt,
                        subnet_name: "Alpha",
                        symbol: "A",
                        description: "alpha desc",
                        github_repo: "https://github.com/jsonbored/alpha",
                        subnet_url: "https://metagraph.sh",
                        discord: "alpha#1234",
                        logo_url: null,
                        identity_hash: "deadbeef",
                      },
                    ],
                  };
                },
              };
            },
          };
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
    assert.equal(r.entry_count, 1);
    assert.equal(r.limit, 10);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].block_number, 100);
    assert.equal(r.entries[0].observed_at, "2026-06-15T12:00:00.000Z");
    assert.equal(r.entries[0].subnet_name, "Alpha");
    assert.equal(r.entries[0].symbol, "A");
    assert.equal(r.entries[0].identity_hash, "deadbeef");
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

  test("no Postgres tier flag: rolls up subnet_snapshots rows straight off D1", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          return {
            bind() {
              return {
                async all() {
                  return {
                    results: [
                      {
                        snapshot_date: "2026-06-10",
                        total_stake_tao: 1000,
                        alpha_price_tao: 0.06,
                        validator_count: 12,
                        miner_count: 200,
                        emission_share: 0.05,
                      },
                    ],
                  };
                },
              };
            },
          };
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
    assert.equal(body.data.economics_trends.day_count, 1);
    assert.equal(
      body.data.economics_trends.days[0].snapshot_date,
      "2026-06-10",
    );
    assert.equal(
      body.data.economics_trends.days[0].total_stake_tao,
      "1000.000000000",
    );
    assert.equal(body.data.economics_trends.days[0].validator_count, 12);
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

  test("no Postgres tier flag: rolls up the account_events WeightsSet stream straight off D1", async () => {
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
    const { status, body } = await gql(weightsQuery('(window: "7d")'), env);
    assert.equal(status, 200);
    assert.equal(body.data.chain_weights.window, "7d");
    assert.equal(body.data.chain_weights.subnet_count, 1);
    assert.equal(body.data.chain_weights.network.distinct_setters, 4);
    assert.equal(body.data.chain_weights.network.weight_sets, 40);
    assert.equal(body.data.chain_weights.network.sets_per_setter, 10);
    assert.equal(body.data.chain_weights.subnets[0].netuid, 3);
    assert.equal(body.data.chain_weights.intensity_distribution.count, 1);
    assert.ok(body.data.chain_weights.observed_at);
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

describe("graphql — chain_weight_setters (#5689, Postgres-tier + D1-live fallback)", () => {
  function weightSettersQuery(argsClause) {
    return `{ chain_weight_setters${argsClause} {
      schema_version window observed_at distinct_setters weight_sets setter_count
      setters { hotkey netuid uid weight_sets share first_set_at last_set_at }
    } }`;
  }

  // The per-setter leaderboard is GROUP BY the hotkey-or-(netuid,uid) identity
  // and ORDER BY weight_sets DESC; the network-wide totals query has no GROUP
  // BY -- same two-query shape loadChainWeightSetters always issues.
  function chainWeightSettersD1({ rows = [], totals } = {}) {
    return {
      prepare(sql) {
        return {
          bind() {
            return {
              async all() {
                if (sql.includes("ORDER BY weight_sets DESC")) {
                  return { results: rows };
                }
                return { results: totals ? [totals] : [] };
              },
            };
          },
        };
      },
    };
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

  test("no Postgres tier flag: rolls up the account_events WeightsSet stream straight off D1", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: chainWeightSettersD1({
        rows: [
          {
            hotkey: "5Setter",
            netuid: null,
            uid: null,
            weight_sets: 40,
            first_set: 1_749_000_000_000,
            last_set: 1_750_000_000_000,
          },
        ],
        totals: {
          weight_sets: 40,
          distinct_setters: 1,
          newest_observed: 1_750_000_000_000,
        },
      }),
    };
    const { status, body } = await gql(
      weightSettersQuery('(window: "7d")'),
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.chain_weight_setters.window, "7d");
    assert.equal(body.data.chain_weight_setters.distinct_setters, 1);
    assert.equal(body.data.chain_weight_setters.weight_sets, 40);
    assert.equal(body.data.chain_weight_setters.setter_count, 1);
    assert.equal(body.data.chain_weight_setters.setters[0].hotkey, "5Setter");
    assert.equal(body.data.chain_weight_setters.setters[0].share, 1);
    assert.ok(body.data.chain_weight_setters.observed_at);
  });

  test("a D1 query error degrades to a schema-stable empty leaderboard (no throw)", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: {
        prepare() {
          throw new Error("db unavailable");
        },
      },
    };
    const { status, body } = await gql(weightSettersQuery(""), env);
    assert.equal(status, 200);
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

  test("no Postgres tier flag: aggregates surface_uptime_daily rows straight off D1", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: bulkTrendsD1([
        {
          netuid: 7,
          date: "2026-07-09",
          total: 10,
          ok_count: 9,
          avg_latency_ms: 50,
        },
      ]),
    };
    const { status, body } = await gql(trendsQuery(), env);
    assert.equal(status, 200);
    assert.equal(body.data.health_trends.schema_version, 1);
    assert.equal(body.data.health_trends.windows["7d"].subnet_count, 1);
    assert.equal(body.data.health_trends.windows["7d"].subnets[0].netuid, 7);
    assert.equal(body.data.health_trends.windows["30d"].subnet_count, 1);
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

  test("an explicit board returns only that board, ranked from the D1 rows", async () => {
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
    // Ranked by uptime_ratio desc — the fully-ok subnet leads.
    assert.deepEqual(
      r.boards.healthiest.map((e) => e.netuid),
      [3, 7],
    );
    assert.equal(r.boards.healthiest[0].surfaces_ok, 4);
    assert.equal(r.boards.healthiest[0].avg_latency_ms, 42);
  });

  test("limit caps each board's entries", async () => {
    const env = {
      METAGRAPH_HEALTH_DB: healthDb([
        { netuid: 7, total: 4, ok_count: 2, avg_latency_ms: 90 },
        { netuid: 3, total: 4, ok_count: 4, avg_latency_ms: 42 },
      ]),
    };
    const { body } = await gql(
      `{ registry_leaderboards(board: "healthiest", limit: 1) { boards } }`,
      env,
    );
    assert.equal(body.errors, undefined);
    assert.equal(body.data.registry_leaderboards.boards.healthiest.length, 1);
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

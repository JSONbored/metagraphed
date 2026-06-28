import assert from "node:assert/strict";
import { Blob } from "node:buffer";
import { buildSchema, parse, validate } from "graphql";
import { describe, test } from "vitest";
import {
  FIELD_COMPLEXITY,
  GRAPHQL_MAX_BODY_BYTES,
  GRAPHQL_MAX_COMPLEXITY,
  GRAPHQL_MAX_DEPTH,
  GRAPHQL_MAX_QUERY_BYTES,
  SDL,
  handleGraphQLRequest,
  maxComplexityRule,
  maxDepthRule,
} from "../src/graphql.mjs";
import { handleRequest } from "../workers/api.mjs";
import { resolveClientIp } from "../workers/config.mjs";
import { KV_ECONOMICS_CURRENT, KV_HEALTH_CURRENT } from "../src/kv-keys.mjs";

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
              { netuid: 2, emission_share: 0.4 },
            ],
          },
        },
      },
    );
    const { status, body } = await gql(
      "{ economics { subnets { netuid } total } }",
      env,
    );
    assert.equal(status, 200);
    assert.equal(body.data.economics.total, 2);
    assert.deepEqual(
      body.data.economics.subnets.map((s) => s.netuid),
      [1, 2],
    );
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
    // fields = 54 > 50.
    const { status, body } = await gql(
      `{ subnets { items {
          economics { netuid emission_share open_slots max_uids miner_count validator_count total_stake_tao }
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

  test("OPTIONS /mcp advertises POST, OPTIONS (the sibling CORS branch)", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/mcp", { method: "OPTIONS" }),
      emptyEnv,
      {},
    );
    assert.equal(res.status, 204);
    assert.equal(
      res.headers.get("access-control-allow-methods"),
      "POST, OPTIONS",
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

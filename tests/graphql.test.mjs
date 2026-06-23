import assert from "node:assert/strict";
import { Blob } from "node:buffer";
import { buildSchema, parse, validate } from "graphql";
import { describe, test } from "vitest";
import {
  GRAPHQL_MAX_BODY_BYTES,
  GRAPHQL_MAX_COMPLEXITY,
  GRAPHQL_MAX_DEPTH,
  GRAPHQL_MAX_QUERY_BYTES,
  handleGraphQLRequest,
  maxComplexityRule,
  maxDepthRule,
} from "../src/graphql.mjs";
import { handleRequest } from "../workers/api.mjs";
import { resolveClientIp } from "../workers/config.mjs";

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

describe("handleGraphQLRequest — method guard", () => {
  test("GET returns 405", async () => {
    const req = new Request("https://api.metagraph.sh/api/v1/graphql");
    const res = await handleGraphQLRequest(req, emptyEnv);
    assert.equal(res.status, 405);
    const body = await res.json();
    assert.ok(body.errors[0].message.includes("POST"));
    assert.equal(res.headers.get("allow"), "POST");
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

  test("OPTIONS /api/v1/graphql advertises POST for CORS preflight", async () => {
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
      "POST, OPTIONS",
    );
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
  // Inject synthetic artifact data via the R2 binding (all GraphQL source
  // paths are R2-only; ASSETS is never tried for them). Fixtures are keyed by
  // full artifact path, e.g. "/metagraph/subnets.json".
  function fakeArtifactEnv(fixtures) {
    return {
      METAGRAPH_R2_LATEST_PREFIX: "latest/",
      METAGRAPH_ARCHIVE: {
        async get(key) {
          // key = "latest/subnets.json" → fixture key = "/metagraph/subnets.json"
          const artifactPath = "/metagraph/" + key.replace(/^latest\//, "");
          const data = fixtures[artifactPath];
          if (data === undefined) return null;
          return {
            async json() {
              return data;
            },
          };
        },
      },
    };
  }

  test("subnets resolves items and total from fixture data", async () => {
    const env = fakeArtifactEnv({
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
    const env = fakeArtifactEnv({
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

  test("subnet resolves a single subnet by netuid", async () => {
    const env = fakeArtifactEnv({
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
    const env = fakeArtifactEnv({
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
    const env = fakeArtifactEnv({
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
    const env = fakeArtifactEnv({
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
    function fakeEnv(fixtures) {
      return {
        METAGRAPH_R2_LATEST_PREFIX: "latest/",
        METAGRAPH_ARCHIVE: {
          async get(key) {
            const path = "/metagraph/" + key.replace(/^latest\//, "");
            const data = fixtures[path];
            if (data === undefined) return null;
            return {
              async json() {
                return data;
              },
            };
          },
        },
      };
    }
    const env = fakeEnv({
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
    const env = {
      METAGRAPH_R2_LATEST_PREFIX: "latest/",
      METAGRAPH_ARCHIVE: {
        async get(key) {
          if (key === "latest/subnets.json") {
            return {
              async json() {
                return {};
              },
            };
          }
          return null;
        },
      },
    };
    const { status, body } = await gql("{ subnets { total } }", env);
    assert.equal(status, 200);
    assert.equal(body.data.subnets.total, 0);
  });

  // Providers artifact without providers key → empty list.
  test("providers artifact without providers key returns empty list", async () => {
    const env = {
      METAGRAPH_R2_LATEST_PREFIX: "latest/",
      METAGRAPH_ARCHIVE: {
        async get(key) {
          if (key === "latest/providers.json") {
            return {
              async json() {
                return {};
              },
            };
          }
          return null;
        },
      },
    };
    const { status, body } = await gql("{ providers { total } }", env);
    assert.equal(status, 200);
    assert.equal(body.data.providers.total, 0);
  });

  // Provider artifact with netuids present → returned as-is.
  test("provider artifact with netuids returns them", async () => {
    const env = {
      METAGRAPH_R2_LATEST_PREFIX: "latest/",
      METAGRAPH_ARCHIVE: {
        async get(key) {
          if (key === "latest/providers/acme.json") {
            return {
              async json() {
                return { id: "acme", name: "Acme Corp", netuids: [1, 7] };
              },
            };
          }
          return null;
        },
      },
    };
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

import {
  GraphQLError,
  buildSchema,
  execute,
  parse,
  specifiedRules,
  validate,
} from "graphql";
import { readArtifact } from "../workers/storage.mjs";

export const GRAPHQL_MAX_DEPTH = 7;
export const GRAPHQL_MAX_COMPLEXITY = 50;

const SDL = `
  type Query {
    subnets(limit: Int, cursor: String): SubnetList!
    subnet(netuid: Int!): Subnet
    providers(limit: Int, cursor: String): ProviderList!
    provider(id: String!): Provider
    economics: EconomicsList!
  }

  type SubnetList {
    items: [Subnet!]!
    total: Int!
    next_cursor: String
  }

  type Subnet {
    netuid: Int!
    name: String
    slug: String
    description: String
  }

  type ProviderList {
    items: [Provider!]!
    total: Int!
    next_cursor: String
  }

  type Provider {
    id: String!
    name: String
    docs_url: String
    github_url: String
    endpoint_count: Int
    netuids: [Int]!
  }

  type EconomicsList {
    subnets: [SubnetEconomics!]!
    total: Int!
  }

  type SubnetEconomics {
    netuid: Int!
    name: String
    emission_share: Float
    alpha_price_tao: Float
    miner_count: Int
    validator_count: Int
    max_stake_tao: Float
  }
`;

const schema = buildSchema(SDL);

// --- Validation rules ---

function buildFragmentMap(documentNode) {
  const fragments = new Map();
  for (const def of documentNode.definitions) {
    if (def.kind === "FragmentDefinition") {
      fragments.set(def.name.value, def);
    }
  }
  return fragments;
}

// Depth/complexity must follow named fragment spreads. Otherwise a client moves
// the whole (expensive) selection into a fragment and the operation's own
// selection set is just a single transparent spread — counting as depth 0 /
// complexity 1 and fully bypassing both limits. `visited` guards against
// fragment cycles: validate() reports those, but our rules run in the same pass
// and would otherwise recurse forever.
function selectionDepth(selectionSet, fragments, visited, depth = 0) {
  let max = depth;
  for (const sel of selectionSet.selections) {
    if (sel.kind === "FragmentSpread") {
      const frag = fragments.get(sel.name.value);
      if (frag && !visited.has(sel.name.value)) {
        const d = selectionDepth(
          frag.selectionSet,
          fragments,
          new Set(visited).add(sel.name.value),
          depth,
        );
        if (d > max) max = d;
      }
    } else if (sel.selectionSet) {
      const d = selectionDepth(sel.selectionSet, fragments, visited, depth + 1);
      if (d > max) max = d;
    }
  }
  return max;
}

export function maxDepthRule(max) {
  return (context) => ({
    Document: {
      leave(node) {
        const fragments = buildFragmentMap(node);
        for (const def of node.definitions) {
          if (def.kind === "OperationDefinition") {
            const depth = selectionDepth(
              def.selectionSet,
              fragments,
              new Set(),
            );
            if (depth > max) {
              context.reportError(
                new GraphQLError(
                  `Query depth ${depth} exceeds the limit of ${max}.`,
                  { extensions: { code: "DEPTH_LIMIT_EXCEEDED" } },
                ),
              );
            }
          }
        }
      },
    },
  });
}

function selectionComplexity(selectionSet, fragments, visited) {
  let count = 0;
  for (const sel of selectionSet.selections) {
    if (sel.kind === "FragmentSpread") {
      const frag = fragments.get(sel.name.value);
      if (frag && !visited.has(sel.name.value)) {
        count += selectionComplexity(
          frag.selectionSet,
          fragments,
          new Set(visited).add(sel.name.value),
        );
      }
      continue;
    }
    count += 1;
    if (sel.selectionSet) {
      count += selectionComplexity(sel.selectionSet, fragments, visited);
    }
  }
  return count;
}

export function maxComplexityRule(max) {
  return (context) => ({
    Document: {
      leave(node) {
        const fragments = buildFragmentMap(node);
        for (const def of node.definitions) {
          if (def.kind === "OperationDefinition") {
            const complexity = selectionComplexity(
              def.selectionSet,
              fragments,
              new Set(),
            );
            if (complexity > max) {
              context.reportError(
                new GraphQLError(
                  `Query complexity ${complexity} exceeds the limit of ${max}.`,
                  { extensions: { code: "COMPLEXITY_LIMIT_EXCEEDED" } },
                ),
              );
            }
          }
        }
      },
    },
  });
}

// --- Pagination ---

function paginate(items, limit, cursor, keyFn) {
  const safeLimit = Math.min(Math.max(1, limit ?? 20), 100);
  let start = 0;
  if (cursor) {
    const idx = items.findIndex((item) => String(keyFn(item)) === cursor);
    if (idx >= 0) start = idx + 1;
  }
  const page = items.slice(start, start + safeLimit);
  const nextCursor =
    start + page.length < items.length
      ? String(keyFn(page[page.length - 1]))
      : null;
  return { page, total: items.length, nextCursor };
}

// --- Resolvers ---

const rootValue = {
  async subnets({ limit, cursor }, context) {
    const { ok, data } = await readArtifact(
      context.env,
      "/metagraph/subnets.json",
    );
    if (!ok) return { items: [], total: 0, next_cursor: null };
    const all = data.subnets || [];
    const { page, total, nextCursor } = paginate(
      all,
      limit,
      cursor,
      (s) => s.netuid,
    );
    return { items: page, total, next_cursor: nextCursor };
  },

  async subnet({ netuid }, context) {
    const { ok, data } = await readArtifact(
      context.env,
      `/metagraph/subnets/${netuid}.json`,
    );
    return ok ? data : null;
  },

  async providers({ limit, cursor }, context) {
    const { ok, data } = await readArtifact(
      context.env,
      "/metagraph/providers.json",
    );
    if (!ok) return { items: [], total: 0, next_cursor: null };
    const all = (data.providers || []).map((p) => ({
      ...p,
      netuids: p.netuids || [],
    }));
    const { page, total, nextCursor } = paginate(
      all,
      limit,
      cursor,
      (p) => p.id,
    );
    return { items: page, total, next_cursor: nextCursor };
  },

  async provider({ id }, context) {
    const { ok, data } = await readArtifact(
      context.env,
      `/metagraph/providers/${id}.json`,
    );
    if (!ok) return null;
    return { ...data, netuids: data.netuids || [] };
  },

  async economics(_, context) {
    const { ok, data } = await readArtifact(
      context.env,
      "/metagraph/economics.json",
    );
    if (!ok) return { subnets: [], total: 0 };
    const all = data.subnets || [];
    return { subnets: all, total: all.length };
  },
};

// --- Response helpers ---

const GRAPHQL_CONTENT_TYPE = "application/graphql-response+json";

const graphqlHeaders = (extra = {}) => ({
  "content-type": GRAPHQL_CONTENT_TYPE,
  "access-control-allow-origin": "*",
  "x-content-type-options": "nosniff",
  ...extra,
});

// --- Handler ---

export async function handleGraphQLRequest(request, env) {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({
        errors: [{ message: "GraphQL endpoint only accepts POST." }],
      }),
      {
        status: 405,
        headers: graphqlHeaders({ allow: "POST" }),
      },
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({
        errors: [{ message: "Request body must be valid JSON." }],
      }),
      { status: 400, headers: graphqlHeaders() },
    );
  }

  const { query, variables, operationName } = body || {};
  if (typeof query !== "string" || !query.trim()) {
    return new Response(
      JSON.stringify({
        errors: [{ message: "Missing required field: query." }],
      }),
      { status: 400, headers: graphqlHeaders() },
    );
  }

  let document;
  try {
    document = parse(query);
  } catch (err) {
    return new Response(
      JSON.stringify({ errors: [{ message: err.message }] }),
      { status: 400, headers: graphqlHeaders() },
    );
  }

  const validationErrors = validate(schema, document, [
    ...specifiedRules,
    maxDepthRule(GRAPHQL_MAX_DEPTH),
    maxComplexityRule(GRAPHQL_MAX_COMPLEXITY),
  ]);
  if (validationErrors.length > 0) {
    return new Response(
      JSON.stringify({
        errors: validationErrors.map((e) => ({
          message: e.message,
          extensions: e.extensions,
        })),
      }),
      { status: 400, headers: graphqlHeaders() },
    );
  }

  const result = await execute({
    schema,
    document,
    rootValue,
    contextValue: { env },
    variableValues: variables ?? undefined,
    operationName: operationName ?? undefined,
  });

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: graphqlHeaders({
      "cache-control": "public, max-age=60, stale-while-revalidate=300",
      vary: "Accept-Encoding",
    }),
  });
}

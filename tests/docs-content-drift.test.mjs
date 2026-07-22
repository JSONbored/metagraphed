// Real cross-checking for the numbers hand-written into apps/ui's Fumadocs
// content pages -- imports the actual Worker constants those pages describe
// and asserts the documented values against them, rather than a second
// hardcoded copy. Replaces the pre-Fumadocs-migration graphql-docs.test.ts /
// rpc-docs.test.ts, which only asserted a docs-only TS module against a
// second literal in the same test file -- self-consistent, never touching
// the real Worker source. See docs/migration discussion on issue #1652.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import {
  DEFAULT_PAGE_LIMIT,
  FIELD_COMPLEXITY,
  GRAPHQL_MAX_BODY_BYTES,
  GRAPHQL_MAX_COMPLEXITY,
  GRAPHQL_MAX_DEPTH,
  GRAPHQL_MAX_QUERY_BYTES,
  MAX_PAGE_LIMIT,
} from "../src/graphql.mjs";
import {
  DENIED_RPC_PREFIXES,
  MAX_RPC_BODY_BYTES,
  MAX_STATE_QUERY_KEYS_PAGE_SIZE,
  MAX_STATE_QUERY_RESPONSE_BYTES,
  SAFE_RPC_METHODS,
  SAFE_RPC_STATE_QUERY_METHODS,
} from "../workers/config.ts";
import {
  RPC_MAX_ATTEMPTS,
  RPC_PROXY_POOLS,
  RPC_RATE_LIMIT,
  STATE_QUERY_RATE_LIMIT,
} from "../workers/request-handlers/rpc-proxy.ts";

const graphqlDocs = readFileSync("apps/ui/content/docs/graphql.mdx", "utf8");
const rpcDocs = readFileSync("apps/ui/content/docs/rpc.mdx", "utf8");
const chainEventsDocs = readFileSync(
  "apps/ui/content/docs/chain-events.mdx",
  "utf8",
);
const wranglerConfig = readFileSync("wrangler.jsonc", "utf8");

/** Extracts a markdown table row's "Value" cell (2nd column) by its exact "Label" cell text. */
function tableValue(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\|\\s*${escaped}\\s*\\|\\s*([^|]+?)\\s*\\|`, "m");
  const match = text.match(re);
  assert.ok(match, `No table row found for "${label}"`);
  return match[1].trim();
}

/** Mirrors the deleted graphql-docs.ts/rpc-docs.ts formatByteBudget helpers. */
function formatBytes(bytes) {
  if (bytes % 1024 === 0) return `${bytes / 1024} KiB`;
  return `${bytes} B`;
}

/** Extracts a JSONC ratelimit binding's {limit, period} by its "name". */
function wranglerRateLimit(name) {
  const re = new RegExp(
    `"name":\\s*"${name}"[\\s\\S]*?"limit":\\s*(\\d+),[\\s\\S]*?"period":\\s*(\\d+),`,
  );
  const match = wranglerConfig.match(re);
  assert.ok(
    match,
    `No ratelimit binding found for "${name}" in wrangler.jsonc`,
  );
  return { limit: Number(match[1]), period: Number(match[2]) };
}

describe("content/docs/graphql.mdx matches src/graphql.mjs", () => {
  test("limits table", () => {
    assert.equal(
      tableValue(graphqlDocs, "Max depth"),
      String(GRAPHQL_MAX_DEPTH),
    );
    assert.equal(
      tableValue(graphqlDocs, "Max complexity"),
      String(GRAPHQL_MAX_COMPLEXITY),
    );
    assert.equal(
      tableValue(graphqlDocs, "Max POST body"),
      formatBytes(GRAPHQL_MAX_BODY_BYTES),
    );
    assert.equal(
      tableValue(graphqlDocs, "Max query document"),
      formatBytes(GRAPHQL_MAX_QUERY_BYTES),
    );
    const pageSize = tableValue(graphqlDocs, "Page size");
    assert.match(pageSize, new RegExp(`${DEFAULT_PAGE_LIMIT}\\s*default`));
    assert.match(pageSize, new RegExp(`${MAX_PAGE_LIMIT}\\s*max`));
    const rateLimit = tableValue(graphqlDocs, "Rate limit");
    assert.equal(
      rateLimit,
      `${RPC_RATE_LIMIT.limit} / ${RPC_RATE_LIMIT.windowSeconds}s`,
    );
  });

  test("relationship-field complexity cost", () => {
    // FIELD_COMPLEXITY.subnets is one of several relationship roots that all
    // share the same weight -- see src/graphql.mjs's RELATIONSHIP_FIELD_COMPLEXITY.
    assert.match(
      graphqlDocs,
      new RegExp(`relationship roots cost ${FIELD_COMPLEXITY.subnets}`),
    );
  });
});

describe("content/docs/rpc.mdx matches workers/config.mjs + rpc-proxy.mjs", () => {
  test("limits table", () => {
    assert.equal(
      tableValue(rpcDocs, "Rate limit"),
      `${RPC_RATE_LIMIT.limit} / ${RPC_RATE_LIMIT.windowSeconds}s`,
    );
    assert.equal(
      tableValue(rpcDocs, "State-query rate"),
      `${STATE_QUERY_RATE_LIMIT.limit} / ${STATE_QUERY_RATE_LIMIT.windowSeconds}s`,
    );
    assert.equal(
      tableValue(rpcDocs, "Max POST body"),
      formatBytes(MAX_RPC_BODY_BYTES),
    );
    assert.equal(
      tableValue(rpcDocs, "Max state-query response"),
      formatBytes(MAX_STATE_QUERY_RESPONSE_BYTES),
    );
    assert.equal(
      tableValue(rpcDocs, "`state_getKeysPaged` page"),
      String(MAX_STATE_QUERY_KEYS_PAGE_SIZE),
    );
    assert.equal(
      tableValue(rpcDocs, "Failover attempts"),
      String(RPC_MAX_ATTEMPTS),
    );
  });

  test("network names", () => {
    for (const network of Object.keys(RPC_PROXY_POOLS)) {
      assert.match(rpcDocs, new RegExp(`\`${network}\``));
    }
  });

  test("safe methods", () => {
    for (const method of SAFE_RPC_METHODS) {
      assert.match(
        rpcDocs,
        new RegExp(`\`${method}\``),
        `missing safe method ${method}`,
      );
    }
  });

  test("state-query methods", () => {
    for (const method of SAFE_RPC_STATE_QUERY_METHODS) {
      assert.match(
        rpcDocs,
        new RegExp(`\`${method}\``),
        `missing state-query method ${method}`,
      );
    }
  });

  test("denied prefixes", () => {
    for (const prefix of DENIED_RPC_PREFIXES) {
      assert.match(
        rpcDocs,
        new RegExp(`\`${prefix}\``),
        `missing denied prefix ${prefix}`,
      );
    }
  });
});

describe("content/docs/chain-events.mdx matches its rate-limit binding", () => {
  test("rate limit mirrors wrangler.jsonc's DATA_RATE_LIMITER", () => {
    // handleChainEventsProxy (workers/api.mjs) has no local mirror constant --
    // env.DATA_RATE_LIMITER is read directly, so the binding config itself is
    // the only source of truth to check the docs against.
    const { limit, period } = wranglerRateLimit("DATA_RATE_LIMITER");
    assert.match(chainEventsDocs, new RegExp(`${limit} requests / ${period}s`));
  });
});

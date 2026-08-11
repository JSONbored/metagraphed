// The one operation registry, and the gate that keeps it honest (#10781).
//
// Every check here drives the gate with a MUTATED registry as well as the real
// one. A gate only ever run against a passing tree proves nothing about what it
// would catch, and this epic has now met four gates that were green because
// they were looking at nothing.
import { describe, test } from "vitest";
import assert from "node:assert/strict";
import {
  OPERATIONS,
  UnknownOperationError,
  findOperation,
  operationById,
  operationComponent,
  operationInput,
  operationPath,
  type Operation,
} from "../src/operations.ts";
import {
  checkOperations,
  DECLARED_UNEXPOSED,
} from "../scripts/validate-operations.ts";
import { GRAPHQL_EXPOSURES } from "../schemas-src/graphql/query-exposures.ts";
import { MCP_EXPOSURES } from "../src/mcp-tool-exposures.ts";
import { API_ROUTES, FEED_ROUTES } from "../src/contracts.ts";
import { QUERY_BINDINGS } from "../schemas-src/graphql/published-names.ts";
import { MCP_TOOL_ROUTES } from "../src/mcp-route-map.ts";

describe("OPERATIONS", () => {
  test("every route and feed is an operation, keyed by its own id", () => {
    const ids = new Set(OPERATIONS.map((operation) => operation.id));
    for (const route of [...API_ROUTES, ...FEED_ROUTES]) {
      assert.ok(ids.has(route.id), `${route.id} is not an operation`);
    }
    // The feed table is the one this registry brought in from the cold: it was
    // a second route table nothing else joined, which is why `get_feed` read as
    // an orphan against API_ROUTES alone.
    assert.equal(
      OPERATIONS.filter((operation) => operation.rest).length,
      API_ROUTES.length + FEED_ROUTES.length,
    );
  });

  test("ids are unique -- the key every surface resolves to", () => {
    const ids = OPERATIONS.map((operation) => operation.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test("a surface exposing an operation twice is representable", () => {
    // Not a hypothetical: 4 operations carry more than one GraphQL field and 16
    // carry more than one MCP tool. An optional `graphql?: Field` would have
    // made the second one an exception to smuggle somewhere.
    const multiGraphql = OPERATIONS.filter((o) => o.graphql.length > 1);
    const multiMcp = OPERATIONS.filter((o) => o.mcp.length > 1);
    assert.ok(multiGraphql.length > 0, "expected a shared-route GraphQL pair");
    assert.ok(multiMcp.length > 0, "expected a shared-route MCP pair");
    const boards = operationById("registry-leaderboards");
    assert.deepEqual(boards.graphql.map((exposure) => exposure.field).sort(), [
      "opportunity_boards",
      "registry_leaderboards",
    ]);
  });

  test("a surface-only operation is an operation, not an omission", () => {
    const surfaceOnly = OPERATIONS.filter((operation) => !operation.rest);
    assert.ok(surfaceOnly.length > 0);
    // `saved_query` is served by GraphQL and no route. It spent months naming
    // `/api/v1/queries/{id}`, which has never existed, because a path string
    // cannot tell "no route" from "a route I misspelled".
    const saved = operationById("saved_query");
    assert.equal(saved.rest, null);
    assert.deepEqual(
      saved.graphql.map((exposure) => exposure.field),
      ["saved_query"],
    );
  });

  test("a miss is a typed error, never null", () => {
    assert.throws(
      () => operationById("no-such-operation", "a test"),
      (error: unknown) => {
        assert.ok(error instanceof UnknownOperationError);
        assert.equal(error.operationId, "no-such-operation");
        assert.equal(error.namedBy, "a test");
        // The message has to name BOTH sides, or the reader cannot act on it.
        assert.match(error.message, /a test/);
        assert.match(error.message, /no-such-operation/);
        return true;
      },
    );
    // `findOperation` is the one that may answer null, and it says so in its
    // name -- for a caller that is ASKING whether, not asserting.
    assert.equal(findOperation("no-such-operation"), null);
  });

  test("operationPath resolves the path the route owns", () => {
    assert.equal(operationPath("subnets"), "/api/v1/subnets");
    assert.equal(operationPath("saved_query"), null);
  });

  test("an operation carries its response component and its input schema", () => {
    // Both DERIVED, not stored: the component from the route's artifact path,
    // the input from `routeQuerySchemasForPathname`. Storing either would give
    // it somewhere to drift from the route that actually serves it.
    assert.equal(operationComponent("subnets"), "SubnetsArtifact");
    const input = operationInput("subnets");
    assert.ok(input, "subnets publishes a query surface");
    assert.ok("cursor" in input.plain.shape);
    // The same Zod object the REST boundary parses with, not a copy of it.
    assert.equal(input, operationInput("subnets"));
  });

  test("a surface-only operation has neither, and says so with null", () => {
    assert.equal(operationComponent("saved_query"), null);
    assert.equal(operationInput("saved_query"), null);
  });

  test("asking about an unknown id throws from every accessor", () => {
    for (const read of [operationComponent, operationInput, operationPath]) {
      assert.throws(() => read("no-such-operation"), UnknownOperationError);
    }
  });
});

describe("the derived surface tables", () => {
  test("QUERY_BINDINGS reproduces every declared GraphQL exposure", () => {
    assert.equal(QUERY_BINDINGS.length, GRAPHQL_EXPOSURES.length);
    const byField = new Map(
      QUERY_BINDINGS.map((binding) => [binding.field, binding]),
    );
    for (const exposure of GRAPHQL_EXPOSURES) {
      const binding = byField.get(exposure.field);
      assert.ok(binding, `${exposure.field} missing from QUERY_BINDINGS`);
      assert.equal(binding.returns, exposure.returns);
      assert.equal(binding.description, exposure.description);
      assert.equal(binding.reshapes, exposure.reshapes);
      // The path is READ from the route table now, not restated beside it.
      assert.equal(
        binding.route,
        exposure.operation === null
          ? null
          : (operationById(exposure.operation).rest?.path ?? null),
      );
    }
  });

  test("MCP_TOOL_ROUTES reproduces every declared tool exposure", () => {
    assert.equal(
      Object.keys(MCP_TOOL_ROUTES).length,
      Object.keys(MCP_EXPOSURES).length,
    );
    for (const [tool, exposure] of Object.entries(MCP_EXPOSURES)) {
      const derived = MCP_TOOL_ROUTES[tool];
      assert.ok(derived, `${tool} missing from MCP_TOOL_ROUTES`);
      assert.equal(
        derived.route,
        exposure.operation === null
          ? null
          : (operationById(exposure.operation).rest?.path ?? null),
      );
      assert.equal(derived.reason, exposure.reason);
    }
  });

  test("a tool answering several operations keeps every one of them", () => {
    // `get_feed` selects the feed with `kind`, so one tool serves five feed
    // operations. Naming only the first left four reading as agent-unreachable.
    const feed = MCP_EXPOSURES.get_feed;
    assert.ok(feed?.additionalOperations?.length);
    for (const id of feed.additionalOperations) {
      assert.ok(
        operationById(id).mcp.some((exposure) => exposure.tool === "get_feed"),
        `${id} does not record get_feed as an exposure`,
      );
    }
  });
});

describe("validate:operations", () => {
  test("the committed registry passes", () => {
    const report = checkOperations();
    assert.deepEqual(report.unresolved, []);
    assert.deepEqual(report.unexposed, []);
    assert.deepEqual(report.stale, []);
    assert.equal(report.total, OPERATIONS.length);
  });

  test("it FAILS on a GraphQL field naming an operation that does not exist", () => {
    const report = checkOperations(OPERATIONS, [
      ...GRAPHQL_EXPOSURES,
      {
        field: "invented_field",
        operation: "no-such-operation",
        returns: "JSON",
        description: "under test",
      },
    ]);
    assert.equal(report.unresolved.length, 1);
    assert.match(report.unresolved[0]!, /invented_field/);
    assert.match(report.unresolved[0]!, /no-such-operation/);
  });

  test("it FAILS on an MCP tool naming an operation that does not exist", () => {
    const report = checkOperations(OPERATIONS, GRAPHQL_EXPOSURES, {
      ...MCP_EXPOSURES,
      invented_tool: { operation: "no-such-operation" },
    });
    assert.equal(report.unresolved.length, 1);
    assert.match(report.unresolved[0]!, /invented_tool/);
  });

  test("it FAILS on an additionalOperations entry that does not exist", () => {
    const report = checkOperations(OPERATIONS, GRAPHQL_EXPOSURES, {
      ...MCP_EXPOSURES,
      get_feed: { operation: "feed-registry", additionalOperations: ["nope"] },
    });
    assert.equal(report.unresolved.length, 1);
    assert.match(report.unresolved[0]!, /nope/);
  });

  test("it FAILS on an operation no surface exposes", () => {
    const orphan: Operation = {
      id: "orphan-operation",
      rest: null,
      graphql: [],
      mcp: [],
    };
    const report = checkOperations([...OPERATIONS, orphan]);
    assert.equal(report.unexposed.length, 1);
    assert.match(report.unexposed[0]!, /orphan-operation/);
  });

  test("a STALE declaration fails, so the list only shrinks", () => {
    const report = checkOperations(
      OPERATIONS,
      GRAPHQL_EXPOSURES,
      MCP_EXPOSURES,
      {
        ...DECLARED_UNEXPOSED,
        // `subnets` is exposed by both other surfaces, so declaring it unexposed
        // is exactly the exemption that would rot.
        subnets: "under test",
      },
    );
    assert.deepEqual(report.stale, ["subnets"]);
  });

  test("every declared exemption names a real, currently unexposed operation", () => {
    for (const id of Object.keys(DECLARED_UNEXPOSED)) {
      const operation = operationById(id);
      assert.equal(
        operation.graphql.length + operation.mcp.length,
        0,
        `${id} is declared unexposed but has a surface`,
      );
    }
  });
});

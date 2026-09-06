// The cross-boundary vocabulary mirrors (#10005).
//
// `schemas-src/` imports from neither `src/` nor `workers/` -- a rule the code
// states itself. So a vocabulary owned by API_QUERY_COLLECTIONS cannot be
// imported by the schema layer, and hand-mirroring it is the correct answer to
// that constraint rather than a shortcut.
//
// `validate:schema-vocabularies` enforces the match in CI. This pins the same
// invariant as a unit test so it also fails in a plain `npm test`, and so the
// property survives a rewrite of that script.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { API_QUERY_COLLECTIONS } from "../src/contracts.ts";
import {
  CANDIDATE_SORT_VALUES,
  ENDPOINT_POOL_SORT_VALUES,
  ENDPOINT_SORT_VALUES,
  EVIDENCE_ENTRY_SORT_VALUES,
  HEALTH_SURFACE_SORT_VALUES,
  SURFACE_SORT_VALUES,
} from "../schemas-src/mcp-tools/shared.ts";

// Declared by NAME, not matched by shape: endpoint-pools / rpc-pools / pools
// share a sort set by coincidence, and "some collection agrees with this
// tuple" is not the property worth asserting.
const MIRRORS: [string, readonly string[], string][] = [
  ["CANDIDATE_SORT_VALUES", CANDIDATE_SORT_VALUES, "candidates"],
  ["ENDPOINT_POOL_SORT_VALUES", ENDPOINT_POOL_SORT_VALUES, "endpoint-pools"],
  ["ENDPOINT_SORT_VALUES", ENDPOINT_SORT_VALUES, "endpoints"],
  ["EVIDENCE_ENTRY_SORT_VALUES", EVIDENCE_ENTRY_SORT_VALUES, "claims"],
  ["HEALTH_SURFACE_SORT_VALUES", HEALTH_SURFACE_SORT_VALUES, "health-surfaces"],
  ["SURFACE_SORT_VALUES", SURFACE_SORT_VALUES, "curated-surfaces"],
];

const collections = API_QUERY_COLLECTIONS as unknown as Record<
  string,
  { sort_fields?: readonly string[]; filters?: Record<string, unknown> }
>;

describe("mirrored sort vocabularies", () => {
  for (const [name, mirrored, collection] of MIRRORS) {
    test(`${name} equals API_QUERY_COLLECTIONS["${collection}"].sort_fields`, () => {
      const source = collections[collection]?.sort_fields;
      assert.ok(
        Array.isArray(source) && source.length > 0,
        `${collection} must still declare sort_fields, or this mirror has no owner`,
      );
      // A value ADDED to the collection and not the mirror means the route
      // accepts an order the tool rejects. A value REMOVED is worse: the tool
      // keeps advertising a sort the route now ignores, so the caller gets an
      // unsorted answer that looks sorted.
      assert.deepEqual([...mirrored].sort(), [...source!].sort());
    });
  }

  test("the mirror list itself is not stale", () => {
    // Every entry must name a collection that still exists -- otherwise the
    // list quietly stops checking anything, which is how a gate becomes
    // decoration.
    for (const [name, , collection] of MIRRORS) {
      assert.ok(
        collections[collection],
        `${name} names collection "${collection}", which no longer exists`,
      );
    }
  });

  test("the endpoints filter names are DERIVED, not restated", () => {
    // src/mcp-server.ts is on the same side of the boundary as the config, so
    // it has no excuse to copy: ENDPOINTS_QUERY_FILTER_NAMES is now
    // Object.keys(...filters). Asserting the config still HAS filters keeps
    // that derivation meaningful -- deriving from an empty object would pass
    // silently while accepting no filters at all.
    const filters = collections.endpoints?.filters;
    assert.ok(filters && Object.keys(filters).length > 0);
    assert.deepEqual(Object.keys(filters).sort(), [
      "kind",
      "known_status",
      "layer",
      "netuid",
      "pool_eligible",
      "provider",
      "publication_state",
      "status",
    ]);
  });
});

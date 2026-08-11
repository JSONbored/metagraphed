// The four routes that served a whole document with no way to ask for less
// (#9981).
//
// Each was in `NO_QUERY_PARAMETERS` (or, for trajectory, published only
// `format`), and the issue filed them as "whole-document reads whose size is
// the point". Measured against production, they are not:
//
//   /contracts                      166,730 B   artifacts=223
//   /fixtures                       232,384 B   fixtures=408, coverage=663
//   /agent-catalog                  164,965 B   subnets=126
//   /subnets/{netuid}/trajectory    123,846 B   points=400
//
// Collections wearing a document's clothes. Declaring the collection is the
// whole fix -- the router pages any route that names one -- so what this test
// pins is that the declaration is still there. A route silently dropping back
// to `NO_QUERY_PARAMETERS` would restore the 232 KB default with nothing
// failing, which is how it went unnoticed the first time.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../scripts/lib.ts";
import { API_QUERY_COLLECTIONS } from "../src/contracts.ts";

/**
 * Asserted against the EMITTED contract, not the schema builder.
 *
 * `openapi.json` is what a caller actually receives, and the point of this
 * issue was that callers had no lever -- so the published document is the
 * honest place to check for one.
 */
const openapi = JSON.parse(
  readFileSync(path.join(repoRoot, "public/metagraph/openapi.json"), "utf8"),
) as {
  paths: Record<
    string,
    { get?: { parameters?: Array<{ name?: string; $ref?: string }> } }
  >;
};

function publishedParameters(route: string): string[] {
  return (openapi.paths[route]?.get?.parameters ?? []).map(
    (parameter) => parameter.name ?? parameter.$ref?.split("/").pop() ?? "",
  );
}

/** route -> the collection it declares, and the array that collection pages. */
const PAGED = {
  "/api/v1/contracts": ["contracts", "artifacts"],
  "/api/v1/fixtures": ["fixtures", "fixtures"],
  "/api/v1/agent-catalog": ["agent-catalog", "subnets"],
  "/api/v1/subnets/{netuid}/trajectory": ["subnet-trajectory", "points"],
} as const;

describe("routes that serve a document-shaped collection", () => {
  it.each(Object.entries(PAGED))(
    "%s pages a named array",
    (_route, [collection, dataKey]) => {
      const config = (
        API_QUERY_COLLECTIONS as Record<string, { data_key: string }>
      )[collection];
      expect(config, `collection ${collection} is declared`).toBeDefined();
      expect(config.data_key).toBe(dataKey);
    },
  );

  it.each(Object.keys(PAGED))("%s publishes limit and sort", (route) => {
    const published = publishedParameters(route);
    // `limit` is the lever the issue was filed for; `sort` proves the
    // collection composed it rather than a hand-written pair being bolted on.
    expect(published).toContain("limit");
    expect(published).toContain("sort");
  });

  // trajectory kept the CSV download it already advertised -- the collection
  // must not have quietly dropped it.
  it("keeps format on the trajectory route", () => {
    expect(
      publishedParameters("/api/v1/subnets/{netuid}/trajectory"),
    ).toContain("format");
  });
});

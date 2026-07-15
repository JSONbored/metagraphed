/**
 * Providers list CSV export (#5665).
 *
 * Until this issue, GET /api/v1/providers used plain listQuery — format=csv was
 * ignored. csvListQuery("providers") wires the generic list serializer; this
 * suite confirms the export is a real text/csv attachment with scalar columns
 * (no opaque [object Object] cells that would force an exclude option).
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

function req(path) {
  return new Request(`https://api.metagraph.sh${path}`);
}

describe("GET /api/v1/providers?format=csv (#5665)", () => {
  test("returns a named text/csv download with a scalar header row", async () => {
    const res = await handleRequest(
      req("/api/v1/providers?format=csv&limit=5"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="providers.csv"',
    );

    const text = await res.text();
    const lines = text.split("\r\n").filter(Boolean);
    assert.ok(lines.length >= 1, "CSV must include a header row");
    const header = lines[0];
    assert.ok(header.includes(","), "header should list multiple columns");
    assert.match(header, /\bid\b/);
    assert.match(header, /\bname\b/);

    // Projection fields for providers should serialize as scalars — if any
    // cell were `[object Object]` we'd need csvListQuery(..., { exclude }).
    for (const line of lines.slice(1)) {
      assert.doesNotMatch(
        line,
        /\[object Object\]/,
        `row must not leak object cells: ${line.slice(0, 120)}`,
      );
    }
  });

  test("honors Accept: text/csv the same as ?format=csv", async () => {
    const res = await handleRequest(
      new Request("https://api.metagraph.sh/api/v1/providers", {
        headers: { accept: "text/csv" },
      }),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^text\/csv/);
    assert.equal(
      res.headers.get("content-disposition"),
      'attachment; filename="providers.csv"',
    );
  });

  test("keeps the JSON envelope when format is omitted", async () => {
    const res = await handleRequest(
      req("/api/v1/providers?limit=2"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^application\/json/);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.data) || Array.isArray(body.data?.providers));
  });
});

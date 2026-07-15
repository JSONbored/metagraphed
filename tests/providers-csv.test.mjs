import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { handleRequest } from "../workers/api.mjs";
import { createLocalArtifactEnv } from "../scripts/lib.mjs";

// GET /api/v1/providers?format=csv (#5665). The providers route was registered
// with plain listQuery, so the contract-driven dispatcher never treated
// ?format=csv as a CSV request; csvListQuery sets csvResponse on the route
// entry. These cover the generic mechanism against this collection's own data
// shape (array- and object-valued fields), which it had never been exercised
// against.
const req = (path) => new Request(`https://api.metagraph.sh${path}`);

describe("providers CSV export", () => {
  test("?format=csv returns text/csv as an attachment", async () => {
    const res = await handleRequest(
      req("/api/v1/providers?format=csv&limit=3"),
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

  test("the CSV body carries a header row plus the projected rows", async () => {
    const res = await handleRequest(
      req(
        "/api/v1/providers?format=csv&fields=id,name,kind&sort=name&order=asc&limit=2",
      ),
      createLocalArtifactEnv(),
      {},
    );
    const body = await res.text();
    // RFC 4180: the CSV writer emits CRLF row separators.
    const lines = body.trim().split(/\r?\n/);
    assert.equal(lines[0], "id,name,kind");
    assert.equal(lines.length, 3, "header + 2 rows");
  });

  test("json remains the default: no format param still returns the envelope", async () => {
    const res = await handleRequest(
      req("/api/v1/providers?limit=2"),
      createLocalArtifactEnv(),
      {},
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /^application\/json/);
    const body = await res.json();
    assert.equal(body.ok, true);
  });

  test("the filters the CSV url forwards actually narrow the export", async () => {
    const env = createLocalArtifactEnv();
    const all = await handleRequest(
      req("/api/v1/providers?format=csv&fields=id&limit=1000"),
      env,
      {},
    );
    const official = await handleRequest(
      req(
        "/api/v1/providers?format=csv&fields=id&authority=official&limit=1000",
      ),
      env,
      {},
    );
    const allRows = (await all.text()).trim().split("\n").length;
    const officialRows = (await official.text()).trim().split("\n").length;
    assert.ok(officialRows > 1, "authority filter should still return rows");
    assert.ok(
      officialRows < allRows,
      `authority=official (${officialRows}) should be a strict subset of all (${allRows})`,
    );
  });

  test("object- and array-valued provider fields survive CSV serialization", async () => {
    // `social` is object-valued and `netuids` is array-valued; the generic CSV
    // path must quote/serialize them rather than emitting raw commas that would
    // break the column count.
    const res = await handleRequest(
      req("/api/v1/providers?format=csv&fields=id,netuids,social&limit=1000"),
      createLocalArtifactEnv(),
      {},
    );
    const body = await res.text();
    // RFC 4180: the CSV writer emits CRLF row separators.
    const lines = body.trim().split(/\r?\n/);
    assert.equal(lines[0], "id,netuids,social");
    // Every data row must still parse to exactly 3 top-level fields.
    for (const line of lines.slice(1)) {
      let inQuotes = false;
      let fields = 1;
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') i += 1;
          else inQuotes = !inQuotes;
        } else if (ch === "," && !inQuotes) fields += 1;
      }
      assert.equal(
        fields,
        3,
        `row should keep 3 columns: ${line.slice(0, 80)}`,
      );
    }
  });
});

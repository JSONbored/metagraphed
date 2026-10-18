import { describe, expect, it } from "vitest";
import { matchedCatalogFixture } from "./catalog-fixture";

const rows = [
  { id: "a", provider: "fixture" },
  { id: "b", provider: "fixture" },
];
const url = (query: string) => new URL(`http://localhost/api/v1/endpoints?${query}`);

describe("checked catalog fixture boundary", () => {
  it("uses real snapshots while retaining fixture-owned alias matching", () => {
    const request = url("q=alias-absent-from-rows&cursor=0&limit=1&page_snapshot=start");
    const first = JSON.parse(matchedCatalogFixture(request, "endpoints", rows).body);
    expect(first.data.endpoints).toEqual([rows[0]]);
    expect(first.meta.pagination).toMatchObject({
      cursor: 0,
      returned: 1,
      total: 2,
      next_cursor: 1,
    });
    expect(first.meta.pagination.snapshot).toMatch(/^v1\.[0-9a-f]{64}$/);
    request.searchParams.set("cursor", "1");
    request.searchParams.set("page_snapshot", first.meta.pagination.snapshot);
    const second = JSON.parse(matchedCatalogFixture(request, "endpoints", rows).body);
    expect(second.data.endpoints).toEqual([rows[1]]);
    expect(second.meta.pagination.next_cursor).toBeNull();
    const rejected = matchedCatalogFixture(request, "endpoints", rows.slice(1));
    expect(rejected.status).toBe(400);
    expect(JSON.parse(rejected.body)).toMatchObject({
      ok: false,
      error: { code: "invalid_query" },
      meta: { parameter: "page_snapshot" },
    });
    expect(JSON.parse(rejected.body).error).not.toHaveProperty("parameter");
    request.searchParams.set("q", "different-query");
    expect(matchedCatalogFixture(request, "endpoints", rows).status).toBe(400);
  });

  it("uses the actual curated-surfaces collection and rejects changed service generations", () => {
    const request = new URL(
      "http://localhost/api/v1/surfaces?provider=fixture&cursor=0&limit=1&page_snapshot=start",
    );
    const first = JSON.parse(matchedCatalogFixture(request, "surfaces", rows).body);
    expect(first.data.surfaces).toEqual([rows[0]]);
    expect(first.meta.pagination.snapshot).toMatch(/^v1\.[0-9a-f]{64}$/);
    request.searchParams.set("cursor", "1");
    request.searchParams.set("page_snapshot", first.meta.pagination.snapshot);
    expect(matchedCatalogFixture(request, "surfaces", rows).status).toBe(200);
    expect(matchedCatalogFixture(request, "surfaces", rows.slice(1)).status).toBe(400);
    request.searchParams.set("page_snapshot", "invalid");
    expect(matchedCatalogFixture(request, "surfaces", rows).status).toBe(400);
  });

  it("retains strict invalid-input rejection and deliberately missing-total responses", () => {
    for (const query of [
      "cursor=2&page_snapshot=start",
      "cursor=0&page_snapshot=invalid",
      "cursor=1e2&page_snapshot=start",
      "cursor=0&cursor=1&page_snapshot=start",
    ]) {
      expect(matchedCatalogFixture(url(query), "endpoints", rows).status).toBe(400);
    }
    const broken = JSON.parse(
      matchedCatalogFixture(
        url("cursor=0&page_snapshot=start"),
        "endpoints",
        rows,
        {},
        { omitTotal: true },
      ).body,
    );
    expect(broken.meta.pagination.snapshot).toMatch(/^v1\.[0-9a-f]{64}$/);
    expect(broken.meta.pagination).not.toHaveProperty("total");
    const legacy = JSON.parse(matchedCatalogFixture(url("cursor=0"), "endpoints", rows).body);
    expect(legacy.meta.pagination).not.toHaveProperty("snapshot");
  });
});

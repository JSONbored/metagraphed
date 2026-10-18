import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { z } from "zod";
import { listQuerySchema, API_ROUTES } from "../src/contracts.ts";
import { sampleFromSchema } from "../src/openapi-sample.ts";
import { PaginationMetaSchema } from "../schemas-src/envelope.ts";
import {
  collectionSnapshotParamSchema,
  collectionSnapshotSchema,
} from "../schemas-src/query-params.ts";
import { deriveQueryArguments } from "../schemas-src/graphql/query-arguments.ts";
import {
  applyQueryFilters,
  canonicalListSearch,
  paginationLinkHeader,
  type Row,
} from "../workers/list-query.ts";
import { historyJson } from "../src/history-sha256.ts";
import { DEFAULT_LIMIT } from "../workers/request-params.ts";

const rows = ["a", "b", "c", "d"].map((id) => ({ id, name: "Same" }));
const url = (search: string) =>
  new URL(`https://api.metagraph.sh/api/v1/providers?${search}`);
const page = (values: Row[], request: URL) =>
  applyQueryFilters({ providers: values }, request, "providers", [], {
    csvResponse: true,
  });

function checked(result: ReturnType<typeof page>) {
  if (result.error) assert.fail(result.error.message);
  assert.ok(result.meta.pagination);
  return {
    ids: (result.data as { providers: Row[] }).providers.map((row) => row.id),
    pagination: result.meta.pagination,
  };
}

function continuation(snapshot: string | undefined, cursor = "2") {
  assert.ok(snapshot);
  const request = url("limit=2");
  request.searchParams.set("page_snapshot", snapshot);
  request.searchParams.set("cursor", cursor);
  return request;
}

describe("checked collection paging (#12094)", () => {
  test("generated snapshot examples satisfy their canonical response and query schemas", () => {
    const responseSchema = collectionSnapshotSchema();
    const response = sampleFromSchema(z.toJSONSchema(responseSchema), {});
    assert.equal(responseSchema.parse(response), response);
    const querySchema = collectionSnapshotParamSchema();
    const query = sampleFromSchema(z.toJSONSchema(querySchema), {});
    assert.equal(querySchema.parse(query), "start");
  });

  test("reproduces legacy deletion skips and insertion duplicates; guarded pages reject both", () => {
    const first = checked(page(rows, url("limit=2")));
    assert.deepEqual(first.ids, ["a", "b"]);
    assert.equal(first.pagination.next_cursor, 2);
    assert.equal(Object.hasOwn(first.pagination, "snapshot"), false);
    // Removing a makes c move before offset 2. Inserting before a repeats b.
    const deleted = rows.slice(1);
    const inserted = [{ id: "z", name: "Same" }, ...rows];
    assert.deepEqual(checked(page(deleted, url("limit=2&cursor=2"))).ids, [
      "d",
    ]);
    assert.deepEqual(checked(page(inserted, url("limit=2&cursor=2"))).ids, [
      "b",
      "c",
    ]);

    const guarded = checked(page(rows, url("limit=2&page_snapshot=start")));
    PaginationMetaSchema.parse(guarded.pagination);
    for (const changed of [deleted, inserted]) {
      const rejected = page(changed, continuation(guarded.pagination.snapshot));
      assert.equal(rejected.error?.parameter, "page_snapshot");
      assert.match(rejected.error?.message ?? "", /restart/);
      assert.equal(rejected.data, undefined);
    }
  });

  test("duplicate sort keys traverse unchanged rows exactly once; tied reorder invalidates", () => {
    const firstUrl = url("sort=name&order=desc&limit=2&page_snapshot=start");
    const first = checked(page(rows, firstUrl));
    const next = continuation(first.pagination.snapshot);
    next.searchParams.set("sort", "name");
    next.searchParams.set("order", "desc");
    assert.deepEqual(
      [...first.ids, ...checked(page(rows, next)).ids],
      ["a", "b", "c", "d"],
    );
    assert.equal(
      page([rows[1], rows[0], ...rows.slice(2)], next).error?.parameter,
      "page_snapshot",
    );
  });

  test("projection cannot hide a row mutation and sort changes cannot reuse a token", () => {
    const first = checked(
      page(rows, url("limit=2&fields=id&page_snapshot=start")),
    );
    const next = continuation(first.pagination.snapshot);
    next.searchParams.set("fields", "id");
    assert.deepEqual(checked(page(rows, next)).ids, ["c", "d"]);
    assert.equal(
      page(
        rows.map((row, i) => (i === 3 ? { ...row, name: "Changed" } : row)),
        next,
      ).error?.parameter,
      "page_snapshot",
    );
    next.searchParams.set("sort", "id");
    assert.equal(page(rows, next).error?.parameter, "page_snapshot");
  });

  test("all Link relations preserve the digest; default limits and CSV negotiation remain usable", () => {
    const many = Array.from({ length: DEFAULT_LIMIT + 1 }, (_, i) => ({
      id: String(i),
    }));
    const firstUrl = url("page_snapshot=start");
    const first = checked(page(many, firstUrl));
    assert.equal(first.pagination.limit, DEFAULT_LIMIT);
    const header = paginationLinkHeader(firstUrl, first.pagination, {
      queryCollection: "providers",
      searchParams: { format: "csv", page_snapshot: "start" },
    });
    const match = header?.match(/<([^>]+)>; rel="next"/);
    assert.ok(match);
    const next = new URL(match[1]);
    assert.equal(
      next.searchParams.get("page_snapshot"),
      first.pagination.snapshot,
    );
    for (const link of String(header).matchAll(/<([^>]+)>/g)) {
      assert.equal(
        new URL(link[1]).searchParams.get("page_snapshot"),
        first.pagination.snapshot,
      );
    }
    assert.deepEqual(checked(page(many, next)).ids, [String(DEFAULT_LIMIT)]);
    const back = paginationLinkHeader(
      next,
      checked(page(many, next)).pagination,
      {
        queryCollection: "providers",
      },
    );
    assert.match(back ?? "", /rel="first"/);
    assert.match(back ?? "", /rel="prev"/);
    assert.ok(!String(back).includes("page_snapshot=start"));
    for (const link of String(back).matchAll(/<([^>]+)>/g)) {
      assert.equal(
        new URL(link[1]).searchParams.get("page_snapshot"),
        first.pagination.snapshot,
      );
    }
    assert.equal(
      new URLSearchParams(canonicalListSearch(next, "providers")).get(
        "page_snapshot",
      ),
      first.pagination.snapshot,
    );
  });

  test("query parameter order and object-key order do not invalidate equivalent input", () => {
    const first = checked(
      page(rows, url("sort=id&limit=2&page_snapshot=start")),
    );
    const next = continuation(first.pagination.snapshot);
    next.searchParams.set("sort", "id");
    assert.deepEqual(
      checked(
        page(
          rows.map(({ id, name }) => ({ name, id })),
          next,
        ),
      ).ids,
      ["c", "d"],
    );
  });

  test("invalid or unsupported tokens and invalid continuation offsets never restart silently", () => {
    const first = checked(page(rows, url("limit=2&page_snapshot=start")));
    for (const cursor of [
      "",
      "1e2",
      "0x2",
      "2.0",
      "+2",
      " 2 ",
      "-1",
      "9007199254740992",
    ]) {
      assert.equal(
        page(rows, continuation(first.pagination.snapshot, cursor)).error
          ?.parameter,
        "cursor",
      );
    }
    for (const token of [
      "",
      "unknown",
      "v2." + "a".repeat(64),
      "v1." + "A".repeat(64),
      "v1." + "a".repeat(63),
      "v1." + "0".repeat(64),
    ]) {
      const request = continuation(first.pagination.snapshot);
      request.searchParams.set("page_snapshot", token);
      assert.equal(page(rows, request).error?.parameter, "page_snapshot");
    }
    const duplicate = continuation(first.pagination.snapshot);
    duplicate.searchParams.append("cursor", "2");
    assert.equal(page(rows, duplicate).error?.parameter, "cursor");
    assert.equal(
      page(rows, url("limit=2&cursor=2&page_snapshot=start")).error?.parameter,
      "page_snapshot",
    );
    const malformedLimit = continuation(first.pagination.snapshot);
    malformedLimit.searchParams.set("limit", "2.0");
    assert.equal(page(rows, malformedLimit).error?.parameter, "limit");
    assert.equal(
      applyQueryFilters({}, url("page_snapshot=start"), "providers").error
        ?.parameter,
      "page_snapshot",
    );
  });

  test("public network and resolved route-owned window scopes are part of identity", () => {
    const firstUrl = url("limit=2&page_snapshot=start");
    const first = checked(page(rows, firstUrl));
    const request = continuation(first.pagination.snapshot);
    const anotherNetwork = new URL(request);
    anotherNetwork.pathname = "/testnet/api/v1/providers";
    assert.equal(
      applyQueryFilters({ providers: rows }, request, "providers", [], {
        snapshotUrl: anotherNetwork,
      }).error?.parameter,
      "page_snapshot",
    );
    const incidentsUrl = new URL(
      "https://api.metagraph.sh/api/v1/incidents?limit=2&page_snapshot=start",
    );
    const scoped = new URL(incidentsUrl);
    scoped.searchParams.set("window", "7d");
    const incidentPage = applyQueryFilters(
      { surfaces: rows },
      incidentsUrl,
      "incidents",
      [],
      { snapshotUrl: scoped },
    );
    assert.ok(!incidentPage.error);
    assert.ok(incidentPage.meta.pagination?.snapshot);
    incidentsUrl.searchParams.set(
      "page_snapshot",
      incidentPage.meta.pagination.snapshot,
    );
    incidentsUrl.searchParams.set("cursor", "2");
    scoped.searchParams.set("window", "30d");
    assert.equal(
      applyQueryFilters({ surfaces: rows }, incidentsUrl, "incidents", [], {
        snapshotUrl: scoped,
      }).error?.parameter,
      "page_snapshot",
    );
  });

  test("the REST schema is canonical while unsupported GraphQL arguments remain absent", () => {
    const schema = listQuerySchema("providers");
    assert.ok(schema.safeParse({ page_snapshot: "start", cursor: 0 }).success);
    assert.ok(!schema.safeParse({ page_snapshot: "invented" }).success);
    const route = API_ROUTES.find(
      (entry) => entry.path === "/api/v1/providers",
    );
    assert.ok(
      route?.query_parameters?.some((entry) => entry.name === "page_snapshot"),
    );
    const args = deriveQueryArguments(
      "providers",
      "/api/v1/providers",
      {
        paths: {
          "/api/v1/providers": {
            get: {
              parameters: [
                { name: "cursor", in: "query", schema: { type: "integer" } },
                {
                  name: "page_snapshot",
                  in: "query",
                  schema: { type: "string" },
                },
              ],
            },
          },
        },
      },
      { hasNetworkTwin: false, returnsProjectable: false },
    );
    assert.deepEqual(
      args.map((arg) => arg.name),
      ["cursor"],
    );
  });
});

test("checked hash work has inclusive row/byte/depth bounds; legacy results are not truncated", () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ id: String(i) }));
  assert.equal(
    checked(page(many, url("page_snapshot=start&limit=2"))).pagination.total,
    5000,
  );
  const oversized = [...many, { id: "extra" }];
  const rejected = page(oversized, url("page_snapshot=start&limit=2"));
  assert.equal(rejected.error?.reason, "catalog_budget_exceeded");
  assert.match(rejected.error?.message ?? "", /Narrow filters/);
  assert.equal(rejected.data, undefined);
  assert.equal(checked(page(oversized, url("limit=2"))).pagination.total, 5001);
  const huge = page(
    [{ id: "x", name: "界".repeat(6 * 1024 * 1024) }],
    url("page_snapshot=start"),
  );
  assert.equal(huge.error?.reason, "catalog_budget_exceeded");
  let nested: unknown = 0;
  for (let i = 0; i < 65; i += 1) nested = [nested];
  assert.equal(
    page([{ id: "x", nested }], url("page_snapshot=start")).error?.reason,
    "catalog_budget_exceeded",
  );
  assert.equal(
    applyQueryFilters({}, url("page_snapshot=start"), "providers").error
      ?.reason,
    "catalog_unavailable",
  );
});

test("the canonical byte budget accepts exactly 16 MiB and rejects the next byte", () => {
  const request = url("page_snapshot=start&limit=1");
  const identity = { scope: ["providers", "/api/v1/providers"], query: [] };
  const overhead = Buffer.byteLength(
    historyJson(identity) + "\n" + historyJson({ id: "x", name: "" }) + "\n",
  );
  const row = { id: "x", name: "x".repeat(16 * 1024 * 1024 - overhead) };
  assert.match(
    checked(page([row], request)).pagination.snapshot ?? "",
    /^v1\./,
  );
  assert.equal(
    page([{ ...row, name: row.name + "x" }], request).error?.reason,
    "catalog_budget_exceeded",
  );
});

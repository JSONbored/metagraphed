import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import * as listQuery from "../workers/list-query.ts";
import {
  GLOBAL_INCIDENTS_SORT_FIELDS,
  applyGlobalIncidentsListQuery,
  globalIncidentsMcpError,
  globalIncidentsQueryUrl,
} from "../src/global-incidents-mcp.ts";
import type { Row } from "./row-type.ts";

const SAMPLE_DATA = {
  schema_version: 1,
  window: "7d",
  observed_at: "2026-07-01T00:00:00.000Z",
  source: "live-cron-prober",
  summary: { incident_count: 2, affected_surface_count: 2 },
  surfaces: [
    { netuid: 7, surface_id: "a", incident_count: 1, downtime_ms: 1000 },
    { netuid: 31, surface_id: "b", incident_count: 2, downtime_ms: 5000 },
  ],
};

describe("global-incidents-mcp", () => {
  test("globalIncidentsMcpError is shaped for MCP toolError handling", () => {
    const err = globalIncidentsMcpError("invalid_params", "bad sort");
    assert.equal(err.code, "invalid_params");
    assert.equal(err.toolError, true);
  });

  test("GLOBAL_INCIDENTS_SORT_FIELDS mirrors the incidents collection's sort fields", () => {
    assert.deepEqual(GLOBAL_INCIDENTS_SORT_FIELDS, [
      "downtime_ms",
      "incident_count",
      "netuid",
      "surface_id",
    ]);
  });

  test("globalIncidentsQueryUrl forwards netuid/sort/order/limit/cursor", () => {
    const url = globalIncidentsQueryUrl({
      netuid: 7,
      sort: "downtime_ms",
      order: "desc",
      limit: 10,
      cursor: 5,
    });
    assert.equal(url.searchParams.get("netuid"), "7");
    assert.equal(url.searchParams.get("sort"), "downtime_ms");
    assert.equal(url.searchParams.get("order"), "desc");
    assert.equal(url.searchParams.get("limit"), "10");
    assert.equal(url.searchParams.get("cursor"), "5");
  });

  test("globalIncidentsQueryUrl omits unset params", () => {
    const url = globalIncidentsQueryUrl({});
    assert.equal(url.searchParams.toString(), "");
  });

  test("globalIncidentsQueryUrl tolerates a null/undefined args bag", () => {
    const url = globalIncidentsQueryUrl(null);
    assert.equal(url.searchParams.toString(), "");
  });

  test("globalIncidentsQueryUrl rejects invalid netuid", () => {
    assert.throws(
      () => globalIncidentsQueryUrl({ netuid: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("globalIncidentsQueryUrl rejects a fractional netuid", () => {
    assert.throws(
      () => globalIncidentsQueryUrl({ netuid: 1.5 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("globalIncidentsQueryUrl rejects invalid sort", () => {
    assert.throws(
      () => globalIncidentsQueryUrl({ sort: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("globalIncidentsQueryUrl rejects invalid order", () => {
    assert.throws(
      () => globalIncidentsQueryUrl({ order: "bogus" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("globalIncidentsQueryUrl rejects a non-numeric limit", () => {
    assert.throws(
      () => globalIncidentsQueryUrl({ limit: "lots" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("globalIncidentsQueryUrl rejects a sub-minimum limit", () => {
    assert.throws(
      () => globalIncidentsQueryUrl({ limit: 0 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("globalIncidentsQueryUrl rejects a limit above the MCP maximum", () => {
    assert.throws(
      () => globalIncidentsQueryUrl({ limit: 500 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("globalIncidentsQueryUrl rejects negative cursor", () => {
    assert.throws(
      () => globalIncidentsQueryUrl({ cursor: -1 }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("globalIncidentsQueryUrl rejects a non-numeric cursor", () => {
    assert.throws(
      () => globalIncidentsQueryUrl({ cursor: "nope" }),
      (err: Row) => err.code === "invalid_params",
    );
  });

  test("applyGlobalIncidentsListQuery filters by netuid", () => {
    const out = applyGlobalIncidentsListQuery(SAMPLE_DATA, { netuid: 7 });
    assert.equal(out.returned, 1);
    assert.equal(out.surfaces[0].netuid, 7);
  });

  test("applyGlobalIncidentsListQuery sorts and pages the surfaces ledger", () => {
    const out = applyGlobalIncidentsListQuery(SAMPLE_DATA, {
      sort: "netuid",
      order: "desc",
      limit: 1,
    });
    assert.equal(out.returned, 1);
    assert.equal(out.total, 2);
    assert.equal(out.surfaces[0].netuid, 31);
    assert.equal(out.next_cursor, 1);
  });

  test("applyGlobalIncidentsListQuery preserves non-list-query fields verbatim", () => {
    const out = applyGlobalIncidentsListQuery(SAMPLE_DATA, {});
    assert.equal(out.schema_version, 1);
    assert.equal(out.window, "7d");
    assert.equal(out.observed_at, "2026-07-01T00:00:00.000Z");
    assert.equal(out.source, "live-cron-prober");
    assert.deepEqual(out.summary, {
      incident_count: 2,
      affected_surface_count: 2,
    });
  });

  test("applyGlobalIncidentsListQuery preserves arbitrary passthrough fields", () => {
    const out = applyGlobalIncidentsListQuery(
      { schema_version: 1, marker: "from-postgres" },
      {},
    );
    assert.equal(out.marker, "from-postgres");
    assert.deepEqual(out.surfaces, []);
  });

  test("applyGlobalIncidentsListQuery rejects invalid list-query params from REST parity", async () => {
    const spy = vi
      .spyOn(listQuery, "applyQueryFilters")
      .mockReturnValue({ error: { parameter: "sort", message: "bad sort" } });
    try {
      assert.throws(
        () => applyGlobalIncidentsListQuery(SAMPLE_DATA, {}),
        (err: Row) =>
          err.code === "invalid_params" && /bad sort/.test(err.message),
      );
    } finally {
      spy.mockRestore();
    }
  });

  test("applyGlobalIncidentsListQuery falls back when pagination meta is absent", () => {
    const spy = vi.spyOn(listQuery, "applyQueryFilters").mockReturnValue({
      data: { surfaces: [{ surface_id: "a" }, { surface_id: "b" }] },
      meta: {},
    });
    try {
      const out = applyGlobalIncidentsListQuery(SAMPLE_DATA, {});
      assert.equal(out.total, 2);
      assert.equal(out.returned, 2);
      assert.equal(out.limit, 2);
      assert.equal(out.cursor, 0);
      assert.equal(out.next_cursor, null);
      assert.equal(out.sort, null);
      assert.equal(out.order, null);
    } finally {
      spy.mockRestore();
    }
  });

  test("applyGlobalIncidentsListQuery treats a non-array surfaces key as empty", () => {
    const out = applyGlobalIncidentsListQuery(
      { schema_version: 1, surfaces: null },
      {},
    );
    assert.deepEqual(out.surfaces, []);
    assert.equal(out.total, 0);
  });
});

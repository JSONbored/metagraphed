import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadBulkHealthTrends } from "../src/bulk-health-trends.ts";
import type { Row } from "./row-type.ts";

describe("loadBulkHealthTrends", () => {
  // D1 fully eliminated (2026-07-17): surface_uptime_daily is Postgres-only
  // now, so this loader is only reached on a tier miss and always returns the
  // schema-stable empty shape.
  test("returns schema-stable empty windows (D1 retired)", async () => {
    const { data, rows } = (await loadBulkHealthTrends({
      observedAt: "2026-06-15T00:00:00.000Z",
    })) as Row;
    assert.deepEqual(rows, []);
    assert.equal(data.schema_version, 1);
    assert.equal(data.observed_at, "2026-06-15T00:00:00.000Z");
    assert.equal(data.windows["7d"].subnet_count, 0);
    assert.deepEqual(data.windows["7d"].subnets, []);
    assert.equal(data.windows["30d"].subnet_count, 0);
    assert.deepEqual(data.windows["30d"].subnets, []);
  });
});

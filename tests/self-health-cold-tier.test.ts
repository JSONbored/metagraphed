// The self-health cold tier's specific properties: only the daily rollup
// survives the box, so `latest` is always empty (current_ok null, verdict
// floor "degraded" — unmeasured, never a synthesized tick), the 90-day
// window is the identical lexicographic comparison the Postgres route's
// DATE filter performs, and any row that cannot be restored to the driver
// shape declines the whole read rather than understating uptime.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { loadSelfHealthColdTier } from "../src/self-health-cold-tier.ts";
import { R2_SQL_TOKEN_ENV } from "../src/r2-sql.ts";

const TOKEN = { [R2_SQL_TOKEN_ENV]: "cfut_test" };
// 2026-08-02T12:00Z -> a 90-day window whose inclusive floor is 2026-05-05.
const NOW_MS = Date.UTC(2026, 7, 2, 12);

function dailyRow(overrides: Record<string, unknown> = {}) {
  return {
    day: "2026-08-01",
    component: "api",
    checks: 96,
    ok_count: 95,
    ...overrides,
  };
}

function sqlFetch(...responses: unknown[][]) {
  const queries: string[] = [];
  let call = 0;
  globalThis.fetch = (async (_u: string, init: RequestInit) => {
    queries.push(JSON.parse(String(init.body)).query);
    const rows = responses[Math.min(call, responses.length - 1)] ?? [];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: { rows } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return queries;
}

describe("loadSelfHealthColdTier", () => {
  test("serves the preserved daily series with no current readings", async () => {
    const q = sqlFetch([
      dailyRow(),
      dailyRow({ day: "2026-07-31", ok_count: 96 }),
    ]);
    const data = await loadSelfHealthColdTier(TOKEN as never, NOW_MS);
    assert.match(
      q[0]!,
      /SELECT day, component, checks, ok_count FROM chain\.self_health_daily/,
    );
    assert.match(q[0]!, /ORDER BY component, day/);
    const api = data!.components.find((c) => c.component === "api")!;
    assert.equal(api.days.length, 2);
    assert.equal(
      api.days[0]!.day,
      "2026-07-31",
      "oldest first, like the route",
    );
    assert.equal(api.current_ok, null, "unmeasured, never a synthesized tick");
    assert.equal(
      data!.verdict,
      "degraded",
      "no evidence, no operational claim",
    );
    assert.equal(data!.measured_component_count, 0);
    assert.equal(data!.observed_at, null);
  });

  test("applies the same inclusive 90-day floor the Postgres route derives", async () => {
    sqlFetch([
      dailyRow({ day: "2026-05-04" }),
      dailyRow({ day: "2026-05-05" }),
    ]);
    const data = await loadSelfHealthColdTier(TOKEN as never, NOW_MS);
    const api = data!.components.find((c) => c.component === "api")!;
    assert.equal(
      api.days.length,
      1,
      "the pre-cutoff day is outside the window",
    );
    assert.equal(api.days[0]!.day, "2026-05-05");
  });

  test("declines on any row that cannot be restored to the driver shape", async () => {
    for (const bad of [
      { day: 20260801 },
      { day: "08/01/2026" },
      { component: null },
      { checks: "many" },
      { ok_count: "most" },
    ]) {
      sqlFetch([dailyRow(bad)]);
      assert.equal(
        await loadSelfHealthColdTier(TOKEN as never, NOW_MS),
        null,
        JSON.stringify(bad),
      );
    }
  });

  test("defaults the window to now; a failed query yields null", async () => {
    sqlFetch([dailyRow({ day: "1999-01-01" })]);
    const data = await loadSelfHealthColdTier(TOKEN as never);
    assert.ok(data, "an all-aged-out table is an answer, not a decline");
    const api = data!.components.find((c) => c.component === "api")!;
    assert.equal(api.days.length, 0);

    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    assert.equal(await loadSelfHealthColdTier(TOKEN as never, NOW_MS), null);
  });
});

import { describe, expect, it } from "vitest";
import {
  buildSelfHealth,
  selfHealthVerdict,
  SELF_HEALTH_COMPONENTS,
  type SelfHealthComponentView,
  type SelfHealthDailyRow,
  type SelfHealthLatestRow,
} from "../src/self-health.ts";

const TICK = Date.parse("2026-07-26T20:00:00.000Z");

function latest(
  component: string,
  ok: boolean,
  over: Partial<SelfHealthLatestRow> = {},
): SelfHealthLatestRow {
  return {
    component,
    ok,
    http_status: ok ? 200 : 503,
    latency_ms: 42,
    checked_at_ms: TICK,
    ...over,
  };
}

function daily(
  component: string,
  day: string,
  checks: number,
  ok_count: number,
): SelfHealthDailyRow {
  return { component, day, checks, ok_count };
}

function view(
  component: string,
  current_ok: boolean | null,
): SelfHealthComponentView {
  return {
    component,
    current_ok,
    http_status: null,
    latency_ms: null,
    checked_at: null,
    days: [],
    uptime_90d: null,
  };
}

describe("selfHealthVerdict (#8318)", () => {
  it("is operational only when every measured component is up", () => {
    expect(
      selfHealthVerdict([
        view("api", true),
        view("site", true),
        view("publish", true),
      ]),
    ).toBe("operational");
  });

  it("calls an outage when the api itself is down", () => {
    // api is load-bearing: if it's down the site has nothing to render and
    // every client is broken.
    expect(
      selfHealthVerdict([
        view("api", false),
        view("site", true),
        view("publish", true),
      ]),
    ).toBe("outage");
  });

  it("degrades rather than outages when site or publish alone is failing", () => {
    // Real problems, but the API is still answering.
    expect(selfHealthVerdict([view("api", true), view("site", false)])).toBe(
      "degraded",
    );
    expect(selfHealthVerdict([view("api", true), view("publish", false)])).toBe(
      "degraded",
    );
  });

  it("does not count an unmeasured component as failing", () => {
    // "We haven't probed this yet" and "this is down" are different claims,
    // and only one of them is ours to make.
    expect(
      selfHealthVerdict([
        view("api", true),
        view("site", null),
        view("publish", null),
      ]),
    ).toBe("operational");
  });

  it("reports degraded, not operational, when nothing has been measured at all", () => {
    // We can't assert health without evidence -- but an empty table isn't an
    // outage either.
    expect(selfHealthVerdict([])).toBe("degraded");
    expect(selfHealthVerdict([view("api", null), view("site", null)])).toBe(
      "degraded",
    );
  });

  it("degrades when a non-api component is down and api has no reading", () => {
    // No api verdict to escalate on, but something measured is failing.
    expect(selfHealthVerdict([view("api", null), view("site", false)])).toBe(
      "degraded",
    );
  });
});

describe("buildSelfHealth", () => {
  it("returns all three components even when the tables are empty", () => {
    const out = buildSelfHealth([], []);
    expect(out.components.map((c) => c.component)).toEqual([
      ...SELF_HEALTH_COMPONENTS,
    ]);
    // Null, not false: nothing has been probed.
    expect(out.components.every((c) => c.current_ok === null)).toBe(true);
    expect(out.components.every((c) => c.days.length === 0)).toBe(true);
    expect(out.components.every((c) => c.uptime_90d === null)).toBe(true);
    expect(out.measured_component_count).toBe(0);
    expect(out.observed_at).toBeNull();
    expect(out.verdict).toBe("degraded");
    expect(out.schema_version).toBe(1);
  });

  it("computes a daily uptime ratio and the 90d mean", () => {
    const out = buildSelfHealth(
      [
        daily("api", "2026-07-25", 1440, 1440),
        daily("api", "2026-07-26", 1000, 500),
      ],
      [latest("api", true)],
    );
    const api = out.components.find((c) => c.component === "api")!;
    expect(api.days.map((d) => d.uptime_ratio)).toEqual([1, 0.5]);
    expect(api.uptime_90d).toBe(0.75);
  });

  it("omits days with no rows instead of zero-filling them", () => {
    // A gap means "we weren't measuring". Rendering it as 0% would invent an
    // outage that never happened -- the house rule is probe-derived only.
    const out = buildSelfHealth(
      [daily("api", "2026-07-20", 10, 10), daily("api", "2026-07-26", 10, 10)],
      [],
    );
    const api = out.components.find((c) => c.component === "api")!;
    expect(api.days.map((d) => d.day)).toEqual(["2026-07-20", "2026-07-26"]);
    expect(api.days).toHaveLength(2);
  });

  it("drops a zero-check day rather than dividing by zero", () => {
    const out = buildSelfHealth([daily("api", "2026-07-26", 0, 0)], []);
    expect(out.components.find((c) => c.component === "api")!.days).toEqual([]);
  });

  it("sorts days oldest-first regardless of row order", () => {
    const out = buildSelfHealth(
      [daily("api", "2026-07-26", 1, 1), daily("api", "2026-07-01", 1, 1)],
      [],
    );
    expect(
      out.components.find((c) => c.component === "api")!.days.map((d) => d.day),
    ).toEqual(["2026-07-01", "2026-07-26"]);
  });

  it("keeps the newest tick when a component has several", () => {
    const out = buildSelfHealth(
      [],
      [
        latest("api", false, { checked_at_ms: TICK - 60_000 }),
        latest("api", true, { checked_at_ms: TICK }),
      ],
    );
    const api = out.components.find((c) => c.component === "api")!;
    expect(api.current_ok).toBe(true);
    expect(api.checked_at).toBe(new Date(TICK).toISOString());
  });

  it("carries latency and status through, including nulls from a derived check", () => {
    // `publish` is derived from the api body, so it has no HTTP status or
    // latency of its own.
    const out = buildSelfHealth(
      [],
      [latest("publish", true, { http_status: null, latency_ms: null })],
    );
    const publish = out.components.find((c) => c.component === "publish")!;
    expect(publish.http_status).toBeNull();
    expect(publish.latency_ms).toBeNull();
    expect(publish.current_ok).toBe(true);
  });

  it("ignores a component the poller doesn't write", () => {
    // A stray row from an older schema must not appear as a fourth component.
    const out = buildSelfHealth(
      [daily("legacy", "2026-07-26", 5, 5)],
      [latest("legacy", true)],
    );
    expect(out.components).toHaveLength(3);
    expect(out.components.some((c) => c.component === "legacy")).toBe(false);
  });

  it("reports observed_at as the newest tick across every component", () => {
    const out = buildSelfHealth(
      [],
      [
        latest("api", true, { checked_at_ms: TICK - 5_000 }),
        latest("site", true, { checked_at_ms: TICK }),
      ],
    );
    expect(out.observed_at).toBe(new Date(TICK).toISOString());
    expect(out.measured_component_count).toBe(2);
  });

  it("survives an unparseable timestamp rather than emitting Invalid Date", () => {
    const out = buildSelfHealth(
      [],
      [latest("api", true, { checked_at_ms: NaN })],
    );
    const api = out.components.find((c) => c.component === "api")!;
    expect(api.checked_at).toBeNull();
    expect(out.observed_at).toBeNull();
  });

  it("derives the verdict from its own components, never from anything else", () => {
    const out = buildSelfHealth(
      [],
      [latest("api", false), latest("site", true)],
    );
    expect(out.verdict).toBe("outage");
  });
});

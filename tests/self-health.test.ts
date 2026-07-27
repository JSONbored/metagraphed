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
    note: null,
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

  it("degrades rather than outages when site alone is failing", () => {
    // A real problem, but the API is still answering.
    expect(selfHealthVerdict([view("api", true), view("site", false)])).toBe(
      "degraded",
    );
  });

  it("stays operational when publish alone is stale (#8352)", () => {
    // publish measures data-pipeline CADENCE, not an HTTP surface -- both api
    // and site are fully up and answering correctly here. A stale publish is
    // a real, surfaced signal (see the buildSelfHealth `note` tests below),
    // but it must not drag the public verdict to "degraded" the way an
    // actual api/site outage does.
    expect(
      selfHealthVerdict([
        view("api", true),
        view("site", true),
        view("publish", false),
      ]),
    ).toBe("operational");
    // Holds even without a site reading.
    expect(selfHealthVerdict([view("api", true), view("publish", false)])).toBe(
      "operational",
    );
  });

  it("still outages on a down api even when publish is also stale", () => {
    // publish's special-cased leniency must not blunt the load-bearing api
    // check -- an api outage matters regardless of what else is failing.
    expect(
      selfHealthVerdict([view("api", false), view("publish", false)]),
    ).toBe("outage");
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

  it("handles checked_at_ms arriving as a BIGINT string, which is what postgres.js sends", () => {
    // Regression guard. BIGINT comes back as a string under this Worker's
    // `fetch_types: false`, and treating it as a number made Number.isFinite
    // false -- nulling every timestamp -- while `>` compared lexicographically
    // on the newest-tick pick. Caught by the generated row type, not by tsc.
    const out = buildSelfHealth(
      [],
      [
        { ...latest("api", false), checked_at_ms: String(TICK - 60_000) },
        { ...latest("api", true), checked_at_ms: String(TICK) },
      ],
    );
    const api = out.components.find((c) => c.component === "api")!;
    expect(api.checked_at).toBe(new Date(TICK).toISOString());
    expect(api.current_ok).toBe(true);
    expect(out.observed_at).toBe(new Date(TICK).toISOString());
  });

  it("picks the newest tick numerically, not lexicographically", () => {
    // "9" > "10" as strings. A 10-digit-to-11-digit epoch rollover, or any
    // pair straddling a digit-count change, would pick the older row.
    const out = buildSelfHealth(
      [],
      [
        { ...latest("api", false), checked_at_ms: "9999999999" },
        { ...latest("api", true), checked_at_ms: "10000000000" },
      ],
    );
    expect(out.components.find((c) => c.component === "api")!.current_ok).toBe(
      true,
    );
  });

  it("rejects a finite but out-of-range epoch instead of emitting Invalid Date", () => {
    // |ms| > 8.64e15 is past the JS Date limit: finite, so it survives
    // Number.isFinite, but new Date(ms) is Invalid and toISOString() throws.
    const out = buildSelfHealth(
      [],
      [latest("api", true, { checked_at_ms: 8.7e15 })],
    );
    expect(
      out.components.find((c) => c.component === "api")!.checked_at,
    ).toBeNull();
  });

  it("keeps the first tick when a later row for the same component is older", () => {
    // The reverse order of the newest-wins case above, so the comparison
    // itself is exercised in both directions rather than only via !existing.
    const out = buildSelfHealth(
      [],
      [
        { ...latest("api", true), checked_at_ms: TICK },
        { ...latest("api", false), checked_at_ms: TICK - 60_000 },
      ],
    );
    const api = out.components.find((c) => c.component === "api")!;
    expect(api.current_ok).toBe(true);
    expect(api.checked_at).toBe(new Date(TICK).toISOString());
  });

  it("treats a null or missing timestamp as unusable rather than as epoch zero", () => {
    // Number(null) is 0, which would date an unmeasured tick to 1970 and make
    // it beat every real one in the newest-tick comparison.
    const out = buildSelfHealth(
      [],
      [
        {
          ...latest("api", true),
          checked_at_ms: null as unknown as number,
        },
      ],
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

  describe("component note (#8352)", () => {
    it("qualifies a stale publish with why, not a bare down", () => {
      const out = buildSelfHealth([], [latest("publish", false)]);
      const publish = out.components.find((c) => c.component === "publish")!;
      expect(publish.current_ok).toBe(false);
      expect(publish.note).toBe("publish is past its expected cadence");
      // And the site-wide verdict stays honest about it: a stale-only
      // publish is not a systems outage.
      expect(out.verdict).toBe("operational");
    });

    it("leaves note null for a healthy publish", () => {
      const out = buildSelfHealth([], [latest("publish", true)]);
      expect(
        out.components.find((c) => c.component === "publish")!.note,
      ).toBeNull();
    });

    it("never notes api or site -- their bare down already says everything", () => {
      const out = buildSelfHealth(
        [],
        [latest("api", false), latest("site", false)],
      );
      expect(
        out.components.find((c) => c.component === "api")!.note,
      ).toBeNull();
      expect(
        out.components.find((c) => c.component === "site")!.note,
      ).toBeNull();
    });

    it("leaves note null for an unmeasured publish", () => {
      const out = buildSelfHealth([], []);
      expect(
        out.components.find((c) => c.component === "publish")!.note,
      ).toBeNull();
    });
  });
});

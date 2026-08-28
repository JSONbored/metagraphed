import { describe, expect, it } from "vitest";
import {
  healthFacts,
  humaniseDuration,
  incidentRows,
  selfComponents,
  subnetHealthRows,
  trendPoints,
} from "./health-logic";

const T = 1_787_470_213_289;

const surfaces = [
  {
    netuid: 4,
    surface_id: "sn-4-targon-healthz-api",
    incidents: [
      { started_at: T, ended_at: T + 16_200_005, duration_ms: 16_200_005, failed_samples: 18 },
      { started_at: T - 86_400_000, ended_at: null, duration_ms: null, failed_samples: 3 },
    ],
  },
  {
    netuid: 18,
    surface_id: "sn-18-other",
    incidents: [{ started_at: T + 1000, ended_at: T + 2000, duration_ms: 1000, failed_samples: 2 }],
  },
  { netuid: 99, surface_id: "sn-99-none", incidents: [] },
];

describe("incidentRows", () => {
  it("is one row per INCIDENT, not per surface", () => {
    // A surface with three separate outages is three answers to "what is
    // broken"; grouping them would be an answer to a different question.
    expect(incidentRows(surfaces)).toHaveLength(3);
  });

  it("puts the open ones first, then newest", () => {
    const rows = incidentRows(surfaces);
    expect(rows[0]!.open).toBe(true);
    expect(rows.slice(1).every((row) => !row.open)).toBe(true);
    expect(rows[1]!.startedAt! > rows[2]!.startedAt!).toBe(true);
  });

  it("treats a null ended_at as still open", () => {
    expect(incidentRows(surfaces).filter((row) => row.open)).toHaveLength(1);
  });

  it("renders epoch millis as ISO so the time cell can format them", () => {
    expect(incidentRows(surfaces)[1]!.startedAt).toBe(new Date(T + 1000).toISOString());
  });

  it("skips a surface with no incidents rather than emitting an empty row", () => {
    expect(incidentRows(surfaces).some((row) => row.surfaceId === "sn-99-none")).toBe(false);
  });

  it("is empty for nothing", () => {
    expect(incidentRows(null)).toEqual([]);
    expect(incidentRows(undefined)).toEqual([]);
  });
});

describe("humaniseDuration", () => {
  it("never prints a raw millisecond count", () => {
    expect(humaniseDuration(45_000)).toBe("45s");
    expect(humaniseDuration(16_200_005)).toBe("4h 30m");
    expect(humaniseDuration(90 * 60 * 1000)).toBe("1h 30m");
    expect(humaniseDuration(30 * 60 * 1000)).toBe("30m");
    expect(humaniseDuration(50 * 60 * 60 * 1000)).toBe("2d 2h");
  });

  it("is an em-dash for an absent or impossible duration", () => {
    expect(humaniseDuration(null)).toBe("—");
    expect(humaniseDuration(undefined)).toBe("—");
    expect(humaniseDuration(-1)).toBe("—");
    expect(humaniseDuration(Number.NaN)).toBe("—");
  });
});

const subnets = [
  {
    netuid: 0,
    name: "root",
    status: "ok",
    surface_count: 8,
    ok_count: 8,
    degraded_count: 0,
    failed_count: 0,
    last_checked: "t",
  },
  {
    netuid: 4,
    name: "targon",
    status: "degraded",
    surface_count: 5,
    ok_count: 3,
    degraded_count: 1,
    failed_count: 1,
  },
  { netuid: 77, name: "unprobed", status: "unknown", surface_count: 0 },
];
const trend = [
  { netuid: 0, uptime_ratio: 0.9987 },
  { netuid: 4, uptime_ratio: 0.412 },
];

describe("subnetHealthRows", () => {
  it("joins the window's uptime ratio as a percentage", () => {
    const rows = subnetHealthRows(subnets, trend);
    expect(rows.find((r) => r.netuid === 0)?.uptimePct).toBe(99.9);
    expect(rows.find((r) => r.netuid === 4)?.uptimePct).toBe(41.2);
  });

  it("sorts worst first", () => {
    expect(subnetHealthRows(subnets, trend).map((r) => r.netuid)).toEqual([4, 0, 77]);
  });

  it("sorts an UNMEASURED subnet last, never beside the broken ones", () => {
    // `null` is "we have not measured this". Ordering it with the genuinely
    // broken would put the unknown at the top of a page whose job is naming
    // what is broken.
    const rows = subnetHealthRows(subnets, trend);
    expect(rows.at(-1)).toMatchObject({ netuid: 77, uptimePct: null });
  });

  it("names a subnet with no name by its netuid", () => {
    expect(subnetHealthRows([{ netuid: 12 }], [])[0]!.name).toBe("sn-12");
  });

  it("is empty for nothing", () => {
    expect(subnetHealthRows(null, null)).toEqual([]);
  });
});

describe("trendPoints", () => {
  it("turns ratios into percentages, oldest first", () => {
    expect(
      trendPoints([
        { date: "2026-08-19", uptime_ratio: 0.87 },
        { date: "2026-08-17", uptime_ratio: 1 },
      ]),
    ).toEqual([
      { t: Date.parse("2026-08-17T00:00:00Z"), v: 100 },
      { t: Date.parse("2026-08-19T00:00:00Z"), v: 87 },
    ]);
  });

  it("drops a day whose date does not parse rather than plotting NaN", () => {
    expect(trendPoints([{ date: "not-a-date", uptime_ratio: 1 }])).toEqual([]);
  });

  it("is empty for nothing", () => {
    expect(trendPoints(null)).toEqual([]);
  });
});

describe("selfComponents", () => {
  const components = [
    {
      component: "api",
      current_ok: true,
      latency_ms: 154,
      days: [
        { day: "2026-08-08", uptime_ratio: 0.57 },
        { day: "2026-08-09", uptime_ratio: 1 },
      ],
    },
    { component: "publish", current_ok: false, days: [] },
  ];

  it("averages over the days a component REPORTS, not over an assumed 90", () => {
    // A component measured for a week must not read as 8% available because
    // the other 83 days are missing.
    expect(selfComponents(components)[0]!.uptimePct).toBe(78.5);
  });

  it("is null, not zero, when a component reports no days at all", () => {
    expect(selfComponents(components)[1]!.uptimePct).toBeNull();
  });

  it("carries the day series as sorted percentage points", () => {
    expect(selfComponents(components)[0]!.points.map((p) => p.v)).toEqual([57, 100]);
  });

  it("keeps current_ok false distinct from unknown", () => {
    expect(selfComponents(components)[1]!.currentOk).toBe(false);
    expect(selfComponents([{ component: "x" }])[0]!.currentOk).toBeNull();
  });

  it("is empty for nothing", () => {
    expect(selfComponents(null)).toEqual([]);
  });
});

const fmt = { count: (n: number) => String(n) };

describe("healthFacts", () => {
  it("states the three probe outcomes, the open incidents and the self verdict", () => {
    expect(
      healthFacts(
        { surface_count: 621, status_counts: { ok: 523, degraded: 91, failed: 7, unknown: 0 } },
        4,
        "operational",
        fmt,
      ).map((f) => [f.key, f.value]),
    ).toEqual([
      ["failed", "7"],
      ["degraded", "91"],
      ["ok", "523"],
      ["probed", "621"],
      ["incidents", "4"],
      ["self", "operational"],
    ]);
    expect(
      healthFacts(
        { surface_count: 621, status_counts: { ok: 523, degraded: 91, failed: 7 } },
        0,
        "operational",
        fmt,
      ).slice(0, 4),
    ).toMatchObject([
      { key: "failed", tone: "bad" },
      { key: "degraded", tone: "warn" },
      { key: "ok", tone: "good" },
      { key: "probed" },
    ]);
    expect(
      healthFacts(
        { surface_count: 621, status_counts: { ok: 523, degraded: 91, failed: 7 } },
        4,
        "operational",
        fmt,
      ).find((fact) => fact.key === "self"),
    ).toMatchObject({ kind: "text" });
  });

  it("does not turn a pending incident read into a zero", () => {
    expect(
      healthFacts({ status_counts: { failed: 7 } }, null, null, fmt).find(
        (fact) => fact.key === "incidents",
      ),
    ).toMatchObject({ label: "Open records", value: "—", loading: true });
  });

  it("keeps a failed incident read unknown without presenting it as pending", () => {
    expect(
      healthFacts({ status_counts: { failed: 7 } }, null, null, fmt, "error").find(
        (fact) => fact.key === "incidents",
      ),
    ).toMatchObject({ label: "Open records", value: "—" });
    expect(
      healthFacts({ status_counts: { failed: 7 } }, null, null, fmt, "error").find(
        (fact) => fact.key === "incidents",
      )?.loading,
    ).toBeUndefined();
  });

  it("keeps a genuine zero, and reports zero open incidents rather than omitting it", () => {
    const facts = healthFacts({ status_counts: { failed: 0 } }, 0, null, fmt);
    expect(facts.find((f) => f.key === "failed")?.value).toBe("0");
    expect(facts.find((f) => f.key === "incidents")?.value).toBe("0");
  });

  it("omits the self verdict when self-health could not be read", () => {
    // "We cannot tell whether we are up" must not render as a blank chip that
    // looks like an answer.
    expect(healthFacts({ status_counts: {} }, 0, null, fmt).some((f) => f.key === "self")).toBe(
      false,
    );
  });

  it("is empty with no global block", () => {
    expect(healthFacts(null, 3, "operational", fmt)).toEqual([]);
  });
});

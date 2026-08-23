import { describe, expect, it } from "vitest";
import type { Endpoint, EndpointIncident, RpcPool } from "@/lib/metagraphed/types";
import {
  endpointFacts,
  endpointRows,
  facet,
  filterEndpoints,
  incidentRows,
  latencyRails,
  median,
  poolRows,
} from "./endpoints-logic";

const raw: Endpoint[] = [
  {
    id: "e1",
    provider: "opentensor",
    kind: "subtensor-rpc",
    url: "https://rpc.example",
    netuid: 0,
    subnet_name: "root",
    status: "ok",
    latency_ms: 2148,
    last_checked: "2026-08-23T10:45:13.288Z",
    last_ok: "2026-08-23T10:45:13.288Z",
    archive_support: true,
    pool_eligible: true,
    auth_required: false,
  },
  {
    id: "e2",
    operator: "targon",
    kind: "subnet-api",
    url: "https://targon.example",
    netuid: 4,
    status: "failed",
    latency_ms: undefined,
    observed_at: "2026-08-23T08:01:48.647Z",
    archive_support: false,
    pool_eligible: false,
    auth_required: true,
  },
  { id: "e3", provider: "chutes", kind: "subnet-api", status: "unknown", latency_ms: 0 },
  { id: "e4", provider: "affine", kind: "openapi", status: "degraded", latency_ms: 900 },
];

describe("endpointRows", () => {
  it("falls back to the operator when there is no provider", () => {
    expect(endpointRows(raw)[1]!.provider).toBe("targon");
  });

  it("falls back to observed_at when there is no last_checked", () => {
    expect(endpointRows(raw)[1]!.lastChecked).toBe("2026-08-23T08:01:48.647Z");
  });

  it("reads the booleans strictly, so a missing flag is false and not undefined", () => {
    const [, , third] = endpointRows(raw);
    expect(third).toMatchObject({ archive: false, poolEligible: false, authRequired: false });
  });

  it("is empty for a missing payload", () => {
    expect(endpointRows(undefined)).toEqual([]);
    expect(endpointRows(null)).toEqual([]);
  });
});

describe("median", () => {
  it("is the middle value on an odd count", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("averages the pair on an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("is null for nothing", () => {
    expect(median([])).toBeNull();
  });
});

const pools: RpcPool[] = [
  {
    id: "finney-rpc",
    kind: "subtensor-rpc",
    endpoint_count: 5,
    eligible_count: 4,
    best_endpoint_id: "opentensor-archive-rpc",
    endpoints: [
      { latency_ms: 2029, archive_support: true, pool_eligible: true },
      { latency_ms: 900, archive_support: false, pool_eligible: true },
      { latency_ms: 30_000, archive_support: false, pool_eligible: false },
    ],
  },
  { id: "empty-pool", kind: "subtensor-wss", endpoint_count: 0, eligible_count: 0, endpoints: [] },
];

describe("poolRows", () => {
  it("reports readiness as eligible over members", () => {
    // Readiness, not health: a member can be up and still be ineligible, and
    // what a caller needs is how many members it can be routed to.
    expect(poolRows(pools)[0]).toMatchObject({ members: 5, eligible: 4, readiness: 80 });
  });

  it("takes the MEDIAN latency, so one timeout does not describe the pool", () => {
    // The mean of 2029, 900 and 30000 is 10,976 ms — a number describing none
    // of the three.
    expect(poolRows(pools)[0]!.p50).toBe(2029);
  });

  it("counts archive members", () => {
    expect(poolRows(pools)[0]!.archive).toBe(1);
  });

  it("does not divide by zero on an empty pool", () => {
    const empty = poolRows(pools).find((p) => p.id === "empty-pool");
    expect(empty).toMatchObject({ readiness: 0, p50: null });
  });

  it("sorts by readiness, most ready first", () => {
    expect(poolRows(pools).map((p) => p.id)).toEqual(["finney-rpc", "empty-pool"]);
  });

  it("is empty for a missing payload", () => {
    expect(poolRows(undefined)).toEqual([]);
  });
});

describe("latencyRails", () => {
  const rows = endpointRows(raw);

  it("never ranks an unmeasured endpoint", () => {
    // `latency_ms: null` means unmeasured and 0 means the same in practice;
    // ranking either as 0 ms would put every dead endpoint atop "fastest".
    expect(latencyRails(rows, "fastest").map((r) => r.key)).toEqual(["affine", "opentensor"]);
  });

  it("puts the slowest first in the slowest view", () => {
    expect(latencyRails(rows, "slowest").map((r) => r.value)).toEqual([2148, 900]);
  });

  it("narrows to archive-capable endpoints in the archive view", () => {
    expect(latencyRails(rows, "archive").map((r) => r.key)).toEqual(["opentensor"]);
  });

  it("labels a rail provider · kind and links a subnet endpoint", () => {
    const [first] = latencyRails(rows, "slowest");
    expect(first!.label).toBe("opentensor · subtensor-rpc");
    expect(first!.href).toBe("/subnets/0");
  });

  it("honours the limit and survives an empty set", () => {
    expect(latencyRails(rows, "slowest", 1)).toHaveLength(1);
    expect(latencyRails([], "slowest")).toEqual([]);
  });
});

describe("incidentRows", () => {
  it("reads OPEN from ended_at, never from `state`", () => {
    // `normalizeIncident` rewrites the API's lifecycle `state` (active /
    // resolved) into a HEALTH state (down / warn / unknown) before this sees
    // it, so `state === "active"` matches nothing and the page reported 0 open
    // incidents against a feed of 131.
    const [open, closed] = incidentRows([
      { id: "i1", provider: "targon", severity: "critical", state: "down", ended_at: null },
      { id: "i2", provider: "affine", state: "warn", ended_at: "2026-08-23T09:00:00.000Z" },
    ] as unknown[] as EndpointIncident[]);
    expect(open).toMatchObject({ open: true, health: "down", severity: "critical" });
    expect(closed).toMatchObject({ open: false, health: "warn" });
  });

  it("takes started_at when the normalizer has already renamed detected_at", () => {
    expect(
      incidentRows([{ id: "i3", started_at: "2026-08-23T08:00:00.000Z" }] as EndpointIncident[])[0]!
        .detectedAt,
    ).toBe("2026-08-23T08:00:00.000Z");
    expect(
      incidentRows([
        { id: "i4", detected_at: "2026-08-23T07:00:00.000Z" },
      ] as EndpointIncident[])[0]!.detectedAt,
    ).toBe("2026-08-23T07:00:00.000Z");
  });

  it("names the surface, so two incidents on one provider are two rows", () => {
    // Without it, three concurrent opentensor RPC incidents rendered as three
    // byte-identical lines: same provider, kind, subnet, reason and severity.
    const rows = incidentRows([
      {
        id: "i7",
        provider: "opentensor",
        kind: "subtensor-rpc",
        surface_id: "opentensor-lite-rpc",
      },
      {
        id: "i8",
        provider: "opentensor",
        kind: "subtensor-rpc",
        surface_id: "opentensor-finney-rpc",
      },
    ] as unknown[] as EndpointIncident[]);
    expect(rows.map((row) => row.surface)).toEqual([
      "opentensor-lite-rpc",
      "opentensor-finney-rpc",
    ]);
    expect(new Set(rows.map((row) => row.surface)).size).toBe(rows.length);
  });

  it("falls back through surface_key and the endpoint id for the surface", () => {
    expect(
      incidentRows([{ id: "i9", surface_key: "srf-2d33" }] as unknown[] as EndpointIncident[])[0]!
        .surface,
    ).toBe("srf-2d33");
    expect(
      incidentRows([{ id: "i10", endpoint_id: "endpoint-srf-2d33" }] as EndpointIncident[])[0]!
        .surface,
    ).toBe("endpoint-srf-2d33");
    expect(incidentRows([{ id: "i11" }] as EndpointIncident[])[0]!.surface).toBeNull();
  });

  it("falls back through message, reason and classification", () => {
    expect(
      incidentRows([{ id: "i5", classification: "dead" }] as EndpointIncident[])[0]!.reason,
    ).toBe("dead");
    expect(
      incidentRows([{ id: "i6", message: "no route to host" }] as EndpointIncident[])[0]!.reason,
    ).toBe("no route to host");
  });

  it("is empty for a missing payload", () => {
    expect(incidentRows(null)).toEqual([]);
  });
});

const fmt = { count: (n: number) => String(n) };

describe("endpointFacts", () => {
  it("computes the healthy share over what is PROBED, not over the catalogue", () => {
    // by_status counts 2,770 unknown — 82% of the fleet the prober does not
    // watch. 507/3391 would report 15% healthy for a fleet that is 82% healthy
    // where it is measured: a claim about coverage dressed as one about health.
    const facts = endpointFacts(
      {
        endpoint_count: 3391,
        monitored_count: 1863,
        by_status: { ok: 507, unknown: 2770, degraded: 107, failed: 7 },
      },
      5,
      131,
      fmt,
    );
    const healthy = facts.find((f) => f.key === "healthy");
    expect(healthy?.value).toBe("82%");
    expect(healthy?.label).toBe("healthy of 621 probed");
  });

  it("reports the pools, the degraded and the open incidents", () => {
    const facts = endpointFacts({ by_status: { ok: 1, degraded: 2 } }, 5, 131, fmt);
    expect(facts.find((f) => f.key === "pools")?.value).toBe("5");
    expect(facts.find((f) => f.key === "degraded")?.value).toBe("2");
    expect(facts.find((f) => f.key === "incidents")?.value).toBe("131");
  });

  it("omits the healthy share when nothing was probed", () => {
    expect(endpointFacts({ endpoint_count: 10, by_status: { unknown: 10 } }, 0, null, fmt)).toEqual(
      [{ key: "tracked", label: "tracked", value: "10" }],
    );
  });

  it("is empty with no summary", () => {
    expect(endpointFacts(null, 3, 1, fmt)).toEqual([]);
  });
});

describe("filterEndpoints", () => {
  const rows = endpointRows(raw);
  const none = { q: "", status: "", kind: "", provider: "" };

  it("`monitored` means anything the prober has a reading for", () => {
    // The honest default for this table: a directory whose first 2,770 rows
    // all read "unknown" answers "is this endpoint up" with a shrug.
    expect(filterEndpoints(rows, { ...none, status: "monitored" }).map((r) => r.id)).toEqual([
      "e1",
      "e2",
      "e4",
    ]);
  });

  it("matches an exact status otherwise", () => {
    expect(filterEndpoints(rows, { ...none, status: "unknown" }).map((r) => r.id)).toEqual(["e3"]);
  });

  it("filters by kind and provider", () => {
    expect(filterEndpoints(rows, { ...none, kind: "subnet-api" })).toHaveLength(2);
    expect(filterEndpoints(rows, { ...none, provider: "affine" })).toHaveLength(1);
  });

  it("searches provider, url, kind and subnet together", () => {
    expect(filterEndpoints(rows, { ...none, q: "TARGON" }).map((r) => r.id)).toEqual(["e2"]);
    expect(filterEndpoints(rows, { ...none, q: "root" }).map((r) => r.id)).toEqual(["e1"]);
  });

  it("returns everything with no filters", () => {
    expect(filterEndpoints(rows, none)).toHaveLength(4);
  });
});

describe("facet", () => {
  it("is the sorted distinct set", () => {
    expect(facet(endpointRows(raw), (row) => row.kind)).toEqual([
      "openapi",
      "subnet-api",
      "subtensor-rpc",
    ]);
  });
});

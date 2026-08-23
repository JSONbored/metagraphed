import { describe, expect, it } from "vitest";
import type { Endpoint, Provider, SourceHealthProvider, Surface } from "@/lib/metagraphed/types";
import {
  endpointRails,
  facet,
  filterProviders,
  hostOf,
  initials,
  providerDetailFacts,
  providerFacts,
  providerLeaders,
  providerRows,
  providerSurfaces,
} from "./providers-logic";

const providers = [
  {
    slug: "opentensor",
    name: "Opentensor",
    kind: "infra",
    authority: "official",
    website: "https://bittensor.com",
    netuids: [0, 1],
    endpoints_count: 12,
    surfaces_count: 12,
    generated_at: "2026-08-23T07:49:52.533Z",
  },
  {
    slug: "404-gen",
    name: "404-GEN",
    kind: "subnet-team",
    authority: "community",
    netuids: [17],
    endpoints_count: 8,
  },
  { slug: "ghost", name: "Ghost", authority: "registry-observed", endpoints_count: 0 },
] as unknown as Provider[];

const health = [
  { id: "opentensor", status: "ok" },
  { id: "404-gen", status: "degraded" },
] as unknown as SourceHealthProvider[];

describe("providerRows", () => {
  it("joins source health by slug", () => {
    const rows = providerRows(providers, health);
    expect(rows.map((r) => r.sourceStatus)).toEqual(["ok", "degraded", null]);
  });

  it("gives a provider with no health row null, never the previous row's status", () => {
    // A `Map` miss returning the last value would report Ghost as degraded
    // because 404-GEN happens to precede it.
    expect(providerRows(providers, health)[2]!.sourceStatus).toBeNull();
  });

  it("keeps the netuid list as numbers only", () => {
    const rows = providerRows(
      [{ slug: "x", netuids: [1, "2", null, 3] }] as unknown as Provider[],
      [],
    );
    expect(rows[0]!.netuids).toEqual([1, 3]);
  });

  it("falls back from name to slug", () => {
    expect(providerRows([{ slug: "bare" }] as unknown as Provider[], [])[0]!.name).toBe("bare");
  });

  it("is empty for nothing", () => {
    expect(providerRows(null, null)).toEqual([]);
  });
});

const fmt = { count: (n: number) => String(n) };

describe("providerFacts", () => {
  it("counts official AND provider-claimed as first-party, with a share", () => {
    const rows = providerRows(providers, health);
    const claimed = providerFacts(rows, null, fmt).find((f) => f.key === "claimed");
    expect(claimed?.value).toBe("1 (33%)");
  });

  it("prefers the health summary's endpoint count over the row sum", () => {
    const rows = providerRows(providers, health);
    expect(
      providerFacts(rows, { endpoint_count: 3391, status_counts: {} }, fmt).find(
        (f) => f.key === "endpoints",
      )?.value,
    ).toBe("3391");
    expect(providerFacts(rows, null, fmt).find((f) => f.key === "endpoints")?.value).toBe("20");
  });

  it("reports resolving sources as a ratio of the whole", () => {
    const rows = providerRows(providers, health);
    expect(
      providerFacts(rows, { status_counts: { ok: 116, degraded: 1, unknown: 21 } }, fmt).find(
        (f) => f.key === "sources",
      )?.value,
    ).toBe("116/138");
  });

  it("is empty for no providers", () => {
    expect(providerFacts([], null, fmt)).toEqual([]);
  });
});

describe("providerLeaders", () => {
  it("ranks by endpoints and drops the ones serving none", () => {
    const leaders = providerLeaders(providerRows(providers, health));
    expect(leaders.map((l) => l.key)).toEqual(["opentensor", "404-gen"]);
  });

  it("carries no delta — there is no previous period to compare against", () => {
    // `LeaderCards` draws a delta as period-over-period change, and
    // /api/v1/providers is a snapshot. A delta from anything else would look
    // like growth and not be.
    expect(providerLeaders(providerRows(providers, health)).every((l) => !("delta" in l))).toBe(
      true,
    );
  });

  it("honours the limit", () => {
    expect(providerLeaders(providerRows(providers, health), 1)).toHaveLength(1);
  });
});

describe("initials", () => {
  it("takes the first letter of the first two words", () => {
    expect(initials("Open Tensor Foundation")).toBe("OT");
  });

  it("splits on dots, dashes and underscores too", () => {
    expect(initials("404-gen")).toBe("4G");
    expect(initials("macro.cosmos")).toBe("MC");
  });

  it("takes two letters from a single word", () => {
    expect(initials("Chutes")).toBe("CH");
  });

  it("never returns an empty string", () => {
    expect(initials("   ")).toBe("?");
    expect(initials("")).toBe("?");
  });
});

describe("filterProviders", () => {
  const rows = providerRows(providers, health);
  const none = { q: "", kind: "", authority: "" };

  it("filters by kind and authority", () => {
    expect(filterProviders(rows, { ...none, kind: "infra" }).map((r) => r.slug)).toEqual([
      "opentensor",
    ]);
    expect(filterProviders(rows, { ...none, authority: "community" })).toHaveLength(1);
  });

  it("searches name, slug and host together", () => {
    expect(filterProviders(rows, { ...none, q: "BITTENSOR.COM" }).map((r) => r.slug)).toEqual([
      "opentensor",
    ]);
    expect(filterProviders(rows, { ...none, q: "404" }).map((r) => r.slug)).toEqual(["404-gen"]);
  });

  it("returns everything with no filters", () => {
    expect(filterProviders(rows, none)).toHaveLength(3);
  });
});

describe("hostOf", () => {
  it("is the host of a URL", () => {
    expect(hostOf("https://api.example.com/v1/thing")).toBe("api.example.com");
  });

  it("degrades gracefully on something that is not a URL", () => {
    // Never throws: a malformed `url` in one row must not blank the rail.
    expect(hostOf("api.example.com/v1")).toBe("api.example.com");
    expect(hostOf("not a url")).toBe("not a url");
  });

  it("is null for nothing", () => {
    expect(hostOf(null)).toBeNull();
    expect(hostOf("")).toBeNull();
  });
});

const endpoints = [
  {
    id: "a",
    kind: "subtensor-rpc",
    url: "https://rpc.example/x",
    latency_ms: 2148,
    status: "ok",
    last_ok: "t",
  },
  { id: "b", kind: "docs", url: "https://docs.example", latency_ms: 300, status: "ok" },
  { id: "c", kind: "website", url: "https://x.example", latency_ms: undefined, status: "unknown" },
] as unknown as Endpoint[];

describe("endpointRails", () => {
  it("ranks slowest first and never ranks an unmeasured endpoint", () => {
    expect(endpointRails(endpoints).map((r) => r.key)).toEqual(["a", "b"]);
  });

  it("labels kind · host", () => {
    expect(endpointRails(endpoints)[0]!.label).toBe("subtensor-rpc · rpc.example");
  });

  it("says never rather than blank for an endpoint that has never answered", () => {
    expect(endpointRails(endpoints)[1]!.detail.find((d) => d.key === "probe")?.value).toBe("never");
  });

  it("honours the limit and survives nothing", () => {
    expect(endpointRails(endpoints, 1)).toHaveLength(1);
    expect(endpointRails(null)).toEqual([]);
  });
});

describe("providerDetailFacts", () => {
  it("computes the ok share over what was PROBED, excluding unknown", () => {
    const facts = providerDetailFacts(
      { name: "Opentensor", authority: "official" } as Provider,
      { endpoint_count: 12, by_status: { ok: 9, degraded: 3, unknown: 40 } },
      12,
      fmt,
    );
    const healthy = facts.find((f) => f.key === "healthy");
    expect(healthy?.value).toBe("75%");
    expect(healthy?.label).toBe("ok of 12 probed");
  });

  it("omits the share when nothing carries a status", () => {
    expect(
      providerDetailFacts({ name: "x" } as Provider, { by_status: { unknown: 5 } }, 0, fmt).some(
        (f) => f.key === "healthy",
      ),
    ).toBe(false);
  });

  it("is empty for no provider", () => {
    expect(providerDetailFacts(null, null, 0, fmt)).toEqual([]);
  });
});

describe("providerSurfaces", () => {
  it("orders by subnet, then name, and does not mutate its input", () => {
    const input = [
      { id: "b", netuid: 3, name: "Zeta" },
      { id: "a", netuid: 1, name: "Alpha" },
      { id: "c", netuid: 3, name: "Alpha" },
    ] as unknown as Surface[];
    const copy = [...input];
    expect(providerSurfaces(input).map((s) => s.id)).toEqual(["a", "c", "b"]);
    expect(input).toEqual(copy);
  });

  it("is empty for nothing", () => {
    expect(providerSurfaces(undefined)).toEqual([]);
  });
});

describe("facet", () => {
  it("is the sorted distinct set", () => {
    expect(facet(providerRows(providers, health), (r) => r.kind)).toEqual(["infra", "subnet-team"]);
  });
});

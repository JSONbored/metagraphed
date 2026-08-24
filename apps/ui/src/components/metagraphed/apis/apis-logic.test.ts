import { describe, expect, it } from "vitest";
import type { SchemaInfo, Surface } from "@/lib/metagraphed/types";
import {
  apisNav,
  catalogFacts,
  driftRails,
  facet,
  kindSegments,
  schemaFacts,
  schemaRows,
  schemaSummary,
  shortHash,
} from "./apis-logic";

describe("apisNav", () => {
  it("marks exactly the current route", () => {
    const nav = apisNav("/apis/schemas");
    expect(nav.filter((item) => item.current).map((item) => item.id)).toEqual(["schemas"]);
  });

  it("treats a trailing slash as the same route", () => {
    expect(apisNav("/apis/providers/").find((i) => i.current)?.id).toBe("providers");
  });

  it("lights the catalog on bare /apis", () => {
    expect(apisNav("/apis").find((i) => i.current)?.id).toBe("apis");
    expect(apisNav("/").find((i) => i.current)).toBeUndefined();
  });
});

const surfaces = [
  { id: "a", kind: "docs", provider: "opentensor", netuid: 0, name: "Docs" },
  { id: "b", kind: "openapi", provider: "macrocosmos", netuid: 1, name: "Apex" },
  { id: "c", kind: "docs", provider: "macrocosmos", netuid: 1, name: "Guide" },
  { id: "d", kind: "  ", provider: null, netuid: 2, name: "Blank" },
] as unknown as Surface[];

describe("kindSegments", () => {
  it("counts by kind, largest first", () => {
    expect(kindSegments(surfaces)).toEqual([
      { key: "docs", label: "docs", value: 2 },
      { key: "openapi", label: "openapi", value: 1 },
    ]);
  });

  it("breaks a tie on the name so the order does not flicker", () => {
    const tied = [{ kind: "zeta" }, { kind: "alpha" }] as unknown as Surface[];
    expect(kindSegments(tied).map((s) => s.key)).toEqual(["alpha", "zeta"]);
  });

  it("is empty for no surfaces", () => {
    expect(kindSegments([])).toEqual([]);
  });
});

describe("facet", () => {
  it("is the sorted distinct set, trimmed and non-empty", () => {
    expect(facet(surfaces, (s) => s.kind)).toEqual(["docs", "openapi"]);
    expect(facet(surfaces, (s) => s.provider)).toEqual(["macrocosmos", "opentensor"]);
  });
});

const fmt = { count: (n: number) => String(n) };

describe("catalogFacts", () => {
  it("says PROBED, never invents an up count", () => {
    // /api/v1/coverage publishes how many surfaces the prober reaches, not how
    // many answered. A page that says "509/616 up" without a source for the
    // numerator is inventing it.
    const facts = catalogFacts(
      {
        surface_count: 3391,
        chain_subnet_count: 129,
        probed_surface_count: 1863,
        official_surface_count: 440,
      },
      9,
      fmt,
    );
    expect(facts.map((f) => f.label)).toEqual([
      "Surfaces",
      "Across subnets",
      "Kinds",
      "Probed",
      "First-party",
    ]);
    expect(facts.find((f) => f.key === "probed")?.value).toBe("1863");
    expect(facts.some((f) => f.label.includes("up"))).toBe(false);
  });

  it("omits what the response does not carry, and is empty with no response", () => {
    expect(catalogFacts({ surface_count: 5 }, 0, fmt).map((f) => f.key)).toEqual(["surfaces"]);
    expect(catalogFacts(null, 3, fmt)).toEqual([]);
  });
});

const raw: SchemaInfo[] = [
  {
    id: "s1",
    surface_id: "s1",
    netuid: 9,
    subnet_slug: "nine",
    status: "captured",
    drift_status: "changed",
    hash: "aaaaaaaabbbbbbbb",
    previous_hash: "ccccccccdddddddd",
    schema_url: "https://nine.example/openapi.json",
    snapshot: {
      title: "FastAPI",
      path_count: 35,
      component_schema_count: 12,
      observed_at: "2026-08-02T07:31:05.148Z",
    },
  },
  {
    id: "s2",
    surface_id: "s2",
    netuid: 43,
    subnet_slug: "kg",
    status: "captured",
    drift_status: "new",
    hash: "eeeeeeeeffffffff",
    // `normalizeSchema` maps the API's `null` to undefined, so a
    // post-normalization row never carries null here.
    previous_hash: undefined,
    snapshot: { title: "SN43 Knowledge Graph API", path_count: 30, component_schema_count: 4 },
  },
  {
    id: "s3",
    surface_id: "s3",
    netuid: 70,
    status: "not-found",
    drift_status: "not-captured",
    hash: undefined,
    previous_hash: undefined,
    snapshot: null,
  },
  {
    id: "s4",
    surface_id: "s4",
    netuid: 1,
    subnet_slug: "apex",
    status: "captured",
    drift_status: "unchanged",
    snapshot: { title: "Apex", path_count: 90 },
  },
];

describe("schemaRows", () => {
  it("flattens the snapshot onto the row", () => {
    const [first] = schemaRows(raw);
    expect(first).toMatchObject({
      netuid: 9,
      subnet: "nine",
      title: "FastAPI",
      paths: 35,
      components: 12,
    });
  });

  it("names a row with no slug and no snapshot by its netuid", () => {
    expect(schemaRows(raw)[2]).toMatchObject({ subnet: "sn-70", title: "—", paths: null });
  });

  it("is empty for a missing or non-array payload", () => {
    expect(schemaRows(undefined)).toEqual([]);
    expect(schemaRows(null)).toEqual([]);
  });
});

describe("driftRails", () => {
  const rows = schemaRows(raw);

  it("shows only what moved, largest spec first", () => {
    expect(driftRails(rows).map((r) => r.label)).toEqual(["SN9 nine", "SN43 kg"]);
  });

  it("does not rank a failed capture — its magnitude is zero by definition", () => {
    // It stays visible in the table, which defaults to everything that is not
    // `unchanged`; seven empty rails under two full ones is a ranking of
    // nothing.
    expect(driftRails(rows).some((r) => r.label.includes("sn-70"))).toBe(false);
  });

  it("carries both hashes, short, with an em-dash for an absent one", () => {
    const [first, second] = driftRails(rows);
    expect(first!.detail.find((d) => d.key === "from")?.value).toBe("cccccccc…");
    expect(second!.detail.find((d) => d.key === "from")?.value).toBe("—");
  });

  it("never lists an unchanged schema", () => {
    expect(driftRails(rows).some((r) => r.label.includes("apex"))).toBe(false);
  });

  it("honours the limit and survives an empty set", () => {
    expect(driftRails(rows, 1)).toHaveLength(1);
    expect(driftRails([])).toEqual([]);
  });
});

describe("shortHash", () => {
  it("is the first eight characters", () => {
    expect(shortHash("0123456789abcdef")).toBe("01234567…");
  });

  it("is an em-dash for nothing", () => {
    expect(shortHash(null)).toBe("—");
    expect(shortHash(undefined)).toBe("—");
  });
});

describe("schemaFacts", () => {
  it("reports what moved as changed plus new, and what was never captured", () => {
    const facts = schemaFacts(
      {
        surface_count: 64,
        by_status: { captured: 57 },
        by_drift_status: { changed: 1, new: 1, "not-captured": 7, unchanged: 55 },
      },
      59,
      fmt,
    );
    expect(facts.find((f) => f.key === "moved")?.value).toBe("2");
    expect(facts.find((f) => f.key === "missing")?.value).toBe("7");
    expect(facts.find((f) => f.key === "subnets")?.value).toBe("59");
  });

  it("reports zero moved rather than omitting the fact", () => {
    // "Nothing changed" is the answer this page exists to give; leaving it out
    // would make a quiet week look like a page that failed to load.
    expect(schemaFacts({ by_drift_status: { unchanged: 64 } }, 0, fmt)).toEqual([
      { key: "moved", label: "Moved", value: "0" },
    ]);
  });

  it("is empty with no summary", () => {
    expect(schemaFacts(null, 5, fmt)).toEqual([]);
  });
});

describe("schemaSummary", () => {
  const rows = schemaRows(raw);

  it("counts both axes off the rows it is about to draw", () => {
    const summary = schemaSummary(rows);
    expect(summary.surface_count).toBe(4);
    expect(summary.by_drift_status).toEqual({
      changed: 1,
      new: 1,
      "not-captured": 1,
      unchanged: 1,
    });
    expect(summary.by_status).toEqual({ captured: 3, "not-found": 1 });
  });

  it("takes the newest capture time, ignoring rows that have none", () => {
    expect(schemaSummary(rows).observed_at).toBe("2026-08-02T07:31:05.148Z");
  });

  it("is a zeroed shape for no rows, not undefined", () => {
    expect(schemaSummary([])).toEqual({
      surface_count: 0,
      by_status: {},
      by_drift_status: {},
      observed_at: null,
    });
  });
});

import { describe, it, expect } from "vitest";

import { normalizeSubnet, normalizeSubnetProfile, normalizeGap, normalizeCompare } from "./queries";

// These tests lock the canonical-only reads after #1756 collapsed the redundant
// field-alias coalescing. They feed representative live-API payloads (the shapes
// served by /api/v1/subnets, /subnets/{n}/profile, /gaps, /compare as of the PR)
// plus the edge cases #226 (stringArrayFromUnknown) and #1757 (null timestamps)
// guard. A future API regression that drops a canonical field is caught here.

describe("normalizeSubnet", () => {
  // Mirrors a real /api/v1/subnets list row: the API serves the canonical
  // singular counts (surface_count / candidate_count / participant_count) and
  // canonical link names (website_url / source_repo / subnet_type), never the
  // *_count / website / repo / type aliases.
  const listRow = {
    netuid: 7,
    name: "Allways",
    native_name: "allways",
    subnet_type: "inference",
    participant_count: 256,
    surface_count: 23,
    candidate_count: 6,
    status: "active",
    logo_url: "https://cdn.example/allways.png",
    website_url: "https://all-ways.io/",
    source_repo: "https://github.com/entrius/allways",
    updated_at: "2026-06-24T18:44:00Z",
  };

  it("reads canonical singular counts into the alias output keys", () => {
    const out = normalizeSubnet(listRow);
    expect(out.participants).toBe(256);
    expect(out.surfaces_count).toBe(23);
    expect(out.candidates_count).toBe(6);
  });

  it("reads canonical website_url / source_repo into website / repo outputs", () => {
    const out = normalizeSubnet(listRow);
    expect(out.website).toBe("https://all-ways.io/");
    expect(out.repo).toBe("https://github.com/entrius/allways");
  });

  it("maps canonical subnet_type and logo_url onto the type / icon_url outputs", () => {
    const out = normalizeSubnet(listRow);
    expect(out.type).toBe("inference");
    expect(out.icon_url).toBe("https://cdn.example/allways.png");
  });

  it("prefers the curated name but falls back to the on-chain native_name", () => {
    expect(normalizeSubnet({ ...listRow, name: undefined }).name).toBe("allways");
    expect(normalizeSubnet(listRow).name).toBe("Allways");
  });

  it("defaults health to 'unknown' for an unprobed chain status", () => {
    expect(normalizeSubnet(listRow).health).toBe("unknown");
    expect(normalizeSubnet({ ...listRow, health: "ok" }).health).toBe("ok");
  });

  it("yields undefined for missing canonical fields rather than throwing", () => {
    const out = normalizeSubnet({ netuid: 99 });
    expect(out.participants).toBeUndefined();
    expect(out.surfaces_count).toBeUndefined();
    expect(out.candidates_count).toBeUndefined();
    expect(out.website).toBeUndefined();
    expect(out.repo).toBeUndefined();
    expect(out.health).toBe("unknown");
  });

  it("does NOT resurrect a value from a now-removed legacy alias", () => {
    // The collapse means only the canonical name is read. A payload carrying
    // *only* the old alias must normalize to undefined — proving the fallback
    // is gone and a future API that re-emits aliases would surface a bug.
    const out = normalizeSubnet({
      netuid: 7,
      participants: 256,
      surfaces_count: 23,
      candidates_count: 6,
      website: "https://legacy.example",
      repo: "https://github.com/legacy/repo",
      type: "inference",
    });
    expect(out.participants).toBeUndefined();
    expect(out.surfaces_count).toBeUndefined();
    expect(out.candidates_count).toBeUndefined();
    expect(out.website).toBeUndefined();
    expect(out.repo).toBeUndefined();
    expect(out.type).toBeUndefined();
  });

  it("passes non-object input straight through", () => {
    expect(normalizeSubnet(null as unknown)).toBeNull();
  });
});

describe("normalizeSubnetProfile", () => {
  // Mirrors /api/v1/subnets/{n}/profile: nested `profile` + `subnet` objects,
  // with primary_links carrying ONLY the canonical *_url / source_repo names.
  const profilePayload = {
    profile: {
      netuid: 7,
      name: "Allways",
      native_name: "allways",
      slug: "allways",
      subnet_type: "inference",
      completeness: { score: 100 },
      completeness_score: 100,
      surface_count: 23,
      candidate_count: 6,
      endpoint_count: 4,
      integration_readiness: 80,
      primary_links: {
        website_url: "https://all-ways.io/",
        docs_url: "https://docs.all-ways.io/how-it-works.html",
        source_repo: "https://github.com/entrius/allways",
        dashboard_url: "https://backprop.finance/dtao/subnets/7-allways",
      },
    },
    subnet: {
      netuid: 7,
      name: "Allways",
      participant_count: 256,
      surface_count: 23,
      candidate_count: 6,
      website_url: "https://all-ways.io/",
      docs_url: "https://docs.all-ways.io/how-it-works.html",
      source_repo: "https://github.com/entrius/allways",
      status: "active",
    },
    surfaces: [],
    endpoints: [],
    candidate_surfaces: [],
  };

  it("reads canonical *_url / source_repo links from primary_links", () => {
    const out = normalizeSubnetProfile(profilePayload, 7);
    expect(out.website).toBe("https://all-ways.io/");
    expect(out.docs).toBe("https://docs.all-ways.io/how-it-works.html");
    expect(out.repo).toBe("https://github.com/entrius/allways");
    expect(out.dashboard).toBe("https://backprop.finance/dtao/subnets/7-allways");
    expect(out.homepage).toBe("https://all-ways.io/");
    expect(out.primary_links).toEqual({
      website: "https://all-ways.io/",
      docs: "https://docs.all-ways.io/how-it-works.html",
      repo: "https://github.com/entrius/allways",
      dashboard: "https://backprop.finance/dtao/subnets/7-allways",
    });
  });

  it("falls back to the subnet object for links absent from primary_links", () => {
    const payload = {
      ...profilePayload,
      profile: { ...profilePayload.profile, primary_links: {} },
    };
    const out = normalizeSubnetProfile(payload, 7);
    // dashboard_url lives only on primary_links in the real payload, so it is
    // absent here; website/docs/repo still resolve via the subnet fallback.
    expect(out.website).toBe("https://all-ways.io/");
    expect(out.docs).toBe("https://docs.all-ways.io/how-it-works.html");
    expect(out.repo).toBe("https://github.com/entrius/allways");
    expect(out.dashboard).toBeUndefined();
  });

  it("reads the canonical participant_count into the participants output", () => {
    expect(normalizeSubnetProfile(profilePayload, 7).participants).toBe(256);
  });

  it("derives completeness ratio from the canonical completeness.score", () => {
    const out = normalizeSubnetProfile(profilePayload, 7);
    expect(out.completeness_score).toBe(100);
    expect(out.completeness).toBe(1);
  });

  it("falls back to the flat completeness_score when the nested object is absent", () => {
    const payload = {
      ...profilePayload,
      profile: { ...profilePayload.profile, completeness: undefined },
    };
    const out = normalizeSubnetProfile(payload, 7);
    expect(out.completeness_score).toBe(100);
    expect(out.completeness).toBe(1);
  });

  it("exposes canonical counts under both the canonical and alias output keys", () => {
    const out = normalizeSubnetProfile(profilePayload, 7);
    expect(out.surface_count).toBe(23);
    expect(out.surfaces_count).toBe(23);
    expect(out.candidate_count).toBe(6);
    expect(out.candidates_count).toBe(6);
  });

  it("uses the explicit netuid argument when the payload omits it", () => {
    expect(normalizeSubnetProfile({}, 42).netuid).toBe(42);
  });

  it("guards array fields against non-array values (#226)", () => {
    const payload = {
      profile: {
        ...profilePayload.profile,
        categories: "not-an-array",
        operational_interface_kinds: 7,
      },
      subnet: profilePayload.subnet,
    };
    const out = normalizeSubnetProfile(payload, 7);
    expect(out.categories).toEqual([]);
    expect(out.operational_interface_kinds).toEqual([]);
  });

  it("defaults embedded collections to empty arrays when absent", () => {
    const out = normalizeSubnetProfile({ profile: {}, subnet: {} }, 7);
    expect(out.surfaces).toEqual([]);
    expect(out.endpoints).toEqual([]);
    expect(out.candidate_surfaces).toEqual([]);
  });
});

describe("normalizeGap", () => {
  it("derives severity, title, and description from canonical gap fields", () => {
    const out = normalizeGap({
      netuid: 12,
      name: "Example",
      slug: "example",
      curation_level: "community",
      gaps: {
        missing_kinds: ["openapi", "subnet-api", "dashboard"],
        gap_notes: ["Publish an OpenAPI spec"],
      },
    });
    expect(out.id).toBe("example");
    expect(out.netuid).toBe(12);
    expect(out.category).toBe("community");
    expect(out.severity).toBe("high");
    expect(out.missing_kinds).toEqual(["openapi", "subnet-api", "dashboard"]);
    expect(out.gap_notes).toEqual(["Publish an OpenAPI spec"]);
    expect(out.suggested_action).toBe("Publish an OpenAPI spec");
    expect(out.description).toBe("Missing: openapi, subnet-api, dashboard");
    expect(out.title).toBe("Example — 3 missing surfaces");
  });

  it("synthesizes a name and id when only netuid is present", () => {
    const out = normalizeGap({ netuid: 5 });
    expect(out.id).toBe("gap-5");
    expect(out.title).toBe("SN5 — 0 missing surfaces");
    expect(out.description).toBeUndefined();
    expect(out.missing_kinds).toEqual([]);
  });

  it("uses singular 'surface' wording for a single missing kind", () => {
    const out = normalizeGap({ netuid: 9, name: "Solo", gaps: { missing_kinds: ["docs"] } });
    expect(out.title).toBe("Solo — 1 missing surface");
    expect(out.severity).toBe("low");
  });

  it("guards non-array missing_kinds / gap_notes (#226)", () => {
    const out = normalizeGap({ netuid: 3, gaps: { missing_kinds: "openapi", gap_notes: null } });
    expect(out.missing_kinds).toEqual([]);
    expect(out.gap_notes).toEqual([]);
  });
});

describe("normalizeCompare", () => {
  // Mirrors /api/v1/compare?netuids=…: the API emits canonical names throughout
  // (completeness_score, surface_count) with no alias coalescing.
  const comparePayload = {
    dimensions: ["structure", "economics", "health"],
    requested_netuids: [7, 8],
    observed_at: "2026-06-25T04:15:38.945Z",
    source: "registry+economics+live-cron-prober",
    subnets: [
      {
        netuid: 7,
        name: "Allways",
        slug: "allways",
        found: true,
        structure: { completeness_score: 100, surface_count: 23, operational_interface_count: 4 },
        economics: { emission_share: 0.002684, validator_count: 12, miner_count: 244 },
        health: { surface_count: 23, ok_count: 20, avg_latency_ms: 180 },
      },
    ],
  };

  it("reads canonical structure/economics/health from each compare row", () => {
    const out = normalizeCompare(comparePayload);
    expect(out.dimensions).toEqual(["structure", "economics", "health"]);
    expect(out.requested_netuids).toEqual([7, 8]);
    expect(out.subnets).toHaveLength(1);
    const row = out.subnets[0];
    expect(row.netuid).toBe(7);
    expect(row.found).toBe(true);
    expect(row.structure?.completeness_score).toBe(100);
    expect(row.structure?.surface_count).toBe(23);
    expect(row.economics?.emission_share).toBe(0.002684);
    expect(row.health?.ok_count).toBe(20);
  });

  it("drops rows without a numeric netuid and defaults missing collections", () => {
    const out = normalizeCompare({ subnets: [{ name: "no-netuid" }, { netuid: 1 }] });
    expect(out.subnets).toHaveLength(1);
    expect(out.subnets[0].netuid).toBe(1);
    expect(out.dimensions).toEqual([]);
    expect(out.requested_netuids).toEqual([]);
  });

  it("tolerates a non-object payload", () => {
    const out = normalizeCompare(null);
    expect(out.subnets).toEqual([]);
    expect(out.dimensions).toEqual([]);
  });
});

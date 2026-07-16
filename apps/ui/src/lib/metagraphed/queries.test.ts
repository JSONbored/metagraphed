import { describe, it, expect } from "vitest";

import {
  normalizeAccountHistory,
  normalizeSubnet,
  normalizeSubnetProfile,
  normalizeGap,
  normalizeCompare,
  normalizeSurfaceSla,
  flattenSurfaceIncidents,
  normalizeProvider,
  normalizeAccountEvent,
  normalizeExtrinsic,
  normalizeAgentCatalogDetail,
  getNextPageParam,
  normalizeSubnetGaps,
  validateNextCursor,
  normalizeFreshnessSources,
} from "./queries";

// These tests lock the canonical-only reads after #1756 collapsed the redundant
// field-alias coalescing. They feed representative live-API payloads (the shapes
// served by /api/v1/subnets, /subnets/{n}/profile, /gaps, /compare as of the PR)
// plus the edge cases #226 (stringArrayFromUnknown) and #1757 (null timestamps)
// guard. A future API regression that drops a canonical field is caught here.

describe("normalizeFreshnessSources", () => {
  const NOW = Date.parse("2026-07-15T00:00:00.000Z");

  it("excludes a 1970 placeholder timestamp from the freshness/staleness domain (#6021)", () => {
    const out = normalizeFreshnessSources(
      [
        { id: "placeholder", as_of: "1970-01-01T00:00:00.000Z" },
        { id: "fresh", as_of: "2026-07-14T00:00:00.000Z" },
      ],
      NOW,
    );
    // The placeholder must NOT feed a multi-decade age into the aggregates -- the
    // only usable source (1 day old) drives maxAge/avgAge, so both are 86400s.
    expect(out.maxAgeSeconds).toBe(86_400);
    expect(out.avgAgeSeconds).toBe(86_400);
    // And the placeholder is not counted stale via its (excluded) age.
    expect(out.staleCount).toBe(0);
    // The placeholder source still appears in the list, just with no last_seen.
    const placeholder = out.sources.find((s) => s.name === "placeholder");
    expect(placeholder?.last_seen).toBeUndefined();
    const fresh = out.sources.find((s) => s.name === "fresh");
    expect(fresh?.last_seen).toBe("2026-07-14T00:00:00.000Z");
  });

  it("still ages a genuinely stale (post-2000) source", () => {
    const out = normalizeFreshnessSources(
      [{ id: "old", as_of: "2026-07-01T00:00:00.000Z", stale_after_hours: 24 }],
      NOW,
    );
    expect(out.maxAgeSeconds).toBe(14 * 86_400);
    expect(out.staleCount).toBe(1);
  });
});

describe("normalizeAccountEvent", () => {
  it("normalizes primitive event fields before rendering", () => {
    const out = normalizeAccountEvent({
      block_number: "123",
      event_index: 4,
      event_kind: 99,
      hotkey: true,
      coldkey: "cold",
      netuid: "7",
      uid: "42",
      amount_tao: "1.5",
      observed_at: "2026-06-24T18:44:00Z",
    });

    expect(out).toMatchObject({
      block_number: 123,
      event_index: 4,
      event_kind: "99",
      hotkey: "true",
      coldkey: "cold",
      netuid: 7,
      uid: 42,
      amount_tao: 1.5,
      observed_at: "2026-06-24T18:44:00Z",
    });
  });

  it("drops malformed events with object-valued render fields", () => {
    expect(
      normalizeAccountEvent({
        block_number: 123,
        event_index: 0,
        event_kind: { object_child: true },
        hotkey: { not: "a string" },
      }),
    ).toBeNull();
  });
});

describe("normalizeExtrinsic", () => {
  it("caps events and call args from detail payloads", () => {
    const out = normalizeExtrinsic({
      block_number: 1,
      extrinsic_index: 2,
      extrinsic_hash: "0xabc",
      call_args: Array.from({ length: 80 }, (_, i) => ({ name: `arg_${i}`, value: i })),
      events: Array.from({ length: 120 }, (_, i) => ({
        block_number: i,
        event_index: i,
        event_kind: "Event",
      })),
    });

    expect(out?.call_args).toHaveLength(64);
    expect(out?.call_args_total).toBe(80);
    expect(out?.events).toHaveLength(100);
    expect(out?.events_total).toBe(120);
  });

  it("sanitizes deeply nested and circular call arg values before rendering", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: "too deep" } } } } } } } } };

    const out = normalizeExtrinsic({
      block_number: 1,
      extrinsic_index: 2,
      extrinsic_hash: "0xabc",
      call_args: [
        { name: "deep", value: deep },
        { name: "circular", value: circular },
      ],
    });

    expect(() => JSON.stringify(out?.call_args)).not.toThrow();
    expect(JSON.stringify(out?.call_args)).toContain("[Max depth exceeded]");
    expect(JSON.stringify(out?.call_args)).toContain("[Circular]");
  });
});

describe("normalizeAgentCatalogDetail", () => {
  it("drops backend-provided snippets from callable service payloads", () => {
    const out = normalizeAgentCatalogDetail(
      {
        services: [
          {
            kind: "subnet-api",
            capability: "query",
            base_url: "https://api.example/v1",
            snippets: {
              curl: "curl https://api.example/v1 && rm -rf ~",
              python: "print('owned')",
              typescript: "fetch('https://evil.example')",
            },
          },
        ],
      },
      7,
    );

    expect(out.services).toHaveLength(1);
    expect(out.services?.[0]?.base_url).toBe("https://api.example/v1");
    expect(Object.hasOwn(out.services?.[0] ?? {}, "snippets")).toBe(false);
  });
});

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

describe("normalizeAccountHistory", () => {
  it("reads the nested data.days payload from /accounts/{ss58}/history", () => {
    const out = normalizeAccountHistory(
      {
        ss58: "5Example",
        day_count: 2,
        limit: 180,
        offset: 0,
        days: [
          {
            day: "2026-06-25",
            netuid: 1,
            event_count: 7,
            event_kinds: ["StakeAdded", "StakeRemoved"],
            first_block: 100,
            last_block: 120,
          },
          {
            day: "2026-06-24",
            netuid: 7,
            event_count: 1,
            event_kinds: ["NeuronRegistered"],
            first_block: 90,
            last_block: 90,
          },
        ],
      },
      "5Fallback",
    );

    expect(out.ss58).toBe("5Example");
    expect(out.day_count).toBe(2);
    expect(out.limit).toBe(180);
    expect(out.offset).toBe(0);
    expect(out.days).toEqual([
      {
        day: "2026-06-25",
        netuid: 1,
        event_count: 7,
        event_kinds: ["StakeAdded", "StakeRemoved"],
        first_block: 100,
        last_block: 120,
      },
      {
        day: "2026-06-24",
        netuid: 7,
        event_count: 1,
        event_kinds: ["NeuronRegistered"],
        first_block: 90,
        last_block: 90,
      },
    ]);
  });

  it("returns a schema-stable zero for an empty history payload", () => {
    const out = normalizeAccountHistory({ days: [] }, "5Empty");
    expect(out.ss58).toBe("5Empty");
    expect(out.day_count).toBe(0);
    expect(out.limit).toBeNull();
    expect(out.offset).toBeNull();
    expect(out.days).toEqual([]);
  });

  it("filters malformed rows but keeps valid event_kinds arrays", () => {
    const out = normalizeAccountHistory(
      {
        days: [
          null,
          { event_count: 3 },
          {
            day: "2026-06-25",
            netuid: null,
            event_count: 2,
            event_kinds: ["StakeAdded", 7, false, null],
          },
        ],
      },
      "5Kinds",
    );

    expect(out.day_count).toBe(1);
    expect(out.days).toEqual([
      {
        day: "2026-06-25",
        netuid: null,
        event_count: 2,
        event_kinds: ["StakeAdded", "7", "false"],
        first_block: null,
        last_block: null,
      },
    ]);
  });

  it("caps oversized account history payloads before normalizing", () => {
    const out = normalizeAccountHistory(
      {
        days: Array.from({ length: 250 }, (_, index) => ({
          day: `2026-06-${String((index % 28) + 1).padStart(2, "0")}`,
          netuid: index,
          event_count: 1,
          event_kinds: Array.from({ length: 40 }, (__, kindIndex) => `Kind${kindIndex}`),
        })),
      },
      "5Capped",
    );

    expect(out.day_count).toBe(180);
    expect(out.days).toHaveLength(180);
    expect(out.days[0]?.event_kinds).toHaveLength(32);
    expect(out.days.at(-1)?.netuid).toBe(179);
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

  it("does not invent HealthState from chain lifecycle status (#5332)", () => {
    // Real profile payloads carry subnet.status = "active" (chain), not probe
    // health. Mapping that through statusToHealth used to pin the masthead
    // HealthPill on "unknown" while the incident strip correctly showed degraded.
    const out = normalizeSubnetProfile(profilePayload, 7);
    expect(out.health).toBeUndefined();
  });

  it("preserves probe health when the profile payload carries it (#5332)", () => {
    const payload = {
      ...profilePayload,
      subnet: { ...profilePayload.subnet, health: "degraded" },
    };
    expect(normalizeSubnetProfile(payload, 7).health).toBe("warn");
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

  it("maps served gap_severity vocab (critical→high, warning→medium, info→low)", () => {
    const high = normalizeGap({
      netuid: 1,
      gap_severity: "critical",
      gaps: { missing_kinds: ["docs"] },
    });
    const med = normalizeGap({
      netuid: 2,
      gap_severity: "warning",
      gaps: { missing_kinds: ["docs"] },
    });
    const low = normalizeGap({
      netuid: 3,
      gap_severity: "info",
      gaps: { missing_kinds: ["docs"] },
    });
    expect(high.severity).toBe("high");
    expect(med.severity).toBe("medium");
    expect(low.severity).toBe("low");
  });

  it("falls back to client derivation when gap_severity is absent", () => {
    // core>=1 + 3 missing → high
    const out = normalizeGap({
      netuid: 7,
      gaps: { missing_kinds: ["openapi", "docs", "dashboard"] },
    });
    expect(out.severity).toBe("high");
  });

  it("falls back for unrecognized or prototype gap_severity values", () => {
    const fallbackPayload = {
      netuid: 8,
      gaps: { missing_kinds: ["openapi", "docs", "dashboard"] },
    };

    expect(normalizeGap({ ...fallbackPayload, gap_severity: "unknown" }).severity).toBe("high");
    expect(normalizeGap({ ...fallbackPayload, gap_severity: "__proto__" }).severity).toBe("high");
    expect(normalizeGap({ ...fallbackPayload, gap_severity: "constructor" }).severity).toBe("high");
    expect(normalizeGap({ ...fallbackPayload, gap_severity: 123 }).severity).toBe("high");
  });

  it("threads gap_priority through to the returned Gap", () => {
    const out = normalizeGap({ netuid: 4, gap_priority: 42, gaps: { missing_kinds: ["docs"] } });
    expect(out.gap_priority).toBe(42);
  });

  it("omits gap_priority when absent or non-numeric", () => {
    const absent = normalizeGap({ netuid: 5, gaps: {} });
    const str = normalizeGap({ netuid: 6, gap_priority: "high", gaps: {} });
    expect(absent.gap_priority).toBeUndefined();
    expect(str.gap_priority).toBeUndefined();
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

describe("normalizeSurfaceSla / flattenSurfaceIncidents", () => {
  // A malformed incidents array (null / string / partial-object elements) used
  // to flow straight into flattenSurfaceIncidents, where reading `inc.started_at`
  // on a `null` element threw and crashed the entire subnet operational view
  // (~5 components). normalizeSurfaceSla now filters elements through the same
  // isPlainRecord guard every sibling normalizer uses.
  it("drops malformed incident elements through the isPlainRecord guard", () => {
    const sla = normalizeSurfaceSla({
      surface_id: "sfc-1",
      incidents: [null, "x", { started_at: 123 }],
    });
    expect(sla?.incidents).toEqual([{ started_at: 123 }]);
  });

  it("flattenSurfaceIncidents does not throw on a normalized malformed payload", () => {
    const sla = normalizeSurfaceSla({
      surface_id: "sfc-1",
      incidents: [null, "x", { started_at: 123 }],
    });
    const flat = flattenSurfaceIncidents(sla ? [sla] : []);
    expect(flat).toHaveLength(1);
    expect(flat[0].surface_id).toBe("sfc-1");
    expect(flat[0].started_at).toBe(new Date(123).toISOString());
    expect(flat[0].severity).toBe("high");
  });
});

describe("normalizeProvider", () => {
  // The detail normalizer used to spread `...inner` AFTER the computed fields,
  // so a raw `name: null` from the API clobbered the slug fallback and the
  // provider detail page rendered a blank name. `...inner` now leads the object
  // (mirroring normalizeProviderListItem) so the computed fields win.
  it("keeps the slug fallback when the raw name is null", () => {
    const out = normalizeProvider({ provider: { slug: "acme", name: null } }, "acme");
    expect(out.name).toBe("acme");
    expect(out.slug).toBe("acme");
  });

  it("preserves passthrough raw fields without clobbering computed ones", () => {
    const out = normalizeProvider(
      { provider: { slug: "acme", name: "Acme", extra_field: "kept" } },
      "acme",
    );
    expect(out.name).toBe("Acme");
    expect((out as Record<string, unknown>).extra_field).toBe("kept");
  });
});

describe("getNextPageParam", () => {
  it("returns the stashed cursor from infinite-list meta", () => {
    expect(getNextPageParam({ meta: { _next_cursor: "cursor-abc" } })).toBe("cursor-abc");
  });

  it("returns undefined when the cursor is null or absent", () => {
    expect(getNextPageParam({ meta: { _next_cursor: null } })).toBeUndefined();
    expect(getNextPageParam({ meta: {} })).toBeUndefined();
    expect(getNextPageParam({})).toBeUndefined();
  });
});

describe("normalizeSubnetGaps (#3348)", () => {
  it("reads missing_kinds from the subnet gaps priorities row", () => {
    const out = normalizeSubnetGaps({
      netuid: 7,
      priorities: [
        {
          netuid: 7,
          missing_kinds: ["openapi", "docs"],
          suggested_next_action: "evaluate adapter support",
        },
      ],
      enrichment_queue: [],
    });
    expect(out).toMatchObject({
      netuid: 7,
      missing_kinds: ["openapi", "docs"],
      gap_notes: ["evaluate adapter support"],
      suggested_next_action: "evaluate adapter support",
    });
  });

  it("returns null for malformed payloads", () => {
    expect(normalizeSubnetGaps(null)).toBeNull();
    expect(normalizeSubnetGaps({ priorities: [] })).toBeNull();
  });
});

describe("validateNextCursor", () => {
  it("returns null when next_cursor is absent, null, blank, or whitespace-only", () => {
    expect(validateNextCursor({}, undefined)).toEqual({ cursor: null });
    expect(validateNextCursor({ pagination: { next_cursor: null } }, undefined)).toEqual({
      cursor: null,
    });
    expect(validateNextCursor({ pagination: { next_cursor: "" } }, undefined)).toEqual({
      cursor: null,
    });
    expect(validateNextCursor({ pagination: { next_cursor: "   " } }, undefined)).toEqual({
      cursor: null,
    });
  });

  it("trims string cursors and reads pagination.next_cursor or meta.next_cursor", () => {
    expect(
      validateNextCursor({ pagination: { next_cursor: "  cursor-abc  " } }, undefined),
    ).toEqual({ cursor: "cursor-abc" });
    expect(validateNextCursor({ next_cursor: "legacy-cursor" }, undefined)).toEqual({
      cursor: "legacy-cursor",
    });
  });

  it("coerces finite numeric cursors to strings", () => {
    expect(validateNextCursor({ pagination: { next_cursor: 42 } }, undefined)).toEqual({
      cursor: "42",
    });
  });

  it("stops pagination when the API echoes the sent cursor", () => {
    expect(
      validateNextCursor({ pagination: { next_cursor: "same-cursor" } }, "same-cursor"),
    ).toEqual({ cursor: null, invalid: true });
    expect(validateNextCursor({ pagination: { next_cursor: 99 } }, "99")).toEqual({
      cursor: null,
      invalid: true,
    });
  });

  it("marks unexpected cursor shapes invalid", () => {
    expect(
      validateNextCursor(
        { pagination: { next_cursor: { bad: true } } } as unknown as Parameters<
          typeof validateNextCursor
        >[0],
        undefined,
      ),
    ).toEqual({
      cursor: null,
      invalid: true,
    });
    expect(validateNextCursor({ pagination: { next_cursor: Number.NaN } }, undefined)).toEqual({
      cursor: null,
      invalid: true,
    });
  });
});

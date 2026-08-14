// `?sections=` on the two composite subnet documents (#10600).
//
// #9981 gave four document-shaped routes a lever by declaring a query
// collection (tests/document-route-paging.test.ts pins those). These two could
// not take it: their bulk is four parallel arrays over the same subject
// (`endpoints`, `surfaces`, `verified_surfaces`, `candidate_surfaces` --
// 76/76/76/16 on subnet 64), and a collection pages ONE `data_key`, so
// declaring one would have narrowed a quarter of 272,825 B and left the rest.
//
// What this pins is the part a reader cannot check by looking: that selecting
// sections never costs the caller the envelope, that an unknown name is
// refused rather than quietly dropped, and that the two routes have DIFFERENT
// vocabularies -- the profile carries no `economics`, so accepting that name
// there would promise a section it can never return.
import assert from "node:assert/strict";
import { describe, expect, it, test } from "vitest";
import { z } from "zod";
import { sectionsOf } from "../schemas-src/artifact-sections.ts";
import { sectionsSchema } from "../schemas-src/query-params.ts";
import {
  ENVELOPE_SECTIONS,
  parseSectionsParam,
  projectSections,
  projectToolSections,
} from "../src/section-projection.ts";
import {
  SubnetDetailArtifactSchema,
  SUBNET_DETAIL_SECTIONS,
} from "../schemas-src/routes/subnet-detail.ts";
import {
  SubnetProfileArtifactSchema,
  SUBNET_PROFILE_SECTIONS,
} from "../schemas-src/routes/subnet-profiles.ts";
import { ArtifactBaseSchema } from "../schemas-src/envelope.ts";
import { LIVE_HEALTH_OVERLAY } from "../schemas-src/routes/subnet-detail.ts";
import {
  SUBNET_OVERVIEW_SECTIONS,
  SubnetOverviewArtifactSchema,
} from "../schemas-src/routes/subnet-overview.ts";

const DETAIL = SUBNET_DETAIL_SECTIONS;
const PROFILE = SUBNET_PROFILE_SECTIONS;

/** A document shaped like the served artifact: envelope + sections. */
const document = (): Record<string, unknown> => ({
  schema_version: 1,
  contract_version: "2026-08-13",
  generated_at: "2026-08-13T00:00:00.000Z",
  operational_observed_at: "2026-08-13T00:00:00.000Z",
  health_source: "probe",
  subnet: { netuid: 64, name: "Chutes" },
  economics: { alpha_price_tao: 0.02 },
  endpoints: [{ id: "e1" }],
  surfaces: [{ id: "s1" }, { id: "s2" }],
  verified_surfaces: [{ id: "s1" }],
  candidate_surfaces: [{ id: "c1" }],
  candidates: [{ id: "c1" }],
  gaps: { missing: [] },
  notes: "hand-written",
});

describe("parseSectionsParam", () => {
  test("absent and empty are both 'no projection', not 'project nothing'", () => {
    // The distinction matters: returning `{sections: []}` for an absent
    // parameter would project every section away and serve a bare envelope to
    // every caller who did not ask for one.
    assert.equal(parseSectionsParam(null, DETAIL), null);
    assert.equal(parseSectionsParam(undefined, DETAIL), null);
    assert.equal(parseSectionsParam("", DETAIL), null);
  });

  test("known names are kept in the order given, deduplicated", () => {
    const parsed = parseSectionsParam("economics,subnet,economics", DETAIL);
    assert.deepEqual(parsed?.sections, ["economics", "subnet"]);
    assert.deepEqual(parsed?.unknown, []);
  });

  test("an unknown name is reported, not dropped", () => {
    // Dropping it would answer `?sections=eeconomics` with a document missing
    // the one section the caller asked for -- a 200 that omits the request.
    const parsed = parseSectionsParam("economics,eeconomics", DETAIL);
    assert.deepEqual(parsed?.sections, ["economics"]);
    assert.deepEqual(parsed?.unknown, ["eeconomics"]);
  });

  test("an empty segment is unknown, not skipped", () => {
    // `a,,b` means the caller wrote something they believed named a section.
    const parsed = parseSectionsParam("subnet,,notes", DETAIL);
    assert.deepEqual(parsed?.unknown, [""]);
  });

  test("the two routes do not share a vocabulary", () => {
    // `economics` is a real section of the detail route and does not exist on
    // the profile. Accepting it there would promise a section that can never
    // arrive, which is worse than refusing it.
    // Widened deliberately: both lists are narrow tuples, so asking whether
    // the PROFILE list contains "economics" is a type error rather than a
    // false -- which is the type system making exactly this issue's point,
    // that the two vocabularies are different sets and not one shared one.
    assert.ok((DETAIL as readonly string[]).includes("economics"));
    assert.ok(!(PROFILE as readonly string[]).includes("economics"));
    assert.deepEqual(parseSectionsParam("economics", PROFILE)?.unknown, [
      "economics",
    ]);
    assert.ok(PROFILE.includes("profile"));
    assert.deepEqual(parseSectionsParam("profile", DETAIL)?.unknown, [
      "profile",
    ]);
  });
});

describe("projectSections", () => {
  test("keeps the requested section and drops the rest", () => {
    const out = projectSections(document(), ["economics"]);
    assert.deepEqual(
      Object.keys(out).filter((k) => !ENVELOPE_SECTIONS.includes(k)),
      ["economics"],
    );
    assert.deepEqual(out.economics, { alpha_price_tao: 0.02 });
  });

  test("the envelope survives every projection", () => {
    // A smaller document still has to say what it is and when it was built.
    // Without this, `?sections=notes` would return an anonymous blob.
    for (const sections of [[], ["notes"], ["subnet", "gaps"]]) {
      const out = projectSections(document(), sections);
      for (const key of ENVELOPE_SECTIONS) {
        assert.ok(
          key in out,
          `${key} must survive ?sections=${sections.join(",")}`,
        );
      }
    }
  });

  test("key order follows the document, not the request", () => {
    // Two callers asking for the same sections in different orders must get
    // byte-identical responses, or a cache keyed on the body diverges for no
    // reason a caller can see.
    const a = JSON.stringify(projectSections(document(), ["notes", "subnet"]));
    const b = JSON.stringify(projectSections(document(), ["subnet", "notes"]));
    assert.equal(a, b);
  });

  test("a requested section the document lacks is absent, not null", () => {
    // Inventing a null would claim the section exists and is empty. The schema
    // already marks these optional.
    const sparse = { schema_version: 1, subnet: { netuid: 1 } };
    const out = projectSections(sparse, ["economics", "subnet"]);
    assert.ok(!("economics" in out));
    assert.deepEqual(out.subnet, { netuid: 1 });
  });

  test("projecting the four surface arrays away is where the bytes go", () => {
    // The measurement behind the issue: these four are the payload. Asking for
    // `subnet` alone has to actually shed them, not merely reorder.
    const full = document();
    const out = projectSections(full, ["subnet"]);
    for (const heavy of [
      "endpoints",
      "surfaces",
      "verified_surfaces",
      "candidate_surfaces",
    ]) {
      assert.ok(heavy in full, `fixture must carry ${heavy}`);
      assert.ok(!(heavy in out), `${heavy} must be projected away`);
    }
    assert.ok(JSON.stringify(out).length < JSON.stringify(full).length);
  });
});

// ── End to end, through the router ─────────────────────────────────────────
//
// The unit tests above prove the projection; these prove the WIRING, which is
// the half a reader cannot check. A route can declare `sections` in its schema,
// publish it in openapi.json, and still never apply it -- the parameter would
// validate, the response would be full-size, and every gate would stay green.
import { readFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../scripts/lib.ts";
import { handleRequest } from "../workers/api.ts";
import { createLocalArtifactEnv } from "../scripts/lib.ts";
import type { Row } from "./row-type.ts";

const ORIGIN = "https://api.metagraph.sh";

async function getRoute(pathname: string) {
  const res = await handleRequest(
    new Request(`${ORIGIN}${pathname}`),
    createLocalArtifactEnv() as unknown as Parameters<typeof handleRequest>[1],
    {} as Parameters<typeof handleRequest>[2],
  );
  let body: Row | null;
  try {
    body = JSON.parse(await res.clone().text()) as Row;
  } catch {
    // A non-JSON body is a real answer here (a 5xx page, say), and the caller
    // asserts on `res.status` in that case rather than on a parse that threw.
    body = null;
  }
  return { res, body };
}

describe("GET /api/v1/subnets/{netuid}?sections=", () => {
  test("without the parameter the whole document is served", async () => {
    // The control. If this ever returns a projected document, the default
    // changed and every existing caller silently lost sections.
    const { res, body } = await getRoute("/api/v1/subnets/1");
    assert.equal(res.status, 200);
    const data = (body?.data ?? {}) as Row;
    assert.ok("surfaces" in data, "surfaces present by default");
    assert.ok("endpoints" in data, "endpoints present by default");
  });

  test("a selected section is served and the rest are gone", async () => {
    const { res, body } = await getRoute("/api/v1/subnets/1?sections=subnet");
    assert.equal(res.status, 200);
    const data = (body?.data ?? {}) as Row;
    assert.ok("subnet" in data, "the requested section is present");
    for (const shed of [
      "surfaces",
      "endpoints",
      "verified_surfaces",
      "candidate_surfaces",
    ]) {
      assert.ok(!(shed in data), `${shed} must be projected away`);
    }
  });

  test("the envelope survives the projection", async () => {
    const { body } = await getRoute("/api/v1/subnets/1?sections=notes");
    const data = (body?.data ?? {}) as Row;
    assert.equal(
      data.schema_version,
      1,
      "a projected document still says what it is",
    );
    assert.ok(data.generated_at, "and when it was built");
  });

  test("two sections are both served", async () => {
    const { body } = await getRoute("/api/v1/subnets/1?sections=subnet,gaps");
    const data = (body?.data ?? {}) as Row;
    assert.ok("subnet" in data);
    assert.ok("gaps" in data);
    assert.ok(!("surfaces" in data));
  });

  test("an unknown section is a 400 that names the vocabulary", async () => {
    // The refusal is the ROUTER's, not the handler's: `routeText` reads a value
    // already parsed against the published pattern, so an unknown section never
    // reaches the projection. That is why no handler-side message exists to
    // unit-test -- this drives the real request instead.
    const { res, body } = await getRoute("/api/v1/subnets/1?sections=bogus");
    assert.equal(res.status, 400);
    const error = (body?.error ?? {}) as Row;
    assert.equal(error.code, "invalid_query");
    assert.match(String(error.message), /sections/);
  });

  test("the overview route serves a selected section and sheds the rest (#11100)", async () => {
    const { res, body } = await getRoute(
      "/api/v1/subnets/1/overview?sections=profile",
    );
    assert.equal(res.status, 200);
    const data = (body?.data ?? {}) as Row;
    assert.ok("profile" in data, "the requested section is present");
    for (const shed of ["health", "curation", "gaps", "counts"]) {
      assert.ok(!(shed in data), `${shed} must be projected away`);
    }
    // Its own vocabulary: `economics` is a detail-route section the overview
    // never carries, so it must be refused, not ignored.
    const refused = await getRoute(
      "/api/v1/subnets/1/overview?sections=economics",
    );
    assert.equal(refused.res.status, 400);
  });

  test("the profile route refuses `economics`, which it cannot serve", async () => {
    // Its own vocabulary, not a shared one: accepting a name this document
    // never carries would promise a section that can never arrive.
    const { res } = await getRoute(
      "/api/v1/subnets/1/profile?sections=economics",
    );
    assert.equal(res.status, 400);
    const ok = await getRoute("/api/v1/subnets/1/profile?sections=subnet");
    assert.equal(ok.res.status, 200);
    assert.ok("subnet" in ((ok.body?.data ?? {}) as Row));
  });
});

describe("the lever is published, not just implemented", () => {
  // Asserted against the EMITTED contract, the same way
  // document-route-paging.test.ts pins #9981's four: a caller discovers the
  // lever from openapi.json or not at all, and a route quietly returning to
  // NO_QUERY_PARAMETERS would restore the 272 KB default with the handler code
  // still sitting there unreachable.
  const openapi = JSON.parse(
    readFileSync(path.join(repoRoot, "public/metagraph/openapi.json"), "utf8"),
  ) as {
    paths: Record<
      string,
      { get?: { parameters?: Array<{ name?: string; $ref?: string }> } }
    >;
  };

  const published = (route: string): Array<Record<string, unknown>> =>
    (openapi.paths[route]?.get?.parameters ?? []) as Array<
      Record<string, unknown>
    >;

  it.each([
    ["/api/v1/subnets/{netuid}", SUBNET_DETAIL_SECTIONS],
    ["/api/v1/subnets/{netuid}/profile", SUBNET_PROFILE_SECTIONS],
    ["/api/v1/subnets/{netuid}/overview", SUBNET_OVERVIEW_SECTIONS],
  ])("%s publishes sections with its own closed set", (route, vocabulary) => {
    const parameter = published(route).find((p) => p.name === "sections");
    expect(parameter, `${route} must publish sections`).toBeTruthy();
    // The pattern carries the vocabulary, so a generated client rejects an
    // unknown section without a round trip. That is what the separate
    // parameter buys over `fields`, whose column names cannot be enumerated.
    const pattern = String(
      (parameter?.schema as Record<string, unknown> | undefined)?.pattern ?? "",
    );
    for (const section of vocabulary) {
      expect(pattern, `${route} pattern must name ${section}`).toContain(
        section,
      );
    }
  });

  it("does not publish sections on a route that cannot project", () => {
    // Positive control for the assertions above: `sections` is not simply
    // everywhere. /api/v1/subnets is a list, and its lever is paging.
    expect(
      published("/api/v1/subnets").find((p) => p.name === "sections"),
    ).toBeUndefined();
  });
});

describe("projectToolSections (the MCP side)", () => {
  // The tools do NOT reach the REST serving seam -- each composes its own
  // response -- so the projection is applied in the handler and shares this
  // function, which is what stops the two surfaces disagreeing about what
  // `sections=economics` returns.
  test("projects when the tool was given a section list", () => {
    const out = projectToolSections(
      document(),
      { netuid: 64, sections: "economics" },
      DETAIL,
    );
    assert.ok("economics" in out);
    assert.ok(!("surfaces" in out));
  });

  test("absent sections leaves the document whole", () => {
    const out = projectToolSections(document(), { netuid: 64 }, DETAIL);
    assert.deepEqual(Object.keys(out).sort(), Object.keys(document()).sort());
  });

  test("a non-string is treated as absent, not coerced", () => {
    // An agent sending `sections: ["a","b"]` has made the type error it looks
    // like on a typed surface. Guessing would serve a projection nobody asked
    // for; the tool's own input schema is what rejects it.
    const out = projectToolSections(
      document(),
      { sections: ["economics"] },
      DETAIL,
    );
    assert.ok("surfaces" in out, "an array is not a section list");
  });

  test("an unknown name projects nothing rather than a partial guess", () => {
    // Unreachable through the dispatch (the input schema carries the same
    // closed pattern), so this pins the fallback rather than the contract: a
    // half-understood request must not be answered as if it were understood.
    const out = projectToolSections(
      document(),
      { sections: "economics,bogus" },
      DETAIL,
    );
    assert.ok("surfaces" in out);
  });

  test("a null document survives", () => {
    assert.equal(
      projectToolSections(null, { sections: "economics" }, DETAIL),
      null,
    );
  });
});

// The vocabularies are DERIVED from the artifact schemas rather than written
// out (#10600 follow-up). Deriving removes the drift these tests used to have
// to watch for, so what is left to pin is the derivation itself: that it reads
// the document it claims to, and that the envelope it holds back is the
// envelope the schemas actually declare.
describe("the section vocabulary cannot drift from the document", () => {
  // Written out ON PURPOSE, and the only place in the tree that is. Asserting
  // `sectionsOf(schema)` equals `keys(schema) minus envelope` would just be
  // sectionsOf restated -- it passes however wrong both sides are, together.
  // These are the published values of a public query parameter, so widening or
  // narrowing one should cost a deliberate edit here: add a top-level key to a
  // served artifact and it silently becomes a new accepted `?sections=` value
  // otherwise.
  test.each([
    [
      "detail",
      SUBNET_DETAIL_SECTIONS,
      [
        "candidate_surfaces",
        "candidates",
        "economics",
        "endpoints",
        "gaps",
        "notes",
        "subnet",
        "surfaces",
        "verified_surfaces",
      ],
    ],
    [
      "profile",
      SUBNET_PROFILE_SECTIONS,
      [
        "candidate_surfaces",
        "endpoints",
        "gaps",
        "notes",
        "profile",
        "subnet",
        "surfaces",
      ],
    ],
    [
      "overview",
      SUBNET_OVERVIEW_SECTIONS,
      [
        "compute_requirements",
        "counts",
        "curation",
        "gap_priorities",
        "gaps",
        "health",
        "name",
        "netuid",
        "notes",
        "profile",
        "slug",
        "status",
      ],
    ],
  ])("%s publishes exactly this vocabulary", (_name, vocab, expected) => {
    // Compared unsorted: `sectionsOf` sorts, so the published order is part of
    // what this pins.
    assert.deepEqual([...vocab], expected);
  });

  test("every offered section is a key the document can actually carry", () => {
    // The direction that matters to a caller: `?sections=X` must never name a
    // card the artifact has no slot for, or the 200 comes back missing the one
    // thing that was asked for.
    for (const [schema, vocab] of [
      [SubnetDetailArtifactSchema, SUBNET_DETAIL_SECTIONS],
      [SubnetProfileArtifactSchema, SUBNET_PROFILE_SECTIONS],
      [SubnetOverviewArtifactSchema, SUBNET_OVERVIEW_SECTIONS],
    ] as const) {
      for (const section of vocab) {
        assert.ok(
          section in schema.shape,
          `${section} is offered but the artifact declares no such key`,
        );
      }
    }
  });

  test("ENVELOPE_SECTIONS is what the schemas declare, both directions", () => {
    // The five names were hand-written in three places before this. They are
    // exactly the base envelope (minus `notes`, which is public-safe content a
    // caller may legitimately shed) plus the live-health overlay -- so if a
    // key is added to either, this fails rather than silently making it
    // unselectable or projecting it away.
    const declared = [
      ...Object.keys(ArtifactBaseSchema.shape).filter((k) => k !== "notes"),
      ...Object.keys(LIVE_HEALTH_OVERLAY),
    ].sort();
    assert.deepEqual([...ENVELOPE_SECTIONS].sort(), declared);
  });

  test("`notes` is content, not envelope", () => {
    // It sits in the base alongside the envelope keys, so the one thing that
    // separates it is this decision. Pinned because losing it would quietly
    // make `notes` unshakeable on every artifact route at once.
    assert.ok(!ENVELOPE_SECTIONS.includes("notes"));
    assert.ok(SUBNET_DETAIL_SECTIONS.includes("notes"));
    assert.ok(SUBNET_PROFILE_SECTIONS.includes("notes"));
  });
});

// Both derivations refuse rather than publish something incoherent. Neither is
// reachable from the two routes today -- which is the point of pinning them:
// they are the guardrails a THIRD composite route would hit first.
describe("the derivation refuses what it cannot publish", () => {
  test("a document with only envelope keys gets no `sections` parameter", () => {
    // Deriving an empty vocabulary would publish `?sections=` that accepts
    // nothing -- a parameter whose every value is a 400.
    assert.throws(
      () =>
        sectionsOf({
          shape: { schema_version: z.literal(1), generated_at: z.string() },
        }),
      /only envelope keys/,
    );
  });

  test("an example naming a section the document lacks is refused", () => {
    // The example is hand-picked for what it teaches, so this is what keeps it
    // honest: drop `economics` from the artifact and the build fails instead of
    // shipping a documented example the route now rejects.
    assert.throws(
      () => sectionsSchema(["subnet", "gaps"], ["subnet", "economics"]),
      /economics/,
    );
  });

  test("an example the document does carry is accepted", () => {
    // The other side of the same branch: a valid example must not throw, or
    // the check would be a guard nothing can pass.
    const schema = sectionsSchema(["subnet", "gaps"], ["subnet", "gaps"]);
    assert.equal(schema.safeParse("subnet,gaps").success, true);
    assert.equal(schema.safeParse("economics").success, false);
  });
});

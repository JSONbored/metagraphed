// #11142: the projection signal both response tripwires read.
//
// The bug this pins, reproduced against production 2026-08-14:
//   get_subnet(netuid=105, sections="health,counts,curation,gaps")
//     -> response_schema_drift on `netuid`
//   GET /subnets/105/overview?sections=health,counts,curation,gaps
//     -> 200
// One contract, two seams, two answers. These tests hold them together.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  argsProject,
  isProjectedAway,
  urlProjects,
  PROJECTION_PARAMETERS,
  PROJECTION_TOGGLE,
} from "../src/projection-signal.ts";
import { validateMcpResponseTripwire } from "../src/mcp-response-tripwire.ts";
import { outputJsonSchema } from "../src/mcp-input-schema.ts";

describe("urlProjects", () => {
  const projects = (qs: string) => urlProjects(new URLSearchParams(qs));

  it("sees each of the three levers", () => {
    expect(projects("fields=netuid")).toBe(true);
    expect(projects("sections=health")).toBe(true);
    expect(projects("include_points=false")).toBe(true);
  });

  it("is false for a request that asked for everything", () => {
    expect(projects("")).toBe(false);
    expect(projects("limit=10&window=7d")).toBe(false);
    // Only the literal `false` narrows the response; `true` is the default.
    expect(projects("include_points=true")).toBe(false);
  });
});

describe("argsProject", () => {
  it("sees the same three levers as tool arguments", () => {
    expect(argsProject({ fields: "netuid,name" })).toBe(true);
    expect(argsProject({ sections: "health" })).toBe(true);
    // A real boolean over MCP, not the string REST parses.
    expect(argsProject({ include_points: false })).toBe(true);
  });

  it("does not treat an empty selection as a projection", () => {
    // `fields: ""` selects nothing and is refused upstream. Calling it a
    // projection here would forgive absence on a call that never narrowed.
    expect(argsProject({ fields: "" })).toBe(false);
    expect(argsProject({ sections: "" })).toBe(false);
  });

  it("is false for a call that asked for everything, and for a non-object", () => {
    expect(argsProject({ netuid: 105 })).toBe(false);
    expect(argsProject({ include_points: true })).toBe(false);
    expect(argsProject(null)).toBe(false);
    expect(argsProject(undefined)).toBe(false);
    expect(argsProject(["fields"])).toBe(false);
    expect(argsProject("fields=netuid")).toBe(false);
  });

  it("reads the levers from the exported vocabulary, not a private copy", () => {
    for (const name of PROJECTION_PARAMETERS) {
      expect(argsProject({ [name]: "x" })).toBe(true);
    }
    expect(argsProject({ [PROJECTION_TOGGLE]: false })).toBe(true);
  });
});

describe("isProjectedAway", () => {
  it("forgives a key the projection removed", () => {
    expect(isProjectedAway({ health: {} }, ["netuid"])).toBe(true);
  });

  it("does not forgive a key that is present with the wrong value", () => {
    expect(isProjectedAway({ netuid: "105" }, ["netuid"])).toBe(false);
    expect(isProjectedAway({ netuid: null }, ["netuid"])).toBe(false);
  });

  it("does not descend through a scalar", () => {
    // Unreachable through a real Zod issue -- Zod reports at the level that
    // failed -- so it is proven by handing it such a path directly. This is the
    // one place either tripwire could forgive a real drift.
    expect(isProjectedAway({ netuid: 105 }, ["netuid", "inner"])).toBe(false);
    expect(isProjectedAway(null, ["netuid"])).toBe(false);
  });
});

describe("the MCP tripwire under a projection", () => {
  // The shape of the tool the bug was reported against: a required scalar
  // beside the sections a caller can select.
  const schema = z
    .object({
      netuid: z.number(),
      health: z.object({ status: z.string() }).optional(),
      counts: z.object({ surfaces: z.number() }).optional(),
    })
    .strict();
  const published = outputJsonSchema(schema);

  it("throws on the projected result when the caller asked for everything", () => {
    // The unprojected call is still fully enforced: this is a real drift.
    expect(() =>
      validateMcpResponseTripwire(
        "get_subnet",
        published,
        { health: { status: "healthy" } },
        false,
      ),
    ).toThrow(/netuid/);
  });

  it("accepts the same result when the caller selected sections", () => {
    // The exact production failure: `netuid` is absent because it was not
    // selected, and that is the answer the caller asked for.
    expect(() =>
      validateMcpResponseTripwire(
        "get_subnet",
        published,
        { health: { status: "healthy" }, counts: { surfaces: 39 } },
        true,
      ),
    ).not.toThrow();
  });

  it("still refuses a key the projection cannot explain", () => {
    // A projection removes keys. It cannot ADD one, so an unrecognized key is
    // a drift whether or not sections was supplied.
    expect(() =>
      validateMcpResponseTripwire(
        "get_subnet",
        published,
        { health: { status: "healthy" }, surprise: 1 },
        true,
      ),
    ).toThrow(/surprise/);
  });

  it("still refuses a present value of the wrong type", () => {
    expect(() =>
      validateMcpResponseTripwire(
        "get_subnet",
        published,
        { netuid: "105" },
        true,
      ),
    ).toThrow(/netuid/);
  });
});

// The counts every cost-to-participate surface quotes, checked against the
// registry that actually determines them.
//
// This is the half of src/compute-declaration-figures.ts that a build CAN
// check. Three of the four figures are properties of registry/subnets/*.json,
// so they are re-derived here rather than trusted: adding a subnet, or adding
// or removing a min_compute surface, fails this file and points at the numbers
// that must move with it.
//
// It also asserts that no surface has gone back to hard-coding one. That is the
// defect this file exists for: the figures were literals in four places, all
// four were wrong on 2026-08-15, and correcting one left the other three
// serving stale numbers to their own callers (#11284's incomplete half).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";

import { MIN_COMPUTE_FILENAME } from "../src/compute-declarations-lane.ts";
import {
  DECLARATIONS_REQUIRING_A_GPU,
  MIN_COMPUTE_SURFACES_REGISTERED,
  SUBNETS_IN_REGISTRY,
  SUBNETS_WITHOUT_A_DECLARATION,
} from "../src/compute-declaration-figures.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SUBNETS_DIR = path.join(REPO_ROOT, "registry", "subnets");

interface RegistrySurface {
  url?: unknown;
  public_safe?: unknown;
}

function registryFiles(): string[] {
  return readdirSync(SUBNETS_DIR).filter((name) => name.endsWith(".json"));
}

/** The lane's own selection rule, applied to the committed registry. Kept in
 * step with minComputeSurfaces by importing the SAME regex it matches on, so a
 * change to what counts as a min_compute surface cannot pass this by. */
function registeredMinComputeSurfaces(): number {
  let found = 0;
  for (const name of registryFiles()) {
    const parsed: unknown = JSON.parse(
      readFileSync(path.join(SUBNETS_DIR, name), "utf8"),
    );
    const surfaces =
      (parsed as { surfaces?: RegistrySurface[] }).surfaces ?? [];
    for (const surface of surfaces) {
      if (typeof surface?.url !== "string") continue;
      if (!MIN_COMPUTE_FILENAME.test(surface.url)) continue;
      if (surface?.public_safe !== true) continue;
      found += 1;
    }
  }
  return found;
}

describe("the published compute-declaration figures", () => {
  test("SUBNETS_IN_REGISTRY is what the registry holds", () => {
    assert.equal(registryFiles().length, SUBNETS_IN_REGISTRY);
  });

  test("MIN_COMPUTE_SURFACES_REGISTERED is what the lane would enqueue", () => {
    assert.equal(
      registeredMinComputeSurfaces(),
      MIN_COMPUTE_SURFACES_REGISTERED,
    );
  });

  test("SUBNETS_WITHOUT_A_DECLARATION is the remainder, not an independent claim", () => {
    assert.equal(
      SUBNETS_WITHOUT_A_DECLARATION,
      SUBNETS_IN_REGISTRY - MIN_COMPUTE_SURFACES_REGISTERED,
    );
  });

  test("the GPU count supports the claim the surfaces actually make", () => {
    // Not derivable from the registry -- whether a declaration asks for a GPU
    // is a property of the fetched document. What IS checkable is the claim
    // every surface builds on it: that pricing the fleet against a rental rate
    // would charge most subnets for hardware they never asked for. That holds
    // only while this is a MINORITY of the declarations, so the assertion is
    // the inequality rather than the number.
    assert.ok(DECLARATIONS_REQUIRING_A_GPU >= 1);
    assert.ok(
      DECLARATIONS_REQUIRING_A_GPU * 2 < MIN_COMPUTE_SURFACES_REGISTERED,
      "if a GPU requirement ever stops being a minority, the 'no cost per day' " +
        "rationale these descriptions publish needs rewriting, not just renumbering",
    );
  });
});

describe("no surface hard-codes a figure instead of importing it", () => {
  // The four files that describe this card to a caller. Each writes its own
  // prose on purpose -- the MCP text is imperative because an agent reads it,
  // the GraphQL text is shorter -- so they are checked for the FACTS they
  // quote, not for identical wording.
  const DESCRIBING_SOURCES = [
    "src/contracts.ts",
    "src/mcp-server.ts",
    "schemas-src/graphql/query-exposures.ts",
    "schemas-src/routes/cost-to-participate.ts",
    "schemas-src/compute.ts",
  ];

  // Every literal spelling of a figure that used to be hard-coded here. A
  // regex per figure, not one big alternation, so a failure names which number
  // came back.
  const FORBIDDEN: Array<[string, RegExp]> = [
    ["a registered-declaration count", /\b1[0-9] registered declarations\b/i],
    ["a GPU tally in words", /\bexactly one asks for a GPU\b/i],
    ["a no-declaration count", /\b111 of 1[0-9][0-9] subnets\b/i],
  ];

  for (const relative of DESCRIBING_SOURCES) {
    test(`${relative} interpolates the constants`, () => {
      const source = readFileSync(path.join(REPO_ROOT, relative), "utf8");
      for (const [what, pattern] of FORBIDDEN) {
        assert.ok(
          !pattern.test(source),
          `${relative} hard-codes ${what}. Import it from ` +
            "src/compute-declaration-figures.ts instead -- that is the whole " +
            "point of the module, and four copies is how all four went stale.",
        );
      }
    });
  }
});

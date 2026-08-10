// #10483: the curated address-label registry, as a served artifact.
//
// The layer existed at both ends and was unreachable in the middle -- the build
// has written entities.json since #6737 and the Worker has read it since #6740,
// but it was never in PUBLIC_ARTIFACTS, so the public path answered
// `not_found: No public artifact contract matched this path`.
//
// The vocabulary test below is the one that matters most. #10442/#10516 widened
// entity.schema.json's category enum with the four money-map roles and left
// ENTITY_CATEGORY_VALUES at eight, and nothing caught it for the same reason
// nothing caught the dead producer in #10566: registry/entities/ is empty, so no
// document carried a `treasury` category, so there was nothing for any gate to
// reject. The drift becomes visible on the first real entry -- i.e. during the
// 21 attribution issues, at the point where being wrong is most expensive.
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { PUBLIC_ARTIFACTS } from "../src/contracts.ts";
import { ENTITY_CATEGORY_VALUES } from "../schemas-src/shared.ts";
import {
  EntitiesArtifactSchema,
  EntitySchema,
  UNSPENDABLE_PROOF_BASIS_VALUES,
} from "../schemas-src/artifacts/entities.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

async function entityJsonSchema(): Promise<Record<string, never>> {
  return JSON.parse(
    await fs.readFile(
      path.join(repoRoot, "schemas/entity.schema.json"),
      "utf8",
    ),
  );
}

/** A label that clears the evidence bar, shaped as the build passes it through. */
function validEntity(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    ss58: "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9",
    name: "Example Treasury",
    category: "treasury",
    netuid: 64,
    source_urls: ["https://example.org/treasury-address"],
    review: { state: "community-submitted" },
    ...overrides,
  };
}

describe("entities artifact contract", () => {
  test("the artifact is published, so /metagraph/entities.json resolves", () => {
    const entry = PUBLIC_ARTIFACTS.find((a) => a.id === "entities");
    assert.ok(entry, "no PUBLIC_ARTIFACTS entry with id 'entities'");
    assert.equal(entry.path, "/metagraph/entities.json");
    // The catalog holds the bare component name; buildContractsArtifact is
    // what expands it to a $ref.
    assert.equal(entry.schema_ref, "EntitiesArtifact");
  });

  test("it sits beside providers.json rather than under a path template", () => {
    // A templated path ({slug}/{netuid}) is served per-key; this one is a single
    // whole-registry document, and reading it must not require knowing an
    // address in advance -- that is the entire reason the money map needs it.
    const entry = PUBLIC_ARTIFACTS.find((a) => a.id === "entities");
    assert.ok(entry);
    assert.ok(
      !entry.path.includes("{"),
      "entities.json must not be a templated per-key path",
    );
  });
});

describe("entity category vocabulary", () => {
  test("the Zod copy matches the JSON Schema that owns it", async () => {
    const schema = (await entityJsonSchema()) as unknown as {
      properties: { category: { enum: string[] } };
    };
    assert.deepEqual(
      [...ENTITY_CATEGORY_VALUES].sort(),
      [...schema.properties.category.enum].sort(),
      "entity.schema.json OWNS this vocabulary — widen the schemas-src copy, not the source",
    );
  });

  test("the money-map roles are actually present", () => {
    // Guard the guard: the deepEqual above passes vacuously if BOTH sides lose
    // the money categories, which is exactly how this drifted in the first
    // place -- one side was simply never updated.
    for (const role of [
      "payment-collector",
      "treasury",
      "burn",
      "multisig",
    ] as const) {
      assert.ok(
        (ENTITY_CATEGORY_VALUES as readonly string[]).includes(role),
        `${role} missing from ENTITY_CATEGORY_VALUES`,
      );
    }
  });

  test("owner is not declarable", () => {
    // Chain-derived from SubnetOwner. A hand-declared owner is the one
    // attribution nobody may make, and the enum is where that is enforced.
    assert.ok(
      !(ENTITY_CATEGORY_VALUES as readonly string[]).includes("owner"),
      "owner must never be a declarable category",
    );
  });
});

describe("EntitiesArtifactSchema", () => {
  test("accepts an empty registry", () => {
    // An empty curated layer is the honest state, not a cold store: the
    // registry holds only what has cleared docs/nametag-evidence-bar.md.
    const parsed = EntitiesArtifactSchema.safeParse({
      schema_version: 1,
      generated_at: "2026-08-10T00:00:00.000Z",
      entities: [],
    });
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });

  test("accepts a subnet-scoped money-map label", () => {
    const parsed = EntitySchema.safeParse(validEntity());
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });

  test("accepts a burn label carrying its unspendability proof", () => {
    const parsed = EntitySchema.safeParse(
      validEntity({
        category: "burn",
        unspendable_proof: {
          basis: UNSPENDABLE_PROOF_BASIS_VALUES[0],
          evidence_url: "https://example.org/burn-address",
        },
      }),
    );
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  });

  test("rejects a label with no evidence", () => {
    // source_urls is the whole point of the file. A claim with no proof is a
    // specific, confident, wrong assertion rendered next to real financial
    // activity -- worse than no label at all.
    for (const source_urls of [undefined, []]) {
      const parsed = EntitySchema.safeParse(validEntity({ source_urls }));
      assert.equal(
        parsed.success,
        false,
        `source_urls=${JSON.stringify(source_urls)} must not validate`,
      );
    }
  });

  test("rejects a category outside the vocabulary", () => {
    const parsed = EntitySchema.safeParse(validEntity({ category: "owner" }));
    assert.equal(parsed.success, false, "owner must not validate");
  });

  test("rejects an unspendability basis of 'no outbound observed'", () => {
    // Absence of spending is not inability to spend, and the enum is where
    // that distinction is held.
    const parsed = EntitySchema.safeParse(
      validEntity({
        category: "burn",
        unspendable_proof: {
          basis: "no-outbound-observed",
          evidence_url: "https://example.org/x",
        },
      }),
    );
    assert.equal(parsed.success, false);
  });
});

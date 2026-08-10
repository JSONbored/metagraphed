// #10442/#10483: the money-map categories carry a higher bar than a nametag.
//
// A wrongly-attributed treasury is a public allegation, and attribution is
// exactly where a confident wrong answer is cheapest to produce -- #10448
// nearly recorded a subnet's own protocol pool as a company revenue wallet.
// So `burn` is a CLAIM until proven: the schema refuses the category without
// a stated basis for unspendability, because "no outbound observed" is absence
// of spending, not inability to spend.
import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsPlugin from "ajv-formats";
import { readJson, repoRoot } from "../scripts/lib.ts";

const addFormats = addFormatsPlugin as unknown as (instance: Ajv2020) => void;
const ajv = new Ajv2020({
  strict: false,
  validateFormats: true,
  allErrors: true,
});
addFormats(ajv);
const entitySchema = await readJson(
  path.join(repoRoot, "schemas/entity.schema.json"),
);
const validate = ajv.compile(entitySchema);

type Json = Record<string, unknown>;

function entity(over: Json = {}): Json {
  return {
    schema_version: 1,
    ss58: "5FRYKhbmfXPDoHdUUDMx27E3HuMvAzwjzFMMq3rNurUhAyS9",
    name: "Example Treasury",
    category: "treasury",
    source_urls: ["https://example.com/official-address-list"],
    review: { state: "community-submitted" },
    ...over,
  };
}

describe("entity money-map categories (#10442)", () => {
  test("accepts the new categories", () => {
    for (const category of [
      "payment-collector",
      "treasury",
      "multisig",
      "exchange",
      "pool",
    ]) {
      assert.equal(
        validate(entity({ category })),
        true,
        `rejected ${category}`,
      );
    }
  });

  test("there is deliberately no `owner` category", () => {
    // Subnet ownership is chain-derived from SubnetOwner. A hand-declared owner
    // would be an unverifiable claim competing with a measured fact.
    assert.equal(validate(entity({ category: "owner" })), false);
    assert.ok(!entitySchema.properties.category.enum.includes("owner"));
  });

  test("netuid links a label to its subnet, and is bounded", () => {
    assert.equal(validate(entity({ netuid: 64 })), true);
    assert.equal(validate(entity({ netuid: 0 })), true);
    for (const bad of [-1, 65536, 1.5]) {
      assert.equal(validate(entity({ netuid: bad })), false, `accepted ${bad}`);
    }
  });

  test("burn without unspendable_proof is rejected", () => {
    const unproven = entity({ category: "burn" });
    assert.equal(validate(unproven), false);
    validate(unproven);
    assert.ok(
      (validate.errors ?? []).some((e) =>
        JSON.stringify(e.params).includes("unspendable_proof"),
      ),
      "rejection must name unspendable_proof, not fail for an unrelated reason",
    );
  });

  test("burn with a stated basis is accepted", () => {
    const proven = entity({
      category: "burn",
      unspendable_proof: {
        basis: "provably-keyless",
        evidence_url: "https://example.com/keyless-derivation",
      },
    });
    assert.equal(validate(proven), true, JSON.stringify(validate.errors));
  });

  test("unspendable_proof requires a basis AND a URL", () => {
    for (const proof of [
      { basis: "provably-keyless" },
      { evidence_url: "https://example.com/x" },
      { basis: "no-outbound-observed", evidence_url: "https://example.com/x" },
    ]) {
      assert.equal(
        validate(entity({ category: "burn", unspendable_proof: proof })),
        false,
        `accepted ${JSON.stringify(proof)}`,
      );
    }
  });

  test("unspendable_proof cannot be attached to a non-burn category", () => {
    // Otherwise a treasury could carry burn evidence and read as a burn in any
    // consumer that checks the proof rather than the category.
    assert.equal(
      validate(
        entity({
          category: "treasury",
          unspendable_proof: {
            basis: "known-black-hole",
            evidence_url: "https://example.com/x",
          },
        }),
      ),
      false,
    );
  });

  test("source_urls stays required for every new category", () => {
    for (const category of ["payment-collector", "treasury", "multisig"]) {
      const noProof = entity({ category });
      delete noProof.source_urls;
      assert.equal(
        validate(noProof),
        false,
        `${category} accepted with no proof`,
      );
    }
  });
});

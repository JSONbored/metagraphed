import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { DOMAIN_TAGS, deriveDomainTags } from "../src/domain-tags.mjs";

describe("DOMAIN_TAGS", () => {
  test("is the sorted controlled vocabulary", () => {
    assert.ok(DOMAIN_TAGS.length >= 10);
    assert.deepEqual(DOMAIN_TAGS, [...DOMAIN_TAGS].sort());
    assert.ok(new Set(DOMAIN_TAGS).size === DOMAIN_TAGS.length);
  });
});

describe("deriveDomainTags", () => {
  test("matches inference and training keywords from on-chain text", () => {
    const tags = deriveDomainTags({
      description: "Large language model inference with RLHF fine-tuning",
    });
    assert.deepEqual(tags, ["inference", "training"]);
  });

  test("tags the plural 'agents' the same as the singular 'agent'", () => {
    // Real on-chain descriptions phrase it both ways; the plural must not be
    // dropped from the ?domain=agents facet.
    for (const description of [
      "AI commerce agents",
      "Software Engineering Agents",
      "autonomous agents",
      "Designed for AI Agents",
    ]) {
      assert.deepEqual(
        deriveDomainTags({ description }),
        ["agents"],
        `expected ["agents"] for ${JSON.stringify(description)}`,
      );
    }
    // The singular still works (no regression).
    assert.deepEqual(deriveDomainTags({ description: "an agent network" }), [
      "agents",
    ]);
  });

  test("tags plural inflections of chatbot / threat / prompt", () => {
    assert.deepEqual(
      deriveDomainTags({ description: "A network of chatbots" }),
      ["inference"],
    );
    assert.deepEqual(
      deriveDomainTags({ description: "Detecting security threats" }),
      ["security"],
    );
    assert.deepEqual(
      deriveDomainTags({ description: "A marketplace for prompts" }),
      ["inference"],
    );
  });

  test("accepts curated categories that are already in the vocabulary", () => {
    const tags = deriveDomainTags({
      categories: ["Finance", "privacy"],
    });
    assert.deepEqual(tags, ["finance", "privacy"]);
  });

  test("never emits tags outside the fixed vocabulary", () => {
    const tags = deriveDomainTags({
      description: "totally made-up capability phrase not in the ruleset",
      additional: "also-not-a-real-tag",
      categories: ["not-a-domain-tag"],
    });
    assert.deepEqual(tags, []);
    for (const tag of tags) {
      assert.ok(DOMAIN_TAGS.includes(tag));
    }
  });

  test("is deterministic, sorted, and de-duplicated", () => {
    const input = {
      description: "GPU compute for image generation and image editing",
      categories: ["media", "compute"],
    };
    const first = deriveDomainTags(input);
    const second = deriveDomainTags(input);
    assert.deepEqual(first, second);
    assert.deepEqual(first, ["compute", "media"]);
    assert.equal(first.length, new Set(first).size);
  });
});

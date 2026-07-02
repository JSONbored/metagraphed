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

  test("tags the plural 'language models' / 'large language models'", () => {
    // "large language models" is the single most natural way to describe an
    // LLM/inference subnet, yet the inference rule only anchored the singular
    // ("language model") — the trailing \b failed before the plural "s", so a
    // plural-only description silently dropped the inference tag. Mirrors the
    // s? plurals every other alternative in the rule already carries.
    assert.deepEqual(
      deriveDomainTags({ description: "A marketplace for language models" }),
      ["inference"],
    );
    assert.deepEqual(
      deriveDomainTags({
        description: "A decentralized network of large language models",
      }),
      ["inference"],
    );
  });

  test("tags 'distributed computing' for the compute rule", () => {
    // "distributed computing" is the canonical way a compute subnet describes
    // itself, yet the compute rule only anchored the "decentralized" and
    // "parallel" adjective variants — a description that used "distributed"
    // silently dropped the compute tag. Mirrors the sibling `... comput\w*`
    // alternatives already in the rule.
    assert.deepEqual(
      deriveDomainTags({ description: "A distributed computing network" }),
      ["compute"],
    );
    assert.deepEqual(
      deriveDomainTags({ description: "Distributed compute for AI workloads" }),
      ["compute"],
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

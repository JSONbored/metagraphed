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

  test("fires at least one keyword per DOMAIN_TAG_RULE", () => {
    const cases = [
      ["agents", "autonomous agent network"],
      ["compute", "GPU cuda compute network"],
      ["data", "web scraping datasets pipeline"],
      ["finance", "defi trading and liquidity"],
      ["inference", "llm text-generation completion"],
      ["media", "text-to-speech and computer vision"],
      ["prediction", "probabilistic forecast markets"],
      ["privacy", "zero-knowledge proof privacy"],
      ["robotics", "embodied ai robotics drones"],
      ["science", "protein folding drug discovery"],
      ["search", "retrieval-augmented semantic search"],
      ["security", "malware vulnerability detection"],
      ["storage", "decentralized storage on ipfs"],
      ["training", "reinforcement learning model training"],
    ];
    for (const [tag, description] of cases) {
      const tags = deriveDomainTags({ description });
      assert.ok(
        tags.includes(tag),
        `expected "${tag}" from ${JSON.stringify(description)}, got ${JSON.stringify(tags)}`,
      );
    }
  });

  test("drops non-string description and additional values", () => {
    assert.deepEqual(
      deriveDomainTags({
        description: 42,
        additional: { not: "a string" },
        categories: ["finance"],
      }),
      ["finance"],
    );
    assert.deepEqual(
      deriveDomainTags({ description: null, additional: undefined }),
      [],
    );
  });

  test("ignores non-array categories and non-tag category strings", () => {
    assert.deepEqual(
      deriveDomainTags({
        description: "gpu compute",
        categories: "not-an-array",
      }),
      ["compute"],
    );
    assert.deepEqual(
      deriveDomainTags({
        categories: ["Not-A-Domain-Tag", "also-fake"],
      }),
      [],
    );
  });

  test("de-duplicates when the same tag matches text and a curated category", () => {
    const tags = deriveDomainTags({
      description: "decentralized storage network",
      categories: ["Storage"],
    });
    assert.deepEqual(tags, ["storage"]);
    assert.equal(tags.length, new Set(tags).size);
  });
});

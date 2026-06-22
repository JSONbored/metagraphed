import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  keywordScore,
  MAX_QUERY_TERMS,
  queryTerms,
} from "../src/keyword-search.mjs";

// Convenience: score a doc against a raw query string the way the tools do.
const score = (doc, query) => keywordScore(doc, queryTerms(query));

// Rank docs by score desc (matches the tools' primary sort) and return names.
function rank(docs, query) {
  return docs
    .map((doc) => ({ doc, s: score(doc, query) }))
    .filter((e) => e.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((e) => e.doc.name);
}

describe("queryTerms", () => {
  test("lowercases and splits on non-alphanumeric runs", () => {
    assert.deepEqual(queryTerms("Image  Generation!"), ["image", "generation"]);
    assert.deepEqual(queryTerms("sn-7 / bitcoin_data"), [
      "sn",
      "7",
      "bitcoin",
      "data",
    ]);
  });

  test("nullish / empty / symbol-only input yields no terms", () => {
    for (const v of [undefined, null, "", "   ", "---", "!@#"]) {
      assert.deepEqual(queryTerms(v), [], `input=${JSON.stringify(v)}`);
    }
  });

  test("deduplicates and caps terms to bound scoring work", () => {
    assert.deepEqual(queryTerms("GPU gpu inference GPU"), ["gpu", "inference"]);

    const query = Array.from(
      { length: MAX_QUERY_TERMS + 5 },
      (_, i) => `t${i}`,
    ).join(" ");
    assert.deepEqual(
      queryTerms(query),
      Array.from({ length: MAX_QUERY_TERMS }, (_, i) => `t${i}`),
    );
  });
});

describe("keywordScore — substring noise is gone (whole-word / prefix only)", () => {
  test('"ai" no longer matches brain / chain / domain', () => {
    // The classic false-positive set: each contains "ai" mid-word.
    for (const word of ["brain", "chain", "domain", "captain"]) {
      const doc = { name: word, slug: word, text: [word] };
      assert.equal(score(doc, "ai"), 0, `"ai" must not match "${word}"`);
    }
    // ...but a real whole-word "ai" still matches.
    assert.ok(score({ name: "AI Inference", slug: "ai", text: [] }, "ai") > 0);
  });

  test("a mid-word substring never matches", () => {
    // "ata" sits inside "data" but is not a word or a prefix of one.
    assert.equal(score({ name: "x", slug: "x", text: ["data"] }, "ata"), 0);
  });

  test('"price" beats "priceless": whole word outranks a weaker prefix hit', () => {
    const real = { name: "Token Price", slug: "token-price", text: [] };
    const noise = { name: "Priceless Art", slug: "priceless", text: [] };
    // Both are reachable (prefix still matches "priceless"), but the genuine
    // whole-word "price" must rank strictly higher than the "priceless" prefix.
    assert.ok(score(real, "price") > score(noise, "price"));
    assert.deepEqual(rank([noise, real], "price"), [
      "Token Price",
      "Priceless Art",
    ]);
  });

  test("word-prefix matching still aids discovery (infer → inference)", () => {
    const doc = { name: "x", slug: "x", text: ["inference"] };
    assert.ok(score(doc, "infer") > 0);
  });

  test("a 1-char term does not prefix-explode across the index", () => {
    // "a" is below the prefix floor: it only matches the whole word "a".
    assert.equal(score({ name: "Apple", slug: "apple", text: [] }, "a"), 0);
    assert.ok(score({ name: "a b", slug: "ab", text: [] }, "a") > 0);
  });
});

describe("keywordScore — field weighting", () => {
  test("a name/slug hit outranks the same word buried in a token list", () => {
    const inName = { name: "Bitcoin", slug: "bitcoin", text: ["data"] };
    const inTokens = {
      name: "Allways",
      slug: "allways",
      text: ["a", "b", "c", "bitcoin", "d"],
    };
    assert.ok(score(inName, "bitcoin") > score(inTokens, "bitcoin"));
    assert.deepEqual(rank([inTokens, inName], "bitcoin"), [
      "Bitcoin",
      "Allways",
    ]);
  });

  test("the same word in both name and text is not double-counted", () => {
    // Tokens fold in the name at build time; the name field should win, not sum.
    const both = { name: "Bitcoin", slug: "bitcoin", text: ["bitcoin"] };
    const nameOnly = { name: "Bitcoin", slug: "bitcoin", text: [] };
    assert.equal(score(both, "bitcoin"), score(nameOnly, "bitcoin"));
  });
});

describe("keywordScore — precision boosts", () => {
  test("an exact whole-query name match lands its obvious target first", () => {
    const exact = { name: "Targon", slug: "targon", text: [] };
    // A partial mention of "targon" deep in another subnet's tokens.
    const mention = {
      name: "Aggregator",
      slug: "aggregator",
      text: ["targon", "proxy"],
    };
    assert.deepEqual(rank([mention, exact], "targon"), [
      "Targon",
      "Aggregator",
    ]);
  });

  test("exact match works on the slug too, normalizing separators", () => {
    const doc = { name: "Image Gen", slug: "image-gen", text: [] };
    // "image gen" normalizes to the same token sequence as the slug.
    assert.ok(score(doc, "image gen") > score(doc, "image"));
  });

  test("full multi-term coverage outranks a partial match", () => {
    const both = {
      name: "Stable Diffusion",
      slug: "sd",
      text: ["image", "generation"],
    };
    const partial = { name: "Art Engine", slug: "art", text: ["image"] };
    assert.ok(
      score(both, "image generation") > score(partial, "image generation"),
    );
    assert.deepEqual(rank([partial, both], "image generation"), [
      "Stable Diffusion",
      "Art Engine",
    ]);
  });
});

describe("keywordScore — non-matches and edge inputs", () => {
  test("no matching term yields 0 (callers drop it)", () => {
    const doc = { name: "Compute", slug: "compute", text: ["gpu"] };
    assert.equal(score(doc, "bitcoin"), 0);
  });

  test("empty / non-array terms yield 0", () => {
    const doc = { name: "Compute", slug: "compute", text: ["gpu"] };
    assert.equal(keywordScore(doc, []), 0);
    assert.equal(keywordScore(doc, undefined), 0);
  });

  test("missing fields are tolerated", () => {
    assert.equal(keywordScore({}, ["gpu"]), 0);
    assert.equal(keywordScore(undefined, ["gpu"]), 0);
    // text may be a bare string rather than an array.
    assert.ok(keywordScore({ name: "x", text: "gpu" }, ["gpu"]) > 0);
  });
});

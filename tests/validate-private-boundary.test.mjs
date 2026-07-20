import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  allowedContentMentions,
  contentMatches,
  contentPatterns,
  isBinaryOrGenerated,
  pathMatches,
} from "../scripts/validate-private-boundary.mjs";

// #7236: scripts/validate-private-boundary.mjs is the CI guard that keeps the
// private submission-gate internals (real Discord webhooks, private AI
// scoring prompts/rubrics, provider-specific model routes) out of the public
// repo. Its leak-detection regexes are the whole correctness boundary, so pin
// their matches and -- just as important -- their non-matches, plus the
// allow-listed-mention exception that lets docs discuss the boundary without a
// real secret ever slipping through.

const DISCORD = "real Discord webhook URL";
const AI_INTERNALS = "private AI scoring internals";
const MODEL_ROUTE = "provider-specific private model route";

describe("contentMatches — real Discord webhook URLs (never allowed anywhere)", () => {
  test("flags a real webhook URL across the accepted discord hosts", () => {
    for (const host of [
      "discord.com",
      "discordapp.com",
      "canary.discord.com",
      "ptb.discord.com",
    ]) {
      const url = `https://${host}/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz1234567890`;
      assert.deepEqual(contentMatches("workers/notify.mjs", url), [DISCORD]);
    }
  });

  test("a real webhook is flagged even inside an allow-listed file", () => {
    const url =
      "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz1234567890";
    assert.deepEqual(contentMatches("CONTRIBUTING.md", url), [DISCORD]);
  });

  test("does not flag near-misses: wrong host, too-short token, or a bare mention", () => {
    for (const text of [
      "https://example.com/api/webhooks/123456789012345678/abcdefghijklmnopqrst",
      "https://discord.com/api/webhooks/123/short", // token < 20 chars
      "see the Discord webhook in the deploy secret (not inlined here)",
    ]) {
      assert.deepEqual(contentMatches("workers/notify.mjs", text), []);
    }
  });
});

describe("contentMatches — private AI scoring internals", () => {
  test("flags the private-scoring phrases (case-insensitive)", () => {
    for (const text of [
      "the PRIVATE PROMPT feeds the model",
      "adjust the private rubric",
      "raise the private threshold",
      "each corpus weight is tuned",
      "an accepted/rejected example pair",
      "an accepted rejected example pair",
    ]) {
      assert.deepEqual(contentMatches("src/score.mjs", text), [AI_INTERNALS]);
    }
  });

  test("does not flag ordinary prompt/score/threshold wording", () => {
    for (const text of [
      "the prompt asks for a subnet slug",
      "a completeness score of 80",
      "the alert threshold is 5 minutes",
    ]) {
      assert.deepEqual(contentMatches("src/score.mjs", text), []);
    }
  });
});

describe("contentMatches — provider-specific private model routes", () => {
  test("flags the word-anchored model-route tokens", () => {
    for (const text of [
      "binding = AI_GATEWAY",
      "env.WORKERS_AI.run(...)",
      "gpt-oss-20b",
    ]) {
      assert.deepEqual(contentMatches("workers/ai.mjs", text), [MODEL_ROUTE]);
    }
  });

  test("the @cf/openai/ alternative only fires with a preceding word char", () => {
    // The pattern's leading \b sits before `@` (a non-word char), so the
    // @cf/openai/ route matches only when a word char precedes it -- it does
    // NOT fire when quoted/space/`=`-prefixed as it usually appears in config.
    // Pinning this so a future regex change to close that gap is a deliberate,
    // visible edit rather than a silent behavior drift.
    assert.deepEqual(contentMatches("workers/ai.mjs", "use@cf/openai/gpt"), [
      MODEL_ROUTE,
    ]);
    assert.deepEqual(
      contentMatches("workers/ai.mjs", "'@cf/openai/whisper'"),
      [],
    );
  });

  test("does not flag unrelated AI/model wording", () => {
    for (const text of [
      "the public gateway is at api.metagraph.sh",
      "gpt is not referenced here",
      "@cf/meta/llama-3",
    ]) {
      assert.deepEqual(contentMatches("workers/ai.mjs", text), []);
    }
  });
});

describe("contentMatches — allow-listed mentions", () => {
  test("lets allow-listed files discuss the non-webhook patterns", () => {
    for (const file of allowedContentMentions) {
      assert.deepEqual(contentMatches(file, "the private prompt boundary"), []);
      assert.deepEqual(contentMatches(file, "binding = AI_GATEWAY"), []);
    }
  });

  test("a non-allow-listed file is still flagged for the same text", () => {
    assert.deepEqual(
      contentMatches("README.md", "the private prompt boundary"),
      [AI_INTERNALS],
    );
  });

  test("reports every distinct pattern a single line trips", () => {
    const line = "AI_GATEWAY routes the private rubric";
    assert.deepEqual(contentMatches("src/x.mjs", line).sort(), [
      AI_INTERNALS,
      MODEL_ROUTE,
    ]);
  });
});

describe("pathMatches — private implementation directories", () => {
  test("flags a private submission-gate directory anywhere in the tree", () => {
    for (const file of [
      "private-reviewer/index.mjs",
      "packages/review-corpus/data.json",
      "metagraphed-submission-gate-private/prompt.txt",
      "accepted-rejected-examples/001.json",
    ]) {
      assert.equal(pathMatches(file).length, 1);
    }
  });

  test("does not flag ordinary paths", () => {
    for (const file of [
      "src/graphql.mjs",
      "scripts/lib.mjs",
      "docs/review-guide.md",
    ]) {
      assert.deepEqual(pathMatches(file), []);
    }
  });
});

describe("isBinaryOrGenerated", () => {
  test("skips binary image files and the generated artifact tree", () => {
    for (const file of [
      "public/logo.png",
      "a/b.jpg",
      "a/b.jpeg",
      "a/b.gif",
      "a/b.webp",
      "a/b.ico",
      "public/metagraph/subnets.json",
    ]) {
      assert.equal(isBinaryOrGenerated(file), true);
    }
  });

  test("scans ordinary source and doc files", () => {
    for (const file of ["src/x.mjs", "README.md", "public/index.html"]) {
      assert.equal(isBinaryOrGenerated(file), false);
    }
  });
});

describe("regex inventory", () => {
  test("every content pattern has a name and a global-free regex", () => {
    assert.equal(contentPatterns.length, 3);
    for (const p of contentPatterns) {
      assert.equal(typeof p.name, "string");
      assert.ok(p.regex instanceof RegExp);
      // No `g` flag: contentMatches calls .test() repeatedly on fresh strings,
      // and a stateful lastIndex would make matches order-dependent.
      assert.ok(!p.regex.flags.includes("g"));
    }
  });
});

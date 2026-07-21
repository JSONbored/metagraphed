import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  allowedContentMentions,
  contentPatterns,
  isBinaryOrGenerated,
  isExemptFinding,
  pathPatterns,
} from "../scripts/lib/private-boundary-patterns.mjs";

// Every probe below is assembled from fragments (string concatenation) so this
// test file never itself contains a contiguous match -- validate-private-boundary.mjs
// is a CI gate that scans every git-tracked file, including this one, so a raw
// webhook URL / private-implementation phrase here would fail its own check.
const regexNamed = (patterns, name) =>
  patterns.find((pattern) => pattern.name === name).regex;

const discordRe = regexNamed(contentPatterns, "real Discord webhook URL");
const aiRe = regexNamed(contentPatterns, "private AI scoring internals");
const routeRe = regexNamed(
  contentPatterns,
  "provider-specific private model route",
);
const pathRe = regexNamed(
  pathPatterns,
  "private submission-gate implementation path",
);

describe("private-boundary contentPatterns: real Discord webhook URL", () => {
  test("matches a real-shaped webhook URL (>=20-char token)", () => {
    const url =
      "https://discord.com/api/webhooks/" +
      "112233445566778899/" +
      "z".repeat(24);
    assert.equal(discordRe.test(url), true);
  });

  test("matches the discordapp.com / canary host variants too", () => {
    assert.equal(
      discordRe.test(
        "https://discordapp.com/api/webhooks/" + "1/" + "y".repeat(20),
      ),
      true,
    );
    assert.equal(
      discordRe.test(
        "https://canary.discord.com/api/webhooks/" + "9/" + "w".repeat(30),
      ),
      true,
    );
  });

  test("does NOT match a webhook URL whose token is too short (<20 chars)", () => {
    const tooShort = "https://discord.com/api/webhooks/" + "112233/" + "abc123";
    assert.equal(discordRe.test(tooShort), false);
  });

  test("does NOT match an unrelated discord.com URL that isn't a webhook", () => {
    assert.equal(
      discordRe.test("https://discord.com/channels/" + "123/" + "456"),
      false,
    );
  });
});

describe("private-boundary contentPatterns: private AI scoring internals", () => {
  test("matches each private-scoring phrase", () => {
    assert.equal(aiRe.test("the " + "private" + " prompt" + " leaked"), true);
    assert.equal(aiRe.test("its " + "private" + " rubric"), true);
    assert.equal(aiRe.test("a " + "corpus" + " weight" + " of 0.4"), true);
    assert.equal(
      aiRe.test("an " + "accepted" + " rejected" + " example"),
      true,
    );
  });

  test("does NOT match a clearly-adjacent but different phrase", () => {
    // "private notebook" / "private matter" contain "private" but none of the
    // listed two-word phrases.
    assert.equal(aiRe.test("a " + "private" + " notebook"), false);
    // "\bprivate prompt\b" requires a word boundary -- "promptness" has none.
    assert.equal(aiRe.test("the " + "private" + " promptness"), false);
  });
});

describe("private-boundary contentPatterns: provider-specific private model route", () => {
  test("matches each provider-private token", () => {
    assert.equal(routeRe.test("export const " + "AI_" + "GATEWAY = 1"), true);
    assert.equal(routeRe.test("bind " + "WORKERS_" + "AI"), true);
    assert.equal(routeRe.test("route " + "@cf/" + "openai/" + "gpt-4"), true);
    assert.equal(routeRe.test("model " + "gpt-" + "oss-" + "20b"), true);
  });

  test("does NOT match a similarly-named unrelated identifier", () => {
    // "\bAI_GATEWAY\b" -- a trailing S breaks the word boundary, and an
    // unrelated MY_GATEWAY isn't in the alternation at all.
    assert.equal(routeRe.test("const " + "AI_" + "GATEWAYS = []"), false);
    assert.equal(routeRe.test("const " + "MY_" + "GATEWAY = 1"), false);
  });
});

describe("private-boundary pathPatterns: private implementation paths", () => {
  test("matches a private-implementation path segment", () => {
    assert.equal(pathRe.test("src/" + "private-reviewer" + "/index.ts"), true);
    assert.equal(pathRe.test("fixtures/" + "review-corpus"), true);
    assert.equal(
      pathRe.test("metagraphed-submission-gate-private" + "/x"),
      true,
    );
  });

  test("does NOT match an ordinary path that merely contains a similar word", () => {
    assert.equal(pathRe.test("src/reviewer/index.ts"), false);
    assert.equal(pathRe.test("docs/review-guide.md"), false);
  });
});

describe("private-boundary isExemptFinding allowlist carve-out", () => {
  test("exempts an allowlisted file from a NON-Discord finding", () => {
    assert.equal(
      isExemptFinding("CONTRIBUTING.md", "private AI scoring internals"),
      true,
    );
    assert.equal(
      isExemptFinding(
        "scripts/validate-private-boundary.mjs",
        "provider-specific private model route",
      ),
      true,
    );
  });

  test("NEVER exempts a real Discord webhook URL, even in an allowlisted file", () => {
    assert.equal(
      isExemptFinding("CONTRIBUTING.md", "real Discord webhook URL"),
      false,
    );
  });

  test("does NOT exempt a non-allowlisted file from any finding", () => {
    assert.equal(
      isExemptFinding("src/some-file.ts", "private AI scoring internals"),
      false,
    );
  });

  test("the allowlist contains the docs + pattern-defining files", () => {
    assert.equal(allowedContentMentions.has("CONTRIBUTING.md"), true);
    assert.equal(
      allowedContentMentions.has("scripts/lib/private-boundary-patterns.mjs"),
      true,
    );
  });
});

describe("private-boundary isBinaryOrGenerated", () => {
  test("treats image extensions and generated public artifacts as skip-able", () => {
    for (const file of [
      "a.png",
      "a.jpg",
      "a.jpeg",
      "a.gif",
      "a.webp",
      "a.ico",
      "public/metagraph/openapi.json",
    ]) {
      assert.equal(isBinaryOrGenerated(file), true, file);
    }
  });

  test("does not skip ordinary source/text files", () => {
    for (const file of [
      "src/index.ts",
      "scripts/x.mjs",
      "README.md",
      "public/other/thing.json",
    ]) {
      assert.equal(isBinaryOrGenerated(file), false, file);
    }
  });
});

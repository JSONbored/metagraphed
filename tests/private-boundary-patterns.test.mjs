// Unit tests for the leak-detection patterns behind the private-boundary CI
// gate (#7236) — extracted from scripts/validate-private-boundary.mjs into
// scripts/private-boundary-patterns.mjs so the regexes, the allowlist carve-out,
// and the binary/generated skip are verified directly rather than exercised for
// the first time against whatever a future PR happens to contain. Each content
// regex gets a matching case AND a clearly-adjacent non-matching case, since a
// too-narrow regex silently lets a real leak through and a too-broad one breaks
// legitimate PRs.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  contentPatterns,
  isAllowedContentMention,
  isBinaryOrGenerated,
  pathPatterns,
} from "../scripts/private-boundary-patterns.mjs";

const byName = (patterns, name) => {
  const found = patterns.find((p) => p.name === name);
  assert.ok(found, `expected a pattern named "${name}"`);
  return found.regex;
};

describe("contentPatterns — real Discord webhook URL", () => {
  const regex = byName(contentPatterns, "real Discord webhook URL");
  const TOKEN = "a".repeat(30); // well over the {20,} minimum

  test("matches a real-shaped webhook URL on each accepted host", () => {
    for (const host of [
      "discord.com",
      "discordapp.com",
      "canary.discord.com",
      "ptb.discord.com",
    ]) {
      assert.ok(
        regex.test(`https://${host}/api/webhooks/123456789012345678/${TOKEN}`),
        host,
      );
    }
  });

  test("does NOT match a token shorter than the {20,} requirement", () => {
    assert.equal(
      regex.test("https://discord.com/api/webhooks/123456789/short"),
      false,
    );
  });

  test("does NOT match a non-Discord host or a plain webhooks mention", () => {
    assert.equal(
      regex.test(`https://evil.example.com/api/webhooks/123/${TOKEN}`),
      false,
    );
    assert.equal(regex.test("see the discord webhooks docs"), false);
  });
});

describe("contentPatterns — private AI scoring internals", () => {
  const regex = byName(contentPatterns, "private AI scoring internals");

  test("matches each private-scoring phrase (case-insensitively)", () => {
    for (const phrase of [
      "private prompt",
      "private rubric",
      "private score",
      "private threshold",
      "corpus weight",
      "accepted rejected example",
      "accepted/rejected example",
      "Private Rubric", // case-insensitive
    ]) {
      assert.ok(regex.test(`the ${phrase} is secret`), phrase);
    }
  });

  test("does NOT match adjacent-but-innocent phrasing", () => {
    for (const phrase of [
      "public prompt",
      "private garden",
      "score threshold", // neither "private score" nor "private threshold"
      "corpus of weights",
    ]) {
      assert.equal(regex.test(`the ${phrase} here`), false, phrase);
    }
  });
});

describe("contentPatterns — provider-specific private model route", () => {
  const regex = byName(
    contentPatterns,
    "provider-specific private model route",
  );

  test("matches each private-route token", () => {
    // These three start with a word char, so a normal separator prefix works.
    for (const token of ["AI_GATEWAY", "WORKERS_AI", "gpt-oss-20b"]) {
      assert.ok(regex.test(`route: ${token}`), token);
    }
    // @cf/openai/ starts with a non-word char, so the pattern's leading \b needs
    // a word char immediately before it to fire (documents the shipped regex's
    // boundary behavior).
    assert.ok(
      regex.test("x@cf/openai/gpt-4"),
      "@cf/openai/ with a word-char prefix",
    );
  });

  test("does NOT match adjacent-but-unrelated identifiers", () => {
    for (const token of [
      "AIGATEWAY", // no underscore — a different identifier
      "MY_AI_GATEWAY_VALUE", // AI_GATEWAY embedded, no word boundary either side
      "gpt-oss", // missing the trailing dash the token requires
      "@cf/other/model", // not the openai route
    ]) {
      assert.equal(regex.test(`route: ${token}`), false, token);
    }
  });
});

describe("pathPatterns — private submission-gate implementation path", () => {
  const regex = byName(
    pathPatterns,
    "private submission-gate implementation path",
  );

  test("matches a private-implementation path segment", () => {
    for (const p of [
      "private-reviewer/index.mjs",
      "src/review-corpus/data.json",
      "metagraphed-submission-gate-private/x",
      "a/accepted-rejected-examples/b",
    ]) {
      assert.ok(regex.test(p), p);
    }
  });

  test("does NOT match an ordinary repo path", () => {
    for (const p of [
      "src/graphql.mjs",
      "scripts/lib.mjs",
      "docs/review-process.md", // "review" alone, not a private segment
    ]) {
      assert.equal(regex.test(p), false, p);
    }
  });
});

describe("isAllowedContentMention (allowlist carve-out)", () => {
  test("exempts allowlisted files from a NON-Discord finding", () => {
    assert.equal(
      isAllowedContentMention(
        "CONTRIBUTING.md",
        "private AI scoring internals",
      ),
      true,
    );
    assert.equal(
      isAllowedContentMention(
        "scripts/validate-private-boundary.mjs",
        "provider-specific private model route",
      ),
      true,
    );
  });

  test("NEVER exempts a real Discord webhook URL, even in an allowlisted file", () => {
    assert.equal(
      isAllowedContentMention("CONTRIBUTING.md", "real Discord webhook URL"),
      false,
    );
    assert.equal(
      isAllowedContentMention(
        "scripts/validate-private-boundary.mjs",
        "real Discord webhook URL",
      ),
      false,
    );
  });

  test("does not exempt a file that is not on the allowlist", () => {
    assert.equal(
      isAllowedContentMention(
        "src/whatever.mjs",
        "private AI scoring internals",
      ),
      false,
    );
  });
});

describe("isBinaryOrGenerated", () => {
  test("skips binary image extensions and the generated public/metagraph tree", () => {
    for (const f of [
      "a.png",
      "b.jpg",
      "c.jpeg",
      "d.gif",
      "e.webp",
      "f.ico",
      "public/metagraph/subnets.json",
    ]) {
      assert.equal(isBinaryOrGenerated(f), true, f);
    }
  });

  test("skips wrangler-generated worker-configuration.d.ts files (all 3 workers)", () => {
    for (const f of [
      "workers/worker-configuration.d.ts",
      "workers/data-api.worker-configuration.d.ts",
      "workers/registry-sync-api.worker-configuration.d.ts",
    ]) {
      assert.equal(isBinaryOrGenerated(f), true, f);
    }
  });

  test("does not skip ordinary source/text files", () => {
    for (const f of [
      "src/graphql.mjs",
      "README.md",
      "public/other/thing.json", // not under public/metagraph/
      "notes.png.txt", // .png not at the end
    ]) {
      assert.equal(isBinaryOrGenerated(f), false, f);
    }
  });
});

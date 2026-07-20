import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  BINARY_EXTENSIONS,
  GENERATED_PREFIXES,
  allowedContentMentions,
  contentPatterns,
  findContentPatternHits,
  findPathPatternHits,
  isBinaryOrGenerated,
  isContentFindingAllowed,
  pathPatterns,
} from "../scripts/lib/private-boundary.mjs";

// Build Discord webhook fixtures by concatenation so no single source line in
// THIS test file matches the Discord content regex (the CI gate still scans
// this file; Discord URLs are never allowlisted).
function discordWebhook({
  host = "discord.com",
  id = "123456789012345678",
  token = "abcdefghijklmnopqrstuvwxyz12",
} = {}) {
  return `https://${host}/api/webhooks/${id}/${token}`;
}

function patternByName(name) {
  const pattern = contentPatterns.find((entry) => entry.name === name);
  assert.ok(pattern, `missing content pattern: ${name}`);
  return pattern;
}

function pathPatternByName(name) {
  const pattern = pathPatterns.find((entry) => entry.name === name);
  assert.ok(pattern, `missing path pattern: ${name}`);
  return pattern;
}

describe("private-boundary contentPatterns (#7236)", () => {
  describe("real Discord webhook URL", () => {
    const name = "real Discord webhook URL";
    const pattern = patternByName(name);

    test("matches a real-shaped discord.com webhook URL", () => {
      const url = discordWebhook();
      assert.equal(pattern.regex.test(url), true);
      assert.deepEqual(
        findContentPatternHits(url).map((h) => h.name),
        [name],
      );
    });

    test("matches discordapp.com / canary / ptb hosts", () => {
      for (const host of [
        "discordapp.com",
        "canary.discord.com",
        "ptb.discord.com",
      ]) {
        assert.equal(
          pattern.regex.test(discordWebhook({ host })),
          true,
          `expected match for host ${host}`,
        );
      }
    });

    test("rejects a webhook URL whose token is shorter than 20 chars", () => {
      const short = discordWebhook({ token: "shorttoken123" }); // 13 chars
      assert.equal(pattern.regex.test(short), false);
      assert.deepEqual(findContentPatternHits(short), []);
    });

    test("rejects a malformed Discord URL (missing /api/webhooks/)", () => {
      const malformed =
        "https://discord.com/api/channels/123456789012345678/messages";
      assert.equal(pattern.regex.test(malformed), false);
    });

    test("rejects a non-Discord webhook-shaped URL", () => {
      const other =
        "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXX";
      assert.equal(pattern.regex.test(other), false);
    });

    test("rejects http (non-TLS) Discord webhook URLs", () => {
      const insecure = discordWebhook().replace("https://", "http://");
      assert.equal(pattern.regex.test(insecure), false);
    });
  });

  describe("private AI scoring internals", () => {
    const name = "private AI scoring internals";
    const pattern = patternByName(name);

    const matchingPhrases = [
      "private prompt",
      "Private Rubric",
      "private score",
      "private threshold",
      "corpus weight",
      "accepted rejected example",
      "accepted/rejected example",
    ];

    for (const phrase of matchingPhrases) {
      test(`matches ${JSON.stringify(phrase)}`, () => {
        pattern.regex.lastIndex = 0;
        assert.equal(pattern.regex.test(`using a ${phrase} here`), true);
      });
    }

    // Note: /\bprivate prompt\b/i does NOT match "private prompts" because of
    // the trailing 's' after the word boundary of "prompt". Lock that in.
    test('does not match plural "private prompts"', () => {
      pattern.regex.lastIndex = 0;
      assert.equal(pattern.regex.test("private prompts"), false);
    });

    const adjacentNonMatches = [
      "public prompt",
      "public rubric",
      "score privately",
      "threshold private",
      "corpus weights",
      "accepted rejected examples",
      "accepted-rejected example",
      "private-prompt",
      "privateprompt",
    ];

    for (const phrase of adjacentNonMatches) {
      test(`does not match adjacent non-leak ${JSON.stringify(phrase)}`, () => {
        pattern.regex.lastIndex = 0;
        assert.equal(pattern.regex.test(phrase), false, phrase);
      });
    }
  });

  describe("provider-specific private model route", () => {
    const name = "provider-specific private model route";
    const pattern = patternByName(name);

    // AI_GATEWAY / WORKERS_AI are \w+ identifiers — bare tokens match.
    test('matches bare "AI_GATEWAY"', () => {
      pattern.regex.lastIndex = 0;
      assert.equal(pattern.regex.test("AI_GATEWAY"), true);
    });

    test('matches bare "WORKERS_AI" (case-insensitive)', () => {
      pattern.regex.lastIndex = 0;
      assert.equal(pattern.regex.test("Workers_Ai"), true);
    });

    test("matches AI_GATEWAY bounded by punctuation", () => {
      pattern.regex.lastIndex = 0;
      assert.equal(pattern.regex.test("env.AI_GATEWAY=1"), true);
    });

    // @cf/openai/ and gpt-oss- start/end on non-word chars, so the surrounding
    // \b only fires when a word char sits on the outer side of those edges
    // (documented current behavior of the production regex — not tightened here).
    test("matches @cf/openai/ when flanked by word characters", () => {
      pattern.regex.lastIndex = 0;
      assert.equal(pattern.regex.test("x@cf/openai/y"), true);
    });

    test("matches gpt-oss- when a word character follows the trailing hyphen", () => {
      pattern.regex.lastIndex = 0;
      assert.equal(pattern.regex.test("gpt-oss-120b"), true);
    });

    test("does not match a bare @cf/openai/ token (no outer word boundaries)", () => {
      pattern.regex.lastIndex = 0;
      assert.equal(pattern.regex.test("@cf/openai/"), false);
    });

    test("does not match a bare gpt-oss- token (no trailing word char)", () => {
      pattern.regex.lastIndex = 0;
      assert.equal(pattern.regex.test("gpt-oss-"), false);
    });

    test("does not match AI_GATEWAY embedded inside a longer identifier", () => {
      pattern.regex.lastIndex = 0;
      assert.equal(pattern.regex.test("MY_AI_GATEWAY_HELPER"), false);
    });

    const adjacentNonMatches = [
      "AI_GATEWAYS",
      "WORKERS_AIRFLOW",
      "cf/openai/", // missing @
      "@cf/openai", // missing trailing slash
      "gpt-oss", // missing trailing hyphen
      "gpt_oss-",
      "OPENAI_GATEWAY",
      "WORKERS_API",
    ];

    for (const token of adjacentNonMatches) {
      test(`does not match adjacent non-leak ${JSON.stringify(token)}`, () => {
        pattern.regex.lastIndex = 0;
        assert.equal(pattern.regex.test(token), false, token);
      });
    }
  });
});

describe("private-boundary pathPatterns (#7236)", () => {
  const name = "private submission-gate implementation path";
  const pattern = pathPatternByName(name);

  const matchingPaths = [
    "private-reviewer/index.mjs",
    "src/private-reviewer/foo.js",
    "review-corpus",
    "review-corpus/weights.json",
    "packages/review-fixtures/a.json",
    "private-prompts/system.md",
    "docs/accepted-rejected-examples/README.md",
    "metagraphed-submission-gate-private/secrets.md",
    "PRIVATE-REVIEWER/X", // case-insensitive
  ];

  for (const file of matchingPaths) {
    test(`matches path ${JSON.stringify(file)}`, () => {
      assert.equal(pattern.regex.test(file), true);
      assert.equal(findPathPatternHits(file).length, 1);
    });
  }

  const nonMatchingPaths = [
    "scripts/validate-private-boundary.mjs",
    "scripts/lib/private-boundary.mjs",
    "private-reviewers-notes.md", // plural segment, not exact
    "review-corpuscular/theory.md",
    "src/review-corpus-builder.mjs",
    "public/metagraph/profiles.json",
    "README.md",
  ];

  for (const file of nonMatchingPaths) {
    test(`does not match path ${JSON.stringify(file)}`, () => {
      pattern.regex.lastIndex = 0;
      assert.equal(pattern.regex.test(file), false, file);
      assert.deepEqual(findPathPatternHits(file), []);
    });
  }
});

describe("allowedContentMentions carve-out (#7236)", () => {
  test("allowlist contains CONTRIBUTING.md, the validator, the lib module, and this test file", () => {
    assert.equal(allowedContentMentions.has("CONTRIBUTING.md"), true);
    assert.equal(
      allowedContentMentions.has("scripts/validate-private-boundary.mjs"),
      true,
    );
    assert.equal(
      allowedContentMentions.has("scripts/lib/private-boundary.mjs"),
      true,
    );
    assert.equal(
      allowedContentMentions.has("tests/validate-private-boundary.test.mjs"),
      true,
    );
  });

  test("non-Discord private phrases are suppressed in allowlisted files", () => {
    const line = "documents a private prompt and AI_GATEWAY for operators";
    const hits = findContentPatternHits(line, { file: "CONTRIBUTING.md" });
    assert.deepEqual(hits, []);
    assert.equal(
      isContentFindingAllowed(
        "CONTRIBUTING.md",
        "private AI scoring internals",
      ),
      true,
    );
    assert.equal(
      isContentFindingAllowed(
        "CONTRIBUTING.md",
        "provider-specific private model route",
      ),
      true,
    );
  });

  test("a real Discord webhook URL is NEVER suppressed, even in allowlisted files", () => {
    const url = discordWebhook();
    const hits = findContentPatternHits(url, {
      file: "scripts/lib/private-boundary.mjs",
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, "real Discord webhook URL");
    assert.equal(
      isContentFindingAllowed(
        "scripts/lib/private-boundary.mjs",
        "real Discord webhook URL",
      ),
      false,
    );
    assert.equal(
      isContentFindingAllowed("CONTRIBUTING.md", "real Discord webhook URL"),
      false,
    );
    assert.equal(
      isContentFindingAllowed(
        "tests/validate-private-boundary.test.mjs",
        "real Discord webhook URL",
      ),
      false,
    );
  });

  test("non-allowlisted files still report private phrases", () => {
    const hits = findContentPatternHits("uses a private rubric", {
      file: "src/mcp-server.mjs",
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].name, "private AI scoring internals");
  });
});

describe("isBinaryOrGenerated (#7236)", () => {
  test("exposes the exact extension + prefix lists", () => {
    assert.deepEqual(
      [...BINARY_EXTENSIONS],
      [".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"],
    );
    assert.deepEqual([...GENERATED_PREFIXES], ["public/metagraph/"]);
  });

  for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico"]) {
    test(`skips *${ext} files`, () => {
      assert.equal(isBinaryOrGenerated(`assets/logo${ext}`), true);
    });
  }

  test("skips every path under public/metagraph/", () => {
    assert.equal(isBinaryOrGenerated("public/metagraph/profiles.json"), true);
    assert.equal(
      isBinaryOrGenerated("public/metagraph/schemas/index.json"),
      true,
    );
  });

  test("does not skip ordinary source / docs / scripts", () => {
    for (const file of [
      "README.md",
      "scripts/validate-private-boundary.mjs",
      "scripts/lib/private-boundary.mjs",
      "tests/validate-private-boundary.test.mjs",
      "src/mcp-server.mjs",
      "public/agent.md",
      "assets/logo.svg",
      "photo.PNG.bak",
    ]) {
      assert.equal(isBinaryOrGenerated(file), false, file);
    }
  });

  test("empty / non-string inputs are not treated as binary", () => {
    assert.equal(isBinaryOrGenerated(""), false);
    assert.equal(isBinaryOrGenerated(null), false);
    assert.equal(isBinaryOrGenerated(undefined), false);
  });
});

describe("findContentPatternHits / findPathPatternHits helpers (#7236)", () => {
  test("returns [] for non-string input", () => {
    assert.deepEqual(findContentPatternHits(null), []);
    assert.deepEqual(findPathPatternHits(null), []);
  });

  test("can surface multiple content hits on one line", () => {
    const hits = findContentPatternHits(
      "private score via AI_GATEWAY for the corpus",
    );
    const names = hits.map((h) => h.name).sort();
    assert.deepEqual(names, [
      "private AI scoring internals",
      "provider-specific private model route",
    ]);
  });
});

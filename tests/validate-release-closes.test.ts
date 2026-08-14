// The gate that stops a release PR closing an unfinished issue (#11052).
//
// The network half is not mocked: `issueStates` is one `gh api` call per issue
// and the interesting behaviour is entirely in what gets EXTRACTED from the
// body. That is where the bug lived — release-please emits the markdown-LINKED
// form, so a parser that only matches `closes #123` reads the generated
// changelog as having no closing keywords at all and passes silently, which is
// exactly the failure this gate exists to prevent.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  formatOpenIssues,
  parseClosingKeywords,
} from "../scripts/validate-release-closes.ts";

describe("parseClosingKeywords", () => {
  test("MATCHES THE MARKDOWN-LINKED FORM release-please actually emits", () => {
    // The whole point. #11050's body read `closes [#10606](…/issues/10606)`,
    // and a `closes #\d+`-only pattern sees nothing there.
    const { sameRepo } = parseClosingKeywords(
      "* fix(chain): stop the refusal loop, closes " +
        "[#10606](https://github.com/JSONbored/metagraphed/issues/10606)",
    );
    assert.deepEqual(sameRepo, [10606]);
  });

  test("matches every closing keyword GitHub honours, case-insensitively", () => {
    for (const keyword of [
      "close",
      "closes",
      "closed",
      "fix",
      "fixes",
      "fixed",
      "resolve",
      "resolves",
      "resolved",
      "CLOSES",
      "Fixes",
    ]) {
      const { sameRepo } = parseClosingKeywords(`${keyword} #7`);
      assert.deepEqual(sameRepo, [7], `${keyword} must be honoured`);
    }
  });

  test("`Refs #N` is NOT a closing keyword", () => {
    // The distinction the whole issue turns on: `Refs` means the work is
    // partial. If this ever matched, the gate would fail every release that
    // advanced an issue without finishing it.
    const { sameRepo } = parseClosingKeywords(
      "* feat(api): partial capacity guard, Refs #10606\n* see also #999",
    );
    assert.deepEqual(sameRepo, []);
  });

  test("cross-repo keywords are counted, not treated as closers", () => {
    // `owner/repo#N` and issue URLs cannot close anything in THIS repo, so
    // failing a release for one would block on an issue the merge cannot touch.
    const parsed = parseClosingKeywords(
      "closes JSONbored/loopover#12 and " +
        "fixes https://github.com/JSONbored/loopover/issues/13 and closes #14",
    );
    assert.deepEqual(parsed.sameRepo, [14]);
    assert.equal(parsed.crossRepoCount, 2);
  });

  test("keywords inside fenced code blocks are ignored", () => {
    // GitHub ignores them too — a changelog quoting a commit message is showing
    // text, not asking for a close.
    const { sameRepo } = parseClosingKeywords(
      "```\ngit commit -m 'fix: thing, closes #1'\n```\ncloses #2",
    );
    assert.deepEqual(sameRepo, [2]);
  });

  test("results are deduped and ascending", () => {
    const { sameRepo } = parseClosingKeywords(
      "closes #30\nfixes #4\nresolves #30\ncloses [#12](x)",
    );
    assert.deepEqual(sameRepo, [4, 12, 30]);
  });

  test("a body with no closing keywords parses to nothing", () => {
    // Must not throw or invent: an empty result is a legitimate answer and is
    // what the common case (a release of pure chores) produces.
    assert.deepEqual(parseClosingKeywords("### Features\n* a thing (#123)"), {
      sameRepo: [],
      crossRepoCount: 0,
    });
    assert.deepEqual(parseClosingKeywords(""), {
      sameRepo: [],
      crossRepoCount: 0,
    });
  });

  test("`closes:` with a colon, and `<details>` nesting, both still count", () => {
    // GitHub honours keywords anywhere in the body, including inside collapsed
    // sections — which is where release-please puts the per-component changelog.
    const { sameRepo } = parseClosingKeywords(
      "<details><summary>metagraphed: 1.2.0</summary>\n\ncloses: #55\n\n</details>",
    );
    assert.deepEqual(sameRepo, [55]);
  });
});

describe("formatOpenIssues", () => {
  test("names each open issue and both remedies", () => {
    // A gate that says only "failed" makes the operator re-derive what this
    // script already knows.
    const out = formatOpenIssues([
      { number: 10606, state: "OPEN", title: "/api/v1/chain/stream 5xxs" },
    ]);
    assert.match(out, /#10606\s+\/api\/v1\/chain\/stream 5xxs/);
    assert.match(out, /finishing the issue/);
    assert.match(out, /`refs`/);
    // And the trap that wasted a round on #11050: hand-editing does not hold.
    assert.match(out, /release-please rewrites it/);
  });
});

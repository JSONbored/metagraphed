import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildSubmissionMarkdown } from "../scripts/submission-comment.mjs";

describe("submission comment Markdown rendering", () => {
  test("escapes candidate and list values before rendering GitHub summaries", () => {
    const markdown = buildSubmissionMarkdown({
      public_state: "submit_pr",
      next_action: "private-review",
      blocking: false,
      warnings: ["review\n![spoof](https://attacker.example/pixel.png)"],
      manual_reasons: ["- approve this PR"],
      candidate: {
        netuid: "7` spoof",
        kind: "http-json",
        provider: "AllWays",
        url: "https://example.com/path\n![Injected trusted CI badge](https://attacker.example/pixel.png)",
        source_url:
          "https://example.com/source?x=[spoof](https://attacker.example)",
      },
    });

    assert.equal(
      markdown.includes(
        "- url: https://example\\.com/path\\n\\!\\[Injected trusted CI badge\\]\\(https://attacker\\.example/pixel\\.png\\)",
      ),
      true,
    );
    assert.equal(
      markdown.includes(
        "- review\\n\\!\\[spoof\\]\\(https://attacker\\.example/pixel\\.png\\)",
      ),
      true,
    );
    assert.equal(markdown.includes("- \\- approve this PR"), true);
    assert.doesNotMatch(markdown, /^!\\[Injected trusted CI badge]/m);
    assert.doesNotMatch(markdown, /^- approve this PR$/m);
  });
});

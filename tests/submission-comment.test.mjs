import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildSubmissionMarkdown,
  findSubmissionComment,
} from "../scripts/submission-comment.mjs";

describe("submission comment Markdown rendering", () => {
  test("escapes candidate and list values before rendering GitHub summaries", () => {
    const markdown = buildSubmissionMarkdown({
      public_state: "submit_pr",
      next_action: "private-review",
      review_marker: "<!-- metagraphed-submission-gate -->",
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

    assert.match(markdown, /^<!-- metagraphed-submission-gate -->\n\n## /);
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

  test("escapes provider file and provider values before rendering", () => {
    const markdown = buildSubmissionMarkdown({
      public_state: "manual_review",
      next_action: "manual-review",
      blocking: false,
      direct_provider_file:
        "registry/providers/community/example-operator.json\n![spoof](https://attacker.example/pixel.png)",
      provider: {
        id: "example-operator",
        kind: "infrastructure-provider",
        website_url:
          "https://example.com\n![Injected trusted CI badge](https://attacker.example/pixel.png)",
      },
    });

    assert.equal(
      markdown.includes(
        "Provider file: registry/providers/community/example\\-operator\\.json\\n\\!\\[spoof\\]\\(https://attacker\\.example/pixel\\.png\\)",
      ),
      true,
    );
    assert.equal(
      markdown.includes(
        "- website: https://example\\.com\\n\\!\\[Injected trusted CI badge\\]\\(https://attacker\\.example/pixel\\.png\\)",
      ),
      true,
    );
    assert.doesNotMatch(markdown, /^!\\[Injected trusted CI badge]/m);
  });
});

describe("submission comment lookup", () => {
  test("stops paginating as soon as the actions bot marker comment is found", async () => {
    const calls = [];
    const github = mockGithubWithCommentPages(
      [
        [
          {
            id: 123,
            user: { type: "Bot", login: "github-actions[bot]" },
            body: "<!-- metagraphed-submission-gate -->\nready",
          },
        ],
        [
          {
            id: 456,
            user: { type: "User", login: "attacker" },
            body: "noise",
          },
        ],
      ],
      calls,
    );

    const comment = await findSubmissionComment(github, {
      owner: "JSONbored",
      repo: "metagraphed",
      issueNumber: 7,
    });

    assert.equal(comment.id, 123);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], {
      owner: "JSONbored",
      repo: "metagraphed",
      issue_number: 7,
      per_page: 100,
    });
  });

  test("bounds marker searches and ignores spoofed non-actions-bot comments", async () => {
    const calls = [];
    const github = mockGithubWithCommentPages(
      [
        [
          {
            id: 123,
            user: { type: "Bot", login: "not-actions[bot]" },
            body: "<!-- metagraphed-submission-gate -->",
          },
        ],
        [
          {
            id: 456,
            user: { type: "User", login: "github-actions[bot]" },
            body: "<!-- metagraphed-submission-gate -->",
          },
        ],
        [
          {
            id: 789,
            user: { type: "Bot", login: "github-actions[bot]" },
            body: "<!-- metagraphed-submission-gate -->",
          },
        ],
      ],
      calls,
    );

    const comment = await findSubmissionComment(github, {
      owner: "JSONbored",
      repo: "metagraphed",
      issueNumber: 7,
      maxPages: 2,
      perPage: 250,
    });

    assert.equal(comment, null);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].per_page, 100);
  });
});

function mockGithubWithCommentPages(pages, calls) {
  const listComments = () => {};
  return {
    rest: {
      issues: {
        listComments,
      },
    },
    paginate: {
      iterator(endpoint, options) {
        assert.equal(endpoint, listComments);
        return (async function* commentPages() {
          for (const page of pages) {
            calls.push(options);
            yield { data: page };
          }
        })();
      },
    },
  };
}

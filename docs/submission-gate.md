# Metagraphed Submission Gate

Metagraphed accepts community registry improvements through a public preflight
contract and a private review gate.

The public repo intentionally contains only deterministic validation, issue/PR
templates, broad labels, and safe reason categories. Private scoring prompts,
thresholds, corpus weights, and merge heuristics stay outside the public repo so
the gate is harder to game.

## Public States

- `submit_pr`: the submission shape is valid and ready for private review.
- `fix_required`: the submission is malformed, unsafe, duplicate, or out of
  scope.
- `route_away`: the PR is not a direct UGC submission and should use normal
  backend review.
- `manual_review`: the submission may be useful but needs human judgment.

## Labels

- `metagraphed-under-review`: the gate accepted the item for review.
- `metagraphed-manual-review`: the item needs human judgment.
- `metagraphed-closed-by-gate`: the gate closed a hard failure.
- `metagraphed-merged-by-gate`: the gate merged or imported a passing item.
- `metagraphed-import-approved`: an issue submission can open an import PR.

The stable marker comment is:

```html
<!-- metagraphed-submission-gate -->
```

## Direct PR Shape

Direct UGC PRs must change exactly one file:

```text
registry/candidates/community/<slug>.json
```

The file must contain exactly one candidate:

```json
{
  "schema_version": 1,
  "submission": {
    "submitted_by": "github-login",
    "submitted_by_url": "https://github.com/github-login"
  },
  "candidates": [
    {
      "schema_version": 1,
      "id": "community-sn-7-docs-example",
      "netuid": 7,
      "state": "schema-valid",
      "name": "Allways community docs example",
      "kind": "docs",
      "url": "https://docs.example.com",
      "source_url": "https://github.com/example/project",
      "source_urls": ["https://github.com/example/project"],
      "source_type": "community-pr-intake",
      "source_tier": "community-docs",
      "confidence": "medium",
      "provider": "community",
      "auth_required": false,
      "public_safe": true,
      "rate_limit_notes": "",
      "review_notes": "Community-submitted public interface candidate."
    }
  ]
}
```

Generated artifacts, scripts, workflows, package metadata, native snapshots,
private URLs, secrets, wallet/PAT data, and validator-local data are rejected.

## Private Gate Runtime

The private `metagraphed-submission-gate` should run on Cloudflare:

- Worker for GitHub App webhooks and protected queue/status routes.
- D1 for PR/issue state, verdicts, retry state, idempotency keys, and audit
  rows.
- R2 for redacted webhook payloads, probe evidence, and private review reports.
- Queues plus a dead-letter queue for async review jobs.
- Scheduled sweeper for stuck `validation_pending`, `merge_pending`, and
  retryable rows.

The public workflow job `metagraphed-submission-gate` only runs deterministic
preflight. It must not publish, merge, or expose private review details.

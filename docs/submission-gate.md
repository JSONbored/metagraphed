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

## Discord Notifications

Discord delivery belongs to the private Cloudflare gate runtime, not GitHub
Actions. The public repo only documents the contract and validates that secrets
and private reviewer internals are not tracked.

V1 sends one notification for terminal UGC decisions only:

- `merged`: the gate merged a clean direct PR or imported an approved issue.
- `closed`: the gate closed a hard failure.
- `manual-review`: the gate persisted a manual-review decision.
- `retry-exhausted`: automation stopped after retryable reviewer or platform
  failures exceeded the retry budget.

The gate should not notify for `route_away`, `submit_pr`, `fix_required`, or
normal backend/code PRs.

The Worker stores a `last_notification_key` in D1. The key must include the
target, PR head SHA or issue revision, terminal status, and verdict. Repeated
queue retries for the same head or issue revision must not send duplicate
Discord messages; a new PR head or edited issue revision may send a new terminal
notification.

The Discord webhook is configured only as a Worker secret:

```bash
wrangler secret put DISCORD_SUBMISSION_WEBHOOK_URL
```

Other private gate secrets are also Worker secrets:

- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_PRIVATE_KEY`
- `INTERNAL_SHARED_SECRET`
- private reviewer service credentials, if used

Discord embeds must be compact and public-safe. They can include the result,
netuid, interface kind, submitter, source URL, GitHub URL, and a short AI
rationale. They must strip marker comments, webhook URLs, wallet/PAT-like text,
private AI prompts, private scoring thresholds, corpus weights, and provider
model details.

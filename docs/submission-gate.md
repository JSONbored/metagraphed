# Metagraphed Submission Gate

Metagraphed accepts community registry improvements through a public preflight
contract and a private review gate.

The public repo intentionally contains only deterministic validation, issue/PR
templates, broad labels, and safe reason categories. Private scoring prompts,
thresholds, corpus weights, and merge heuristics stay outside the public repo so
the gate is harder to game.

Normal backend, docs, schema, workflow, and generated-artifact PRs are not UGC
submissions. The private gate should ignore them completely: no D1 row, no
marker comment, no Discord notification, and no AI content verdict.

## Public States

- `submit_pr`: the submission shape is valid and ready for private review.
- `fix_required`: the submission is malformed, unsafe, duplicate, or out of
  scope.
- `route_away`: the PR is not a direct UGC submission and should use normal
  backend review.
- `manual_review`: a state the **private reviewer** may assign when it chooses to
  escalate a submission for human judgment. The public preflight no longer
  pre-assigns it to whole risk classes — a schema-valid submission is handed to
  the autonomous reviewer as `submit_pr` with advisory risk signals
  (`manual_reasons`), and the reviewer decides merge / close / escalate (it
  defaults to close-or-escalate when in doubt and must never merge false data as
  real).

## Labels

- `metagraphed-under-review`: the gate accepted the item for review.
- `metagraphed-manual-review`: the item needs human judgment.
- `metagraphed-closed-by-gate`: the gate closed a hard failure.
- `metagraphed-merged-by-gate`: the gate merged or imported a passing item.
- `metagraphed-import-approved`: an issue submission can open an import PR.
- `profile-correction`: the issue is about subnet profile/source metadata such
  as official docs, websites, source repos, dashboards, or schema URLs.

The stable marker comment is:

```html
<!-- metagraphed-submission-gate -->
```

## Direct PR Shape

Direct UGC PRs must change exactly one candidate or provider review file, OR an
atomic provider+candidate **pair** (one of each):

```text
registry/candidates/community/<slug>.json
registry/providers/community/<slug>.json
```

The atomic pair is the **debut lane**: a first-time team registers its provider
and lands its first surface in a single PR. The inline provider counts as
registered for the candidate's checks, so no prior, separately-reviewed provider
PR is required. (Submitting a candidate alone that references an unregistered
provider is a non-terminal `fix_required` asking you to add the provider in the
same PR — it is never auto-closed.)

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
      "rate_limit": {
        "requests": 60,
        "window": "60s",
        "scope": "per-ip"
      },
      "review_notes": "Community-submitted public interface candidate."
    }
  ]
}
```

`rate_limit` is **optional** and integration-only — include it only when the
provider documents concrete limits. `requests` + `window` are required when the
object is present; `burst`, `scope` (`per-key` / `per-ip` / `global` /
`unknown`), and `cost_notes` are optional. metagraphed never enforces the limit
and it does not feed completeness — it's a machine-readable hint so agents and
SDKs can pace their calls. Leave it off when you only have prose, and use
`rate_limit_notes` for that.

`auth` is the same idea for credentials — `{ scheme, location?, name?, value_format?, token_url?, scopes_note? }` (only `scheme` is required: `none` / `bearer` / `api-key` / `basic` / `oauth2` / `custom`). It is auto-derived from a captured OpenAPI's `securitySchemes`, so curate it only to override or when no spec is captured. It drives the copy-paste auth header/param in the generated snippets. **Placeholders only — never a real key or token.**

Provider profile review files must contain exactly one provider profile:

```json
{
  "schema_version": 1,
  "submission": {
    "submitted_by": "github-login",
    "submitted_by_url": "https://github.com/github-login"
  },
  "provider": {
    "schema_version": 1,
    "id": "example-operator",
    "name": "Example Operator",
    "kind": "infrastructure-provider",
    "website_url": "https://example.com",
    "docs_url": "https://docs.example.com",
    "github_url": "https://github.com/example",
    "contact_url": "https://example.com/contact",
    "authority": "community",
    "public_notes": "Public-safe provider profile submission."
  }
}
```

Generated artifacts, scripts, workflows, package metadata, native snapshots,
private URLs, secrets, wallet/PAT data, and validator-local data are rejected.
Provider profile submissions are review inputs only; they cannot claim official
authority, directly modify canonical provider manifests, set endpoint health, or
make any endpoint pool-eligible.

Clean direct candidate PRs for public-safe app-layer surfaces can be
AI-reviewed by the private Metagraphed gate and merged directly by the GitHub
App after required public checks pass. Public preflight only decides whether a
submission is shaped correctly enough for private review; it does not expose AI
scoring, thresholds, prompts, examples, corpus weights, or model internals.

Direct provider profile PRs are handed to the private reviewer like any other
submission (`submit_pr`), carrying the `provider profile submissions require
review` advisory signal. They identify operators and can affect future endpoint
trust, so the reviewer scrutinizes identity and defaults to close/escalate when
in doubt — but a provider profile is no longer pre-blocked from autonomous merge.

Maintainer automation branches such as `codex/*` are ignored before D1 state,
labels, comments, AI review, or Discord notifications. Direct UGC examples
should use normal feature branches and exactly one candidate or provider file.

## Supported UGC Types

The public gate accepts or routes:

- subnet interface additions and corrections;
- subnet profile/source corrections for official websites, docs, source repos,
  dashboards, OpenAPI/schema URLs, SDKs, examples, and data artifacts;
- endpoint resource submissions for `subtensor-rpc`, `subtensor-wss`,
  `archive`, `subnet-api`, `openapi`, `sse`, `data-artifact`, `dashboard`,
  `docs`, `website`, `source-repo`, `sdk`, and `example`;
- provider/operator profile submissions;
- endpoint status reports;
- auth and rate-limit metadata corrections;
- adapter requests and evidence/provenance corrections.

Base-layer RPC/WSS/archive claims, unknown providers, authenticated APIs,
adapter requests, and conflicting source claims are handed to the autonomous
reviewer with advisory risk signals (`manual_reasons`) rather than pre-routed to
a maintainer. These are the highest-trust surfaces, so the reviewer scrutinizes
them hardest and defaults to close/escalate when evidence is thin — but the
public preflight no longer forces a human gate on the whole class.

Endpoint and status submissions can create candidates, reports, or re-probe
work. They cannot directly set observed uptime, latency, status, health class,
or pool eligibility; those values are generated only from Metagraphed probes and
adapter checks.

Profile/source corrections can improve `/api/v1/profiles`,
`/api/v1/review/profile-completeness`, and related gap reports after review.
They do not replace native chain identity, and they do not directly alter
observed endpoint health.

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

The private runtime makes the final UGC decision for every schema-valid
submission (`submit_pr`), returning a strict public-safe verdict object.
Deterministic hard guards still win over AI and block the PR at preflight
(`fix_required`): unsafe/private URLs, secrets, duplicates, generated-artifact
edits, and unsupported file shapes cannot reach the reviewer at all. Higher-trust
classes — base-layer RPC/WSS/archive claims, authenticated surfaces, owner
mismatches, and provider profiles — are NOT deterministic hard blocks; they reach
the reviewer as advisory `manual_reasons` so it can scrutinize them and, when in
doubt, close or escalate to `manual_review` rather than merge.

Production GitHub writes must use a GitHub App installation token. A fallback
`GITHUB_TOKEN` can exist for emergency/local testing only when the private
runtime explicitly enables `METAGRAPH_GATE_ALLOW_GITHUB_TOKEN_FALLBACK=true`.
Fallback-token mode is not production-ready because it is easier to rate-limit
and does not prove the app installation path works.

The private health endpoint exposes public-safe readiness fields:

- `github_app_configured`: true only when `GITHUB_APP_ID` and
  `GITHUB_APP_PRIVATE_KEY` are installed.
- `github_write_mode`: `github-app`, `fallback-token`, or `missing`.
- `production_ready`: true only when the required runtime pieces are present.
- `production_blockers`: broad blocker categories such as
  `github_app_credentials_missing`.

Operators can verify the public-safe readiness contract with:

```bash
npm run submission-gate:health
```

During setup, use this non-blocking form to inspect current blockers without
treating them as a passing production gate:

```bash
npm run submission-gate:health -- --allow-non-production
```

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

Reference PRs:

- AI-merged safe candidate example:
  https://github.com/JSONbored/metagraphed/pull/96
- Manual-review direct candidate example:
  https://github.com/JSONbored/metagraphed/pull/84
- Closed duplicate candidate example:
  https://github.com/JSONbored/metagraphed/pull/105

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
- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `INTERNAL_SHARED_SECRET`
- `PRIVATE_GATE_REVIEW_URL`
- private reviewer service credentials, if used

Discord embeds must be compact and public-safe. They can include the result,
netuid, interface kind, submitter, source URL, GitHub URL, and a short AI
rationale. They must strip marker comments, webhook URLs, wallet/PAT-like text,
private AI prompts, private scoring thresholds, corpus weights, and provider
model details.

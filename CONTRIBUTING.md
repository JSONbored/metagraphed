# Contributing To Metagraphed

Metagraphed is a backend-first operational registry for Bittensor subnet interfaces. The source of truth is reviewed JSON in this repo; generated artifacts under `public/metagraph` are projections of that source.

## Local Checks

Use Node 22.

```bash
npm ci
npm run pipeline:check
```

Before opening a PR that changes public contracts, also run:

```bash
npm run test:coverage
git diff --check
```

For smaller changes, run the focused checks that match the files you touched:

```bash
npm run validate
npm run validate:schemas
npm run validate:api
npm run validate:openapi
npm run worker:test
npm run scan:public-safety
```

## Registry Data Rules

- Native subnet existence comes from the Bittensor/Finney chain snapshot.
- Public interface metadata comes from curated overlays or reviewed candidate records.
- Third-party directories, docs, GitHub READMEs, and websites are enrichment sources only.
- Do not add secrets, PATs, wallet paths, private dashboards, private URLs, validator-local state, or credentialed API flows.
- Do not invent API/status surfaces for subnets that do not publish them.
- Preserve raw native chain values separately from curated display metadata.
- Treat duplicate `netuid + kind + URL` records as data-quality bugs.

## Community Intake

Community submissions can become candidates, not direct registry truth. There are
two supported paths:

- PR-first: add exactly one `registry/candidates/community/*.json` candidate
  document or exactly one `registry/providers/community/*.json` provider
  profile document and no other files.
- Issue-first: submit an `interface-submission`, `profile-correction`,
  `endpoint-submission`, `provider-submission`, or `status-report` issue and
  let the import/review workflow create the candidate PR after approval.
- Endpoint/provider/status issues: submit endpoint resources, provider profiles,
  or status reports through the matching issue template. These create review or
  re-probe work; they do not directly change observed health.

## What To Submit First

The most useful contributions are public operational facts that close real
registry gaps:

- official docs;
- official website;
- source repository;
- dashboard or explorer;
- OpenAPI/Swagger schema URL;
- public subnet API URL;
- SSE endpoint;
- public data artifact;
- SDK or example repository.

Start with subnets that are still profile-light: directory-only entries,
subnets missing websites or source repos, and subnets with public APIs that do
not yet have OpenAPI/schema metadata in Metagraphed.

Generate the current queue with:

```bash
npm run curation:brief
```

The curation playbook is in `docs/curation-playbook.md`.

Good direct candidate PRs are small: exactly one public URL, one public source
URL proving the claim, one active netuid, and no generated artifacts.

## Auto-Reviewed vs Manual

Safe direct candidate PRs can be AI-reviewed by the private Metagraphed gate and
may be merged automatically by the GitHub App after public checks pass. These
are usually app-layer or docs/data surfaces such as `docs`, `website`,
`source-repo`, `dashboard`, `openapi`, `subnet-api`, `sse`, `data-artifact`,
`sdk`, `example`, and `repo-registry`.

The gate still routes higher-risk or ambiguous submissions to manual review:

- provider/operator profiles;
- Bittensor base-layer `subtensor-rpc`, `subtensor-wss`, or `archive`
  endpoints;
- authenticated or paid APIs;
- unknown providers/operators;
- adapter requests;
- endpoint status reports;
- identity disputes or conflicting official sources.

Do not submit health, uptime, latency, incident, or pool-eligibility values.
Those are generated only from Metagraphed probes and adapters. Status reports
can trigger review or a future re-probe, but they cannot change observed
operational state directly.

You can generate a direct candidate PR file locally:

```bash
npm run candidate:new -- --netuid 7 --kind docs --url https://docs.all-ways.io/community-submission-example --source-url https://docs.all-ways.io/how-it-works.html --provider allways --submitted-by <github-login> --write
```

You can generate a direct provider profile review file locally:

```bash
npm run provider:new -- --id example-operator --name "Example Operator" --kind infrastructure-provider --website-url https://example.com --docs-url https://docs.example.com --github-url https://github.com/example --contact-url https://example.com/contact --submitted-by <github-login> --write
```

Example payloads live under `docs/examples/submissions`.
Useful examples include direct candidates, endpoint resources, OpenAPI/schema
URLs, provider profiles, profile/source corrections, and status reports.

Live PR references:

- AI-merged safe candidate example:
  https://github.com/JSONbored/metagraphed/pull/96
- Manual-review direct candidate example:
  https://github.com/JSONbored/metagraphed/pull/84
- Closed duplicate candidate example:
  https://github.com/JSONbored/metagraphed/pull/90

Do not include generated `public/metagraph/**` artifacts, native snapshots,
workflow/script changes, secrets, wallet/PAT material, private URLs, or
validator-local data in UGC submissions.

The public submission gate performs deterministic checks first:

- active Finney netuid;
- supported surface kind;
- registered provider;
- public-safe interface and source URLs;
- one candidate per submission;
- one provider profile per provider submission;
- no duplicate curated surface or candidate;
- submitter provenance for direct PRs;
- no generated artifact edits.

Provider profile submissions are review inputs only. They cannot claim official
authority, cannot make endpoints pool-eligible, and cannot directly edit
canonical `registry/providers/*.json` entries.

Passing public preflight routes the submission into private gate review. The
private reviewer may merge/import clean submissions, close hard failures, or
route rare edge cases to manual review. Public comments expose broad reason
categories only; private scoring prompts, thresholds, and corpus weights are not
part of the public repo.

Status reports never set uptime, latency, health status, incident state, or pool
eligibility. They can only trigger review or a future re-probe; operational state
comes from Metagraphed probes and adapters.

Profile/source corrections are welcome for official websites, docs, source
repos, dashboards, OpenAPI/schema URLs, SDKs, examples, or public data artifacts.
Approved corrections improve profile completeness and gap reports; they do not
override native chain state or observed endpoint health.

The issue import flow is:

1. Submit an `interface-submission` issue.
2. `intake:dry-run` parses and validates the issue.
3. The submission gate reviews source facts and safety.
4. The gate or a maintainer applies `metagraphed-import-approved`.
5. The import workflow opens a PR.
6. Normal validation plus gate review decide whether it merges.

Schema-valid does not mean accepted.

## Generated Artifacts

Avoid hand-editing `public/metagraph` unless you are correcting a stale derived artifact that cannot be regenerated without unrelated live-probe churn. Prefer changing canonical registry source and rebuilding.

Use:

```bash
npm run pipeline:refresh
```

for full local refreshes. Set `METAGRAPH_WRITE_PROBE_RESULTS=1` only when you intentionally want live probe artifacts updated.

Production publishes can require freshness gates:

```bash
METAGRAPH_REQUIRE_PROBE_HEALTH=1 METAGRAPH_REQUIRE_FRESHNESS=1 npm run validate
```

Freshness is exposed in `/metagraph/freshness.json` and `/api/v1/freshness`.
Required publish lanes include native subnet data, candidate discovery,
candidate verification, probe-derived health, and adapter snapshots.

## Pull Requests

- Use short, focused PRs with Conventional Commit-style titles.
- Include the relevant validation commands in the PR body.
- Do not include local paths, machine-specific setup, raw environment dumps, or private research notes.
- Keep UI/frontend work out of this repo; this repo owns backend data contracts and generated JSON.

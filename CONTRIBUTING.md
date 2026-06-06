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

Issue submissions can become candidates, not direct registry truth.

The import flow is:

1. Submit an `interface-submission` issue.
2. `intake:dry-run` parses and validates the issue.
3. A maintainer reviews source facts and safety.
4. A maintainer applies `metagraphed-import-approved`.
5. The import workflow opens a PR.
6. Normal validation and review decide whether it merges.

Schema-valid does not mean accepted.

## Generated Artifacts

Avoid hand-editing `public/metagraph` unless you are correcting a stale derived artifact that cannot be regenerated without unrelated live-probe churn. Prefer changing canonical registry source and rebuilding.

Use:

```bash
npm run pipeline:refresh
```

for full local refreshes. Set `METAGRAPH_WRITE_PROBE_RESULTS=1` only when you intentionally want live probe artifacts updated.

## Pull Requests

- Use short, focused PRs with Conventional Commit-style titles.
- Include the relevant validation commands in the PR body.
- Do not include local paths, machine-specific setup, raw environment dumps, or private research notes.
- Keep UI/frontend work out of this repo; this repo owns backend data contracts and generated JSON.

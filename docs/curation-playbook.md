# Metagraphed Curation Playbook

Metagraphed already lists every active Finney netuid. Curation work is about
turning machine-verified baseline entries into stronger public operational
profiles, one verified fact at a time.

## Generate The Current Queue

```bash
npm run curation:brief
```

Use `-- --limit 20` for a longer Markdown queue, or `-- --json` for a
machine-readable snapshot:

```bash
npm run curation:brief -- --limit 20
npm run curation:brief -- --json
```

The brief reads existing registry review artifacts:

- `public/metagraph/review/enrichment-queue.json`
- `public/metagraph/review/profile-completeness.json`
- `public/metagraph/review/gap-priorities.json`
- `public/metagraph/review/adapter-candidates.json`
- `public/metagraph/coverage.json`

The enrichment queue is also available through
`/api/v1/review/enrichment-queue` for backend consumers. It does not create new
registry truth; it only prioritizes public-safe work derived from current
artifacts.

## What Fully Curated Means

For each subnet, aim to confirm the maximum public surface set the subnet
actually supports:

- official docs;
- official website;
- source repository;
- dashboard or explorer;
- OpenAPI/Swagger JSON URL;
- public subnet API;
- SSE endpoint;
- public data artifact;
- SDK or example repository;
- auth and rate-limit notes where public.

Some subnets may only have docs and a website. That is acceptable if the gaps
are explicit and source-backed. Do not invent API surfaces to make entries look
complete.

## Best Auto-Review Contributions

Direct PRs should add exactly one candidate file under
`registry/candidates/community/*.json` and no generated artifacts.

Use:

```bash
npm run candidate:new -- --netuid <netuid> --kind <kind> --url <public-url> --source-url <source-url> --provider <provider> --submitted-by <github-login> --write
```

Best candidate kinds:

- `docs`
- `website`
- `source-repo`
- `dashboard`
- `openapi`
- `subnet-api`
- `sse`
- `data-artifact`
- `sdk`
- `example`

## Manual Review Contributions

These are useful, but they should not auto-merge:

- provider/operator profiles;
- Bittensor base-layer RPC/WSS/archive endpoints;
- authenticated or paid APIs;
- unknown providers;
- adapter requests;
- identity disputes;
- endpoint status reports.

## Health Boundary

Health, uptime, latency, incidents, and pool eligibility are probe-derived only.
Contributor reports can trigger review or re-probes, but they cannot set
observed health directly.

## Curation Order

1. Start with the enrichment queue from `npm run curation:brief`.
2. Prefer `direct-submission` rows for contributor PRs.
3. Route `maintainer-review`, `adapter-candidate`, and `monitoring-followup`
   rows through maintainer review.
4. Submit official docs, website, or source repo evidence before optional app
   surfaces.
5. Add API/OpenAPI/SSE/data surfaces only when the subnet publicly exposes
   them.
6. Use the adapter-candidate queue after baseline identity and operational
   surfaces are strong.
7. Promote entries to maintainer-reviewed only after provenance is strong.

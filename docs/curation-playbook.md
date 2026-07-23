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
- `public/metagraph/review/enrichment-targets.json`
- `public/metagraph/review/profile-completeness.json`
- `public/metagraph/review/gap-priorities.json`
- `public/metagraph/review/adapter-candidates.json`
- `public/metagraph/coverage.json`

The enrichment queue is also available through
`/api/v1/review/enrichment-queue` for backend consumers. It does not create new
registry truth; it only prioritizes public-safe work derived from current
artifacts.

For the single maintainer/agent view of "which subnets should we enrich next
and why?", use `/api/v1/coverage-depth`. It combines callable-service,
schema, fixture, example/SDK, provenance, profile, and `agent_readiness`
signals into one ranked queue while preserving separate missing-data,
needs-review, and hard-blocker gap types.

Contributor-ready targets are available through
`/api/v1/review/enrichment-targets`. This route groups the queue into concrete
surface-candidate, adapter-review, maintainer-review, and monitoring-followup
targets, including copyable `npm run surface:add` command templates for
direct public-safe submissions.

Detailed candidate evidence behind the queue is available through
`/api/v1/review/enrichment-evidence`. That route is R2-backed so full
per-kind candidate classifications do not create noisy Git diffs.

Queue entries include `evidence_action` so contributors and maintainers can
avoid duplicate work:

- `submit-new-evidence`: no useful candidate exists for the target gap yet;
- `verify-existing-evidence`: candidate records exist, but recurring
  verification has not produced a live classification yet;
- `replace-stale-evidence`: candidates exist, but current verification did not
  produce live registry truth;
- `review-existing-evidence`: live or redirected candidates exist and need
  source review before promotion;
- `maintainer-review-existing-evidence`: the entry belongs in maintainer or
  adapter review instead of a direct contributor PR;
- `monitor`: no immediate enrichment action is available.

Queue rows include a compact `candidate_evidence_summary`; the detailed
`candidate_evidence_by_kind` map lives in the evidence artifact. This is
guidance only; health, uptime, latency, and pool eligibility remain
probe-derived.

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

Direct PRs should change exactly one `registry/subnets/<slug>.json` file and no
generated artifacts. Existing subnet manifests should only append surface(s) to
their `surfaces[]` array. If the subnet has no manifest yet, run
`npm run subnet:new` first, then add the surface(s) to that same new file. The
per-candidate-file lane (`registry/candidates/community/*.json`) is retired and
rejected by CI.

Use:

```bash
npm run surface:add -- --netuid <netuid> --kind <kind> --url <public-url> --source-url <source-url> --provider <provider> --submitted-by <github-login> --write
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
2. Prefer `surface-candidate` rows from the enrichment target pack for
   contributor PRs.
3. Route `maintainer-review`, `adapter-candidate`, and `monitoring-followup`
   rows through maintainer review.
4. Submit official docs, website, or source repo evidence before optional app
   surfaces.
5. Add API/OpenAPI/SSE/data surfaces only when the subnet publicly exposes
   them.
6. Use the adapter-candidate queue after baseline identity and operational
   surfaces are strong.
7. Promote entries to maintainer-reviewed only after provenance is strong.

## Maintainer Review & Trust Elevation

`registry/reviews/maintainer-reviewed.json` is the single source of truth for the
`maintainer-reviewed` trust tier. `validate.ts` fails CI if any overlay sits at
`curation.level: maintainer-reviewed` without a backing decision there, so the tier
is reached ONLY by adding a decision — never by hand-editing `curation.level` in a
`registry/subnets/*.json` overlay.

To find what to elevate next, run:

```bash
npm run review:queue
```

This regenerates `registry/reviews/review-queue.json`: subnets whose callable API
(`openapi`/`subnet-api`) is verified live AND hosted on the subnet's own
on-chain-asserted domain (Subtensor `SubnetIdentitiesV3.subnet_url`) but that are
not yet at the top trust tier. These have strong provenance — the chain vouches for
the domain and the API probed live — so they are one-confirm elevations: copy an
entry into `maintainer-reviewed.json` after a quick check. The queue is a pure,
drift-checked transform of committed data; the machine proposes, the maintainer
disposes (it never auto-writes the human tier).

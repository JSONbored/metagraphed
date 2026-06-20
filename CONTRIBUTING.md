# Contributing to Metagraphed

Metagraphed is the Bittensor subnet integration registry — every subnet, metagraphed. This is the backend: a Cloudflare Worker API plus Node build scripts. **JSON Schema is the canonical contract** → OpenAPI → typed clients. Generated artifacts under `public/metagraph/` are projections of reviewed source, never hand-authored truth.

Live: [metagraph.sh](https://metagraph.sh) · API [api.metagraph.sh](https://api.metagraph.sh) · License AGPL-3.0 (Apache-2.0 client SDKs)

Two kinds of contribution, two paths:

- **Code / schema changes** → normal feature PR, run the gates below.
- **Community data** → one candidate JSON file, see [Community submissions](#community-submissions).

## Setup & gates

Use Node 22.

```bash
npm install
npm test
npm run validate
npm run build
```

`npm run validate` runs schema, API, and OpenAPI checks. For a full local data pipeline run, use `npm run pipeline:check`. Match focused checks to what you touch (`npm run validate:schemas`, `validate:api`, `validate:openapi`, `worker:test`) rather than running everything.

## Schema-first rule

The contract is generated, so you never edit it by hand:

1. Edit the source under `schemas/` or `schemas/components/`.
2. Run `npm run build` to regenerate `openapi.json` and the types/clients.
3. **Commit the regenerated artifacts in the same PR.**

Skipping the rebuild trips `validate:contract-drift` in CI. Schemas are the source of truth; everything downstream follows.

## Where to start

- **Enrich a subnet** (the best first PR) — we track one scoped task per subnet under the [surface-enrichment epic #427](https://github.com/JSONbored/metagraphed/issues/427). Browse [`good first issue`](https://github.com/JSONbored/metagraphed/labels/good%20first%20issue) + [`help wanted`](https://github.com/JSONbored/metagraphed/labels/help%20wanted): pick a subnet, find its real public API / OpenAPI / data artifact, and submit one candidate file ([Community submissions](#community-submissions) below). Each issue links the exact `candidate:new` command.
- **Data gaps** — generate the current curation queue: `npm run curation:brief` (add `-- --limit 20` for more, `-- --json` for machine-readable). Start with profile-light subnets: directory-only entries, missing websites or source repos, public APIs with no OpenAPI metadata yet. See [`docs/curation-playbook.md`](docs/curation-playbook.md).

## Community submissions

Community data becomes a reviewed **candidate**, not direct registry truth. PR-first is the simplest path:

> Add **exactly one** file — `registry/candidates/community/*.json` (a candidate) **or** `registry/providers/community/*.json` (a provider profile) — and **nothing else**. No generated artifacts. First-time team? Add **both** in one PR (an atomic provider+candidate pair): the inline provider counts as registered, so your debut provider and first surface land together — no separate, pre-approved provider PR needed.

Generate a candidate locally — three steps:

```bash
# 1. Find the provider slug for the team/operator behind this surface.
#    (No match? Register one in the same PR with `npm run provider:new`.)
npm run providers:list

# 2. Generate the candidate with a REAL --provider slug (a placeholder like
#    "community" is not a registered provider and will fail validation).
npm run candidate:new -- \
  --netuid 7 --kind docs \
  --url https://docs.example.com \
  --source-url https://github.com/example/project \
  --provider <provider-slug> --submitted-by <github-login> --write

# 3. Check it before pushing — a fast local pre-check that catches schema +
#    provider-slug mistakes without the full build (CI runs the full validate).
npm run validate:candidate -- registry/candidates/community/<your-file>.json
```

A good candidate PR is small: one public URL, one source URL proving the claim, one active netuid, no generated files. Best kinds (these can be auto-reviewed): `docs`, `website`, `source-repo`, `dashboard`, `openapi`, `subnet-api`, `sse`, `data-artifact`, `sdk`, `example`.

**Higher-trust kinds** (provider/operator profiles, base-layer `subtensor-rpc`/`subtensor-wss`/`archive` endpoints, authenticated or paid APIs, unknown providers, adapter requests, status reports, identity disputes) are also welcome and no longer need a maintainer: they go to the same autonomous reviewer, which scrutinizes identity/evidence harder and, when in doubt, closes or escalates rather than merging. Make the proof airtight (an independent `source_url` proving ownership) and they can merge like any other surface.

**Hard boundaries:**

- Health, uptime, latency, incidents, and pool eligibility are **probe-derived only**. Reports can trigger a re-probe; they can never set observed state.
- No secrets, PATs, wallet paths, private URLs, or validator-local data.
- Don't invent API/status surfaces a subnet doesn't publish.
- Schema-valid ≠ accepted. A private review gate makes the final call.

**Accepted vs rejected at a glance** — the visible checklist (the final merge decision is the review gate's):

| ✅ Tends to get accepted                                                                                             | ❌ Gets closed / routed to manual                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Exactly one `registry/candidates/community/*.json` (or `providers/community/*.json`)                                 | Touches generated artifacts, scripts, or workflows ([#296](https://github.com/JSONbored/metagraphed/pull/296)) |
| A public `url` **plus** a `source_url` that proves the claim                                                         | `source_url` 404s or doesn't back the claim ([#328](https://github.com/JSONbored/metagraphed/pull/328))        |
| An auto-review `kind` (docs, website, source-repo, openapi, subnet-api, dashboard, sse, data-artifact, sdk, example) | A surface the subnet already exposes — duplicate ([#90](https://github.com/JSONbored/metagraphed/pull/90))     |
| `auth_required: false`, `public_safe: true`, an active netuid, a registered provider (or one added in the same PR)   | Secrets/PATs/wallet paths, private/localhost URLs, or unproven ownership claims                                |

A clean accepted example to copy: [#87](https://github.com/JSONbored/metagraphed/pull/87).

Prefer issues? Use the `interface-submission`, `profile-correction`, `endpoint-submission`, `provider-submission`, or `status-report` template — an approved issue opens the candidate PR for you. Full contract in [`docs/submission-gate.md`](docs/submission-gate.md).

Callable surface with documented limits? Add an optional structured `rate_limit` — `{ requests, window, burst?, scope?, cost_notes? }` (`requests` + `window` required) — so agents and SDKs can pace calls. It's integration-only: metagraphed never enforces it and it doesn't feed completeness. See the example in [`docs/submission-gate.md`](docs/submission-gate.md).

## Pull requests

- Short and focused, Conventional Commit-style titles.
- Include the validation commands you ran in the PR body.
- No local paths, machine-specific setup, env dumps, or private notes.
- Keep UI/frontend work out of this repo — it owns backend data contracts and generated JSON. The web app lives at [metagraphed-ui](https://github.com/JSONbored/metagraphed-ui).

## Deeper docs

- [`docs/submission-gate.md`](docs/submission-gate.md) — full community submission contract.
- [`docs/curation-playbook.md`](docs/curation-playbook.md) — what to curate and in what order.
- [`docs/api-stability.md`](docs/api-stability.md) — API/contract stability guarantees.

By contributing you agree your work is released under the repository's [AGPL-3.0 License](LICENSE) — or Apache-2.0 for contributions to the client SDKs under `packages/client/` and `python/`.

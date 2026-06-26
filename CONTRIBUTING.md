# Contributing to Metagraphed

Metagraphed is the Bittensor subnet integration registry — every subnet, metagraphed. This is the backend: a Cloudflare Worker API plus Node build scripts. **JSON Schema is the canonical contract** → OpenAPI → typed clients. Generated artifacts under `public/metagraph/` are projections of reviewed source, never hand-authored truth.

Live: [metagraph.sh](https://metagraph.sh) · API [api.metagraph.sh](https://api.metagraph.sh) · License AGPL-3.0 (Apache-2.0 client SDKs)

Two kinds of contribution, two paths:

- **Code / schema changes** → normal feature PR, run the gates below.
- **Community data** → add a surface to one subnet file, see [Community submissions](#community-submissions).

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

- **Enrich a subnet** (the best first PR) — we track one scoped task per subnet under the [surface-enrichment epic #427](https://github.com/JSONbored/metagraphed/issues/427). Browse [`good first issue`](https://github.com/JSONbored/metagraphed/labels/good%20first%20issue) + [`help wanted`](https://github.com/JSONbored/metagraphed/labels/help%20wanted): pick a subnet, find its real public API / OpenAPI / data artifact, and add it as a surface on the subnet's file ([Community submissions](#community-submissions) below). Each issue links the exact `surface:add` command.
- **Data gaps** — generate the current curation queue: `npm run curation:brief` (add `-- --limit 20` for more, `-- --json` for machine-readable). Start with profile-light subnets: directory-only entries, missing websites or source repos, public APIs with no OpenAPI metadata yet. See [`docs/curation-playbook.md`](docs/curation-playbook.md).

## Community submissions

Surfaces live in **one file per subnet**: `registry/subnets/<slug>.json` → its `surfaces[]` array. A community contribution **adds a surface to that one file** — `npm run surface:add` writes it with `authority: "community"` and `review.state: "community-submitted"`. There is no per-surface candidate file anymore (recreating `registry/candidates/community/*.json` is rejected by CI), so you can't farm one surface per PR: **one subnet = one file = one PR.**

> Change **only** the one `registry/subnets/<slug>.json` — no generated artifacts. First-time provider? Pass `--provider-name` + `--provider-url` and `surface:add` scaffolds the `registry/providers/<slug>.json` stub for you in the same PR; provider identity still gets reviewed before it's trusted.

> **Plagiarism is not tolerated.** Copying another contributor's PR, surface, or work and submitting it as your own — including duplicated or lightly reworded copies filed under a different account — is a hard violation. Don't copy others to farm Gittensor rewards: anyone attempting to cheat or copy for gain is **permanently blocked from contributing across all of our repositories**. See [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Add a surface locally — three steps:

```bash
# 1. Find the provider slug for the team/operator behind this surface.
npm run providers:list

# 2. Append the surface to the subnet's file with a REAL --provider slug.
#    Debut provider? Add --provider-name + --provider-url and surface:add also
#    scaffolds registry/providers/<slug>.json so the PR validates in one shot.
npm run surface:add -- \
  --netuid 7 --kind docs \
  --url https://docs.example.com \
  --source-url https://github.com/example/project \
  --provider <provider-slug> --submitted-by <github-login> --write
  # debut provider: --provider-name "Example Team" --provider-url https://example.com

# 3. Check it before pushing — a fast local pre-check (schema + provider slug +
#    review-state + real subnet name) without the full build (CI runs full validate).
npm run validate:surface -- registry/subnets/<slug>.json
```

> New subnet with no file yet? `npm run subnet:new -- --netuid <n> --name "<Real Name>" --write` first — a real `--name` is required (placeholder on-chain identities like "Team TBC" are rejected) — then add your surface to it.

A good surface PR is small: one public `url`, one `source_url` proving the claim, the right `kind`, all on the subnet's single file. Auto-review kinds: `docs`, `website`, `source-repo`, `dashboard`, `openapi`, `subnet-api`, `sse`, `data-artifact`, `sdk`, `example`.

**Higher-trust kinds** (base-layer `subtensor-rpc`/`subtensor-wss`/`archive` endpoints, authenticated or paid APIs, unknown providers, identity disputes) are welcome too — the autonomous reviewer scrutinizes identity/evidence harder and, when in doubt, closes or escalates rather than merging. Make the proof airtight (an independent `source_url` proving ownership).

**Hard boundaries:**

- Health, uptime, latency, incidents, and pool eligibility are **probe-derived only** — never hand-set them (or a surface's `verification`). The build's prober owns them.
- No secrets, PATs, wallet paths, private URLs, or validator-local data.
- Don't invent API/status surfaces a subnet doesn't publish.
- Schema-valid ≠ accepted. The review gate makes the final call.

**Accepted vs rejected at a glance** — the visible checklist (the final merge decision is the review gate's):

| ✅ Tends to get accepted                                                                                          | ❌ Gets closed / routed to manual                                                                    |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Exactly one `registry/subnets/<slug>.json` changed (+ an optional `providers/*.json` for a debut)                 | Touches generated artifacts, scripts, or workflows                                                   |
| A surface with a public `url` **plus** a `source_url` that proves the claim                                       | `source_url` 404s or doesn't back the claim                                                          |
| `authority: community` + `review.state: community-submitted`, an auto-review `kind`, an active netuid, a provider | A surface the subnet already exposes — duplicate                                                     |
| `auth_required: false`, `public_safe: true`                                                                       | Secrets/PATs/wallet paths, private/localhost URLs, unproven ownership, or a recreated candidate file |

Callable surface with documented limits? Add an optional structured `rate_limit` — `{ requests, window, burst?, scope?, cost_notes? }` (`requests` + `window` required) — so agents and SDKs can pace calls. It's integration-only: metagraphed never enforces it and it doesn't feed completeness.

## Pull requests

- Short and focused, Conventional Commit-style titles.
- Include the validation commands you ran in the PR body.
- No local paths, machine-specific setup, env dumps, or private notes.
- Keep UI/frontend work out of this repo — it owns backend data contracts and generated JSON. The web app lives at [metagraphed-ui](https://github.com/JSONbored/metagraphed-ui).

## Deeper docs

- [`docs/curation-playbook.md`](docs/curation-playbook.md) — what to curate and in what order.
- [`docs/api-stability.md`](docs/api-stability.md) — API/contract stability guarantees.
- [`docs/adr/`](docs/adr/) — architecture decision records (why the system is built this way); [`RELEASING.md`](RELEASING.md) — the release runbook.

By contributing you agree your work is released under the repository's [AGPL-3.0 License](LICENSE) — or Apache-2.0 for contributions to the client SDKs under `packages/client/` and `python/`.

---
title: Contributing surfaces
description: Add or enrich a subnet's public interfaces in one file, one PR.
---

# Contributing surfaces

The most common contribution is **enriching a subnet** — registering a real public API, OpenAPI spec, docs site, dashboard, SDK, or data artifact. Surfaces live in **one file per subnet**:

```text
registry/subnets/<slug>.json
```

A PR touches **exactly that one file** (plus an optional debut `registry/providers/<slug>.json` when the provider is new). Never split a subnet across multiple PRs, never add generated artifacts, and never hand-set health or verification — the build prober owns those.

## Find a gap

1. Browse [`good first issue`](https://github.com/JSONbored/metagraphed/labels/good%20first%20issue) and the [surface-enrichment epic #427](https://github.com/JSONbored/metagraphed/issues/427).
2. Run `npm run curation:brief` locally for profile-light subnets missing docs, OpenAPI, or public APIs.
3. Search open PRs first — duplicates are auto-closed.

## Prove the surface

Every surface needs:

- A public **`url`** that resolves (no auth for auto-review kinds)
- A **`source_url`** that independently proves the subnet/operator publishes it (official README, provider site, on-chain identity link that still works)

Schema-valid is not enough — the review gate verifies ownership and freshness.

## Add the surface

```bash
npm run providers:list

npm run surface:add -- \
  --netuid 7 --kind openapi \
  --url https://docs.example.com/openapi.json \
  --source-url https://github.com/example/project/blob/main/README.md \
  --provider <provider-slug> --submitted-by <github-login> --write

npm run validate:surface -- registry/subnets/<slug>.json
npm run scan:public-safety
```

New subnet with no manifest yet?

```bash
npm run subnet:new -- --netuid <n> --name "<Real Name>" --write
# then surface:add into the same file
```

Each community surface carries `authority: "community"` and `review.state: "community-submitted"`. Callable kinds (`openapi`, `subnet-api`, `sse`, `data-artifact`, `sdk`) are high value; `source-repo` and `website` are often auto-promoted from chain identity — check before submitting.

## Hard boundaries

- No secrets, PATs, wallet paths, or private/localhost URLs anywhere
- No hand-set health, uptime, latency, or `verification`
- One focused PR — do not mix code/schema changes with surface data

Full maintainer guide: [CONTRIBUTING.md](https://github.com/JSONbored/metagraphed/blob/main/CONTRIBUTING.md) · curation playbook: [`docs/curation-playbook.md`](https://github.com/JSONbored/metagraphed/blob/main/docs/curation-playbook.md).

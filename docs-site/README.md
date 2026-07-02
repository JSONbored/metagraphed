# Developer docs site (source content)

Version-controlled content for **[docs.metagraph.sh](https://docs.metagraph.sh)** — the first-party developer docs site tracked in [#1652](https://github.com/JSONbored/metagraphed/issues/1652).

Rendering and the interactive API playground UI live in [metagraphed-ui](https://github.com/JSONbored/metagraphed-ui); **this directory is the content + auto-generation source** in the backend repo.

## Layout

```text
docs-site/
  meta.json                 # site manifest (nav, contract version, stats)
  guides/                   # hand-written markdown (edit in PRs)
  generated/                # auto-generated — do not hand-edit
    manifest.json           # sha256 pins for all generated artifacts (committed)
    catalog.md              # from registry/subnets/ (committed)
    resources.md            # MCP tools + agent routes (committed)
    api-reference.md        # from openapi.json + api-index.json (local; hash-pinned)
    api-playground.json     # structured try-it metadata (local; hash-pinned)
```

`api-reference.md` and `api-playground.json` are **gitignored** (~8k lines) and verified via `generated/manifest.json` so PR diffs stay reviewable while `validate:docs-site` still catches drift.

## Regenerate

```bash
npm run docs-site:generate      # write generated/ (including local-only artifacts)
npm run validate:docs-site        # CI freshness gate (--check)
```

Run `docs-site:generate` after changing `schemas/` (→ openapi), `public/metagraph/api-index.json`, or `registry/subnets/`, then commit `meta.json`, `generated/catalog.md`, `generated/resources.md`, and `generated/manifest.json`.

`npm run validate:docs-site` runs in CI **before** `npm run build` so it checks the committed docs against the committed contract sources — `npm run build` does not regenerate `docs-site/` (same discipline as the README catalog).

Hand-written guides under `guides/` are edited directly — they are not overwritten by the generator.

## For reviewers (slop / review load)

Committed docs output is ~400 lines (guides + catalog + resources + manifest). Large API reference and playground JSON are hash-pinned, not committed. Meaningful source: `scripts/generate-docs-site.mjs`, `scripts/lib/route-samples.mjs`, guides, and `tests/docs-site.test.mjs`.

```bash
npm test -- tests/docs-site.test.mjs tests/route-samples.test.mjs
npm run validate:docs-site
```

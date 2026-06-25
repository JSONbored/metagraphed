# PR: feat(artifacts): add slim field-projected search-index artifact

**Branch:** `feat/slim-search-index-v2` → `main`
**Template:** backend-code

---

## Summary

Adds `search-index.json` — a token-stripped projection of `search.json` — and
the corresponding `/api/v1/search-index` route. The slim index carries the same
document count and IDs as the full index but omits per-document token blobs,
making it significantly lighter for browser typeahead and listing use-cases.
Served from R2 only (never committed as a static artifact).

## What Changed

- `schemas/api-components.schema.json` + `schemas/components/08-evidence-search-sources.schema.json` +
  `schemas/public-artifacts.schema.json`: new `SearchIndexArtifact` schema
- `src/artifact-storage.mjs`: R2-only tier entry for `search-index.json`
- `src/contracts.mjs`: artifact and `/api/v1/search-index` route registration
- `scripts/build-artifacts.mjs`: `buildSlimSearchIndex` writes `search-index.json`
  alongside (not instead of) `search.json`
- `scripts/validate-api.mjs`: route coverage for the new endpoint
- `tests/artifacts.test.mjs`: consistency assertions (same count + IDs, no token blobs)
- `tests/api-coverage.test.mjs`: new route in coverage test
- `generated/` + `public/metagraph/`: regenerated OpenAPI, types, api-index, contracts
  via `npm run build` on current `main`
- `packages/client/package.json`: version bump
- `docs/backend-artifact-contracts.md`: updated contract documentation

## Registry Safety

- [x] No secrets, PATs, wallet data, private dashboards, private URLs, or
      validator-local state.
- [x] Generated artifacts were produced by `npm run build` on current `main`.
- [x] R2-only/high-churn detail artifacts are not committed.
- [x] Public API/OpenAPI/schema changes are intentional and documented.

## Validation

- [x] `git diff --check`
- [x] `npm run validate`
- [x] `npm run validate:schemas`
- [x] `npm run validate:api`
- [x] `npm run validate:openapi`
- [x] `npm run scan:public-safety`

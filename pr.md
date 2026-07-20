## Summary

Adds inline `alpha_price_change_1h` / `_1d` / `_7d` / `_1m` (signed %%) on economics listing rows so clients can sort the full subnet set without N× `/trajectory` calls.

## What Changed

- Pure derivation in `src/alpha-price-change.mjs` (same lookback idiom as trajectory `pointAtOrBefore` + movers `pctChange`).
- Fields on `SubnetEconomics` schema + GraphQL + economics `sort` enum.
- Bake-time: `buildEconomicsArtifact` always emits the four fields (null without history).
- Serve-time: enrich `/api/v1/economics`, subnet-detail overlay, GraphQL `economics` / `Subnet.economics`, MCP economics loaders, and leaderboard economics rows from `subnet_snapshots` via Postgres tier (`GET /api/v1/economics/alpha-price-history`). Cold tier → null fields, never an error.
- `alpha_price_change_1h` stays null on daily snapshots (documented); 1d/7d/1m resolve when history exists.

## Registry Safety

- [x] Links a tracked, currently-open issue (`Closes #7227`) — required.
- [x] No secrets, PATs, wallet data, private dashboards, private URLs, or
      validator-local state.
- [x] Generated artifacts were produced by repo scripts, not hand-edited.
- [x] R2-only/high-churn detail artifacts are not committed.
- [x] Public API/OpenAPI/schema changes are intentional and documented.

## Validation

- [x] `tests/alpha-price-change.test.mjs` + `tests/economics-alpha-price-enrichment.test.mjs`
- [x] economics sort + GraphQL field smoke tests
- [x] `npm run build` + `validate:contract-drift`
- [x] eslint + prettier on touched sources

Closes #7227

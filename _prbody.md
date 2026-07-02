## What

Several analytics formatters still used numeric-only `toIso` helpers (or `Number(row.captured_at)` before `toIso`) when stamping REST `generated_at` / snapshot timestamps from D1. SQLite can return INTEGER epoch-ms cells as numeric strings; blank or out-of-range values could serialize as epoch 1970 or throw `RangeError` instead of `null`.

## How

Apply the same hardened epoch-ms coercion pattern already merged on `blocks.mjs` (#2708) and `account-events.mjs` (#2704) across the sibling analytics tiers:

- `stake-flow.mjs` — `toIso` + `coerceEpochMs` for `loadSubnetStakeFlow` `generatedAt`
- `account-stake-flow.mjs` — `toIso` + `coerceEpochMs` for `loadAccountStakeFlow` `generatedAt`
- `subnet-yield.mjs` — `toIso` + pass raw `captured_at` (no `Number(null) === 0` leak)
- `counterparties.mjs` — `nullableTimestamp` + `toIso` for relationship `observed_at` / `last_seen_at`

## Why no linked issue

Standalone D1 coercion gap sweep across analytics formatters. Open #2714 covers extrinsics `observed_at` only; open neuron-history PRs cover history builders, not these stake/yield/counterparty tiers. No open issue tracks this cross-tier gap.

## Scope / risk

Formatter-only changes in four pure modules plus focused unit tests. Valid numeric timestamps unchanged; `null` stays `null`.

## Tests

- `loadSubnetStakeFlow` string / blank / out-of-range `last_observed` → ISO or null
- `loadAccountStakeFlow` string / blank / out-of-range `last_observed` → ISO or null
- `buildSubnetYield` string / null / blank / out-of-range `captured_at`
- `buildCounterpartyRelationship` blank / out-of-range `observed_at` evidence cells

## Test plan

- [x] All four modules have regression tests for string, null, blank, and out-of-range inputs
- [x] Existing stake-flow, account-stake-flow, subnet-yield, and counterparties tests pass
- [x] CI vitest + lint/format checks

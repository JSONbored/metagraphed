# D1 maintenance

Operational state is owned by D1. Apply tracked migrations with
`npm run migrate:d1 -- --remote`. The D1 maintenance workflow applies pending
migrations on relevant main-branch changes and verifies schema drift weekly.
It uses the existing Cloudflare account secret and API token with D1 Write
permission, plus the `CLOUDFLARE_D1_DATABASE_ID` repository variable. It does not
request a Neon branch, database URL, compute endpoint, or API key.

`npm run snapshot:d1-schema -- --write` captures the physical tables, views,
indexes and triggers into `generated/db/d1-schema.json` and `db/d1-schema.sql`.
Review both artifacts in the same PR as a migration. Without `--write`, the
command only checks for drift. Set `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_D1_DATABASE_ID` and `CLOUDFLARE_API_TOKEN` in the maintainer's protected
environment; never place a token in a command argument or tracked file.

The retained `generated/db/schema.json` remains the logical row/type contract
used by generated TypeScript types and archive exports. It is not a live Neon
dependency. SQLite introspection cannot infer the numeric types of JSON-backed
view columns, so a physical D1 snapshot must never overwrite that contract.
Change logical types deliberately alongside their readers and export tests.

Treasury review stays an explicit, non-public maintainer action:

```sh
node scripts/review-treasury-readings.ts list
node scripts/review-treasury-readings.ts promote <netuid> <source_url> reviewed
node scripts/review-treasury-readings.ts promote <netuid> <source_url> rejected
```

Listing pages through all candidates using their primary key. Promotion binds
the exact subnet and source URL and updates its archive revision in the same
D1 batch. It neither schedules approvals nor adds a REST or MCP review route.
A failed or timed-out write is not automatically retried: inspect the named
reading before issuing another promotion.

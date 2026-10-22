# D1 maintenance

Operational state is owned by D1. Apply tracked migrations with
`npm run migrate:d1 -- --remote`. The existing D1 maintenance workflow applies
pending migrations on main-branch pushes that change tracked migration SQL.
Changes to maintenance helpers, verification scripts, committed schema snapshots
or the workflow itself only verify the recorded ledger and physical schema.
The push comparison covers the full before/after range, including a migration
changed before the last commit; an unavailable comparison fails without applying.
Weekly runs and manual dispatches are also verify-only unless a maintainer
explicitly enables the manual `apply_migrations` input, which defaults to false.
It uses the existing Cloudflare account secret and a dedicated
`CLOUDFLARE_D1_API_TOKEN` repository secret with only account-scoped D1 Write
permission, plus the `CLOUDFLARE_D1_DATABASE_ID` repository variable. It does not
request a Neon branch, database URL, compute endpoint, or API key.

`npm run snapshot:d1-schema -- --write` captures the physical tables, views,
indexes and triggers into `generated/db/d1-schema.json` and `db/d1-schema.sql`.
This mode reads the actual D1 catalog. Without `--write`, it only checks the
actual catalog against the committed schema contract. Set `CLOUDFLARE_ACCOUNT_ID`,
`CLOUDFLARE_D1_DATABASE_ID` and `CLOUDFLARE_API_TOKEN` in the maintainer's protected
environment; never place a token in a command argument or tracked file.

For an unapplied migration, prepare the **expected post-migration schema**
without production access:

```sh
node scripts/snapshot-d1-schema.ts \
  --project-migrations 0039_x402_payment_attempts.sql --write
```

The existing snapshot tool restores both committed physical-schema artifacts
into an in-memory native SQLite database, applies only the explicitly named,
ordered migration files, and serializes the resulting catalog in the same
formats. Multiple filenames are comma-separated; omitting `--write` previews
the receipt without changing either file. The receipt labels this
`expected-postmigration` with `live_readback: false` and binds the baseline,
migration bytes and expected outputs by SHA256. It does not apply D1 migrations,
contact Cloudflare, verify production rows, or establish production ledger state.

Run this preparation on a development box or with the existing `Sync contract
artifacts` workflow's `generate-only` mode and `contracts` preset. Its optional
`d1_migrations` input selects the exact filenames and includes only these two
schema artifacts and the expected-schema receipt alongside normal contract
outputs. Review the migration and both generated schema artifacts in one PR.
The snapshot formats remain unchanged, so their contents alone are not proof
that a migration has been deployed. After an authorized application, the native
D1 maintenance ledger and physical-catalog checks must match these expected
definitions. A mismatch remains a deployment failure; projection does not waive
that check or replace actual post-apply readback evidence.

In GitHub Actions, verification failures publish the existing fixed failure
classification as an error annotation. The exact allowlisted provider code
`10000` also survives when the complete helper error has its known fixed shape;
all other suffixes are discarded. This makes an HTTP or ledger failure class
and that safe provider diagnostic available without a complete job-log download. Provider text, SQL,
identifiers and credentials never enter the annotation. An unclassified error
remains unclassified; this is not a substitute for authorized live diagnosis.

The retained `generated/db/schema.json` remains the logical row/type contract
used by generated TypeScript types and archive exports. It is not a live Neon
dependency. SQLite introspection cannot infer the numeric types of JSON-backed
view columns, so a physical D1 snapshot must never overwrite that contract.
Change logical types deliberately alongside their readers and export tests.

The archive-policy audit reads both committed snapshots. A bundle contract that
explicitly declares the D1 source dialect derives its selected physical table
columns from `generated/db/d1-schema.json` in an isolated in-memory SQLite
database. Views keep the retained logical contract; their physical metadata is
not a substitute for logical types. No extra generated column snapshot is stored.
With production bundle mappings empty, this path selects no D1 table and opens
no database. Type and nullability checks do not prove writer encoding, catalog
identity or deployed publication/readback; those need separate integration
evidence before a production mapping is added.

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

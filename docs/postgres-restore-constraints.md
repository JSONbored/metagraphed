# Stable native constraint restoration

PostgreSQL expands `BETWEEN` into an internal conjunction. When another
condition follows it, the initial expression can retain a nested `AND` node.
`pg_dump` deparses that form into ordinary comparisons; reparsing the declaration
in `pg_restore` flattens the conjunction. Validation behavior is equivalent, but
an exact catalog fingerprint changes.

Migration `0039_restore_stable_constraints.sql` installs the flat comparison
form for the four affected cron and MCP checks. It preserves their names,
inclusive bounds, NULL truth values and validation behavior. Include it after
the native cron and MCP schema migrations in the reviewed activation manifest.
It does not start a scheduler or change any application row.

The PostgreSQL fixture evaluates the same NULL/boundary/error cases against the
original and migrated constraints, then recreates each from its exact deparsed
DDL and checks that the catalog definition remains identical. Full catalog
backup/restore qualification retains exact fingerprints; it does not normalize
away this difference.

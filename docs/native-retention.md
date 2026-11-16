# Native rolling-window retention

`createPgRetentionStore` supplies `NATIVE_RETENTION_STORE` over the process-owned
PostgreSQL source. Construction requires writable `app` ownership of both
`surface_checks` and `subnet_burn_history`. It copies the existing retention
plans and validates their identifiers and minimum retention floor.

The existing hourly prune lane selects this capability before D1 or Hyperdrive.
Each table has its own transaction: a table lock keeps writers from changing the
impact between counting and deletion, the cutoff remains strictly `<` the
millisecond boundary, and an all-stale table is refused. Successful outcomes
report the actual deleted row count. Read or delete failures remain visible in
the existing lane-health verdict without preventing the other table's attempt.
A delete or commit error is reported as unacknowledged. Its zero acknowledged
count does not prove no rows changed when the connection outcome is uncertain.

This is preparation only. Construction does not open a listener, start a timer,
transfer source data, run migrations, or change production ownership. The
native application must declare and verify the source before enabling its
existing scheduled prune lane.

Unit tests cover capability selection, source and policy validation, impact
guards, counted deletion, and per-table failures. The disposable PostgreSQL
fixture compares the surviving rows with D1 at the exact cutoff, refuses a
seconds-as-milliseconds fixture, and proves failed statements and deferred
commit failures roll back without preventing the other table from pruning.
It also verifies that a concurrent writer waits outside the locked transaction.

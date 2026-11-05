# Native validator arithmetic history

`createPgValidatorHistoryStore` supplies `VALIDATOR_HISTORY_STORE` for scoped
and unscoped validator histories. Keyset pages in one repeatable-read transaction capture accepted memberships,
canonical daily documents and matching pool rows. Original JSON
first-key values stay in their SQLite scalar storage classes during arithmetic.
The existing pinned, read-only decoder executes fixed multiply/divide statements,
including D1's numeric-text boundary at the first NUL;
the existing SQLite SUM accumulator preserves integer-overflow and compensated
REAL behavior. Wire conversion occurs only after those operations.

Root uses its exact integer multiplier; other networks use the recorded pool
ratio. A missing price or zero denominator stays null. Scoped reads retain days
without a validator permit; unscoped histories keep the original permit filter.
History limits apply after the relevant scoped rows or grouped days are formed.
The adapter refuses incomplete populations above 200,000 accepted memberships
or its 20-second work deadline instead of returning partial totals. Page payloads
are bounded to 32 MiB, with adaptive batch reduction before bytes reach the
driver.

This prepares a reader only. It does not create a database, import source data,
change writers or route production traffic.

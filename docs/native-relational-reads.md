# Native relational data API reads

The health-status continuity and current/history account-identity and subnet
hyperparameter routes can use `NATIVE_READ_STORE`. Selection requires ownership
of every table requested by the family. Once native ownership is selected,
missing or invalid capabilities cannot fall back to D1 or Hyperdrive.

`selectedNativeRelationalSql` admits only those five relational tables. Their
queries use ordinary comparisons, ordering, limits and keyset tuples. The
adapter shares the existing parameter-numbering implementation and opens no
connections. Numeric bounds retain D1's fractional and out-of-int64 comparison
behavior, and raw health integer fields retain D1's numeric wire conversion.
Ordinary account predicates retain indexed text equality. The exceptional
NUL/lone-surrogate lookup binds UTF-8 bytes, retaining D1's empty/cold behavior.
This does not relax the separate
admissibility requirements for persisted PostgreSQL text.

Logical neuron document views remain on their explicitly typed readers. This
adapter does not translate SQLite date, JSON or aggregate operations. Adding a
different relational family requires checking its query semantics and extending
the actual D1/PostgreSQL HTTP comparisons.

The isolated fixture uses the native schema definitions in a dedicated
disposable schema. It compares status and response bytes for empty/current/
history reads, missing keys, numeric and boolean hyperparameters, health
freshness filters, Unicode and NUL lookup keys, and pagination cursors.
No production routing or data migration is activated by this capability.

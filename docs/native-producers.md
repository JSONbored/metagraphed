# Native producer selection

`createPgProducerBindings(source, requiredLanes)` constructs producer and write
capabilities from an already verified, writable `NativeSource`. It opens no
connection or timer and exposes no pool closer. Queries, atomic statement
batches and capture writes use the same process-owned source and admission
limits as other native capabilities.

`NATIVE_PRODUCER_STORE` declares the physical tables its `query`, `first`, `run`
and `transaction` methods own. The main API's producer selector checks every
requested table before returning the native handle. Capture diff reads use the
same owner through `selectedNativeProducerSql`. Selecting a partial group or a
logical table absent from the source is an error; it cannot revive D1 or an
independent Hyperdrive client.
If either native producer binding is present, the corresponding missing native
capability is an error too; a half-composed environment cannot select a legacy
writer through the omitted binding.

`NATIVE_WRITE_RUNNERS` declares each active write lane separately. Its presence
selects native write ownership: a missing lane or invalid runner throws even if
a legacy binding is available. The factory checks each requested lane's full
table group, derived from the existing writer plans. Native writes retain the
existing statements, PostgreSQL values, ordering, conflict guards and counted
outcomes. They report direct-write verdicts instead of deferring those verdicts
to the former buffer.

| Lane                                | Required source tables                                          |
| ----------------------------------- | --------------------------------------------------------------- |
| `account-balances`                  | Account balance rows and pass ledger                            |
| `hotkey-alpha`                      | Alpha rows, pass ledger and referenced nominator positions      |
| `validator-nominator-counts`        | Count rows and pass ledger                                      |
| `subnet-hyperparams`                | Latest rows and history                                         |
| `account-identity`                  | Latest rows and history                                         |
| `subnet-identity`                   | Latest rows and history                                         |
| `subnet-ownership`                  | Latest rows and history                                         |
| `nominator-positions`, `self-stake` | Positions, pass ledger and scan receipts                        |
| `chain-detail`                      | All four detail tables, with the coverage register written last |
| `blocks-head`                       | Head rows                                                       |
| `raw-capture-state`                 | Contiguous capture watermark                                    |
| `tao-usd-index`                     | Pinned price observations                                       |

Native neuron documents use `NEURON_CAPTURE_STORE`; their physical storage is
not the legacy flat `neurons`/`neuron_daily` tables. The generic native factory
rejects the `neurons` lane. Chain-concentration's existing flat/SQLite document
query likewise cannot be granted by the physical-table producer selection; it
requires a dedicated native rollup source. These families must be explicitly
closed before any whole-application activation.

The deployment manifest must require every enabled producer lane and its read
dependencies. An omitted lane is not an optional success. The factory and
selectors do not migrate data, prove historical completeness, register a
schedule or change a Worker deployment. Existing Worker selection remains in
place when native ownership is absent.

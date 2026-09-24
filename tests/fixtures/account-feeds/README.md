`native-tree.json` contains synthetic account events written as native Parquet,
projected and externally sorted by the infrastructure account-feed producer,
then merged into the actual compressed R2 page and directory format. It includes
only the completed tree's reachable objects, their native ETags, the selected
source identity, and all original physical rows.

The fixture contains repeated captures and self-transfers, deliberately unordered
source rows, nullable fields, separate hotkey/coldkey/global views, two-stage
merges, and multiple directory levels. Production-sized pages are reduced to four
rows and directory fanout to four to exercise traversal without a large fixture.
The wire format and compression are unchanged. Tests compare full results,
filters, cursor pages, and offsets against independently filtered source rows.

`runtime-correction.json` exercises a separately selected, closed runtime
correction over an immutable legacy account base. The native producer wrote its
Parquet, block pages, account tree, and source proofs. It includes a repeated
transfer capture, two RootClaimed amount repairs, one BasketDeposited event, and
a later forward capture outside the correction range. Tests check that only the
selected runtime kinds in that range are replaced, while paging, aggregation,
identity fences, and physical duplicate semantics remain intact.

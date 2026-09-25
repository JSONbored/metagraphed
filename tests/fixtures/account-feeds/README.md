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

`compact-tree.json` re-encodes those same synthetic rows with the infrastructure
`history_account_page_r2.py` encoder. Two out of every three leaf pages use MGA2;
the others remain JSONL to exercise immutable subtree reuse. Object lengths,
content hashes, ETags and directory links are recomputed. The public reader checks
the same filters, physical duplicates, offsets and cursors against the original
tree. Four-row fixture leaves deliberately include cases where binary is larger;
production writers should select the smaller compressed representation.

`compact-page.json` is independent Python encoder output containing nullable
fields, the largest safe ordering values, empty/Unicode/surrogate strings,
negative zero and the smallest/largest finite binary64 values. The decoder tests
also mutate dimensions, dictionary indices, identity and nonfinite bit patterns.

The manifest encoding `account-mixed-gzip-v2` permits gzip-compressed legacy JSONL
and MGA2 pages. `jsonl-gzip-v1` remains JSONL-only. MGA2's decoded wire format is:

- Four ASCII magic bytes `MGA2`, a little-endian uint16 row count, and a
  little-endian uint32 dictionary byte length.
- A UTF-8 JSON array of strings, preserving escaped UTF-16 surrogate values.
- Fourteen little-endian float64 columns: the eleven account-event fields in
  schema order, then query hash, physical source hash and source row ordinal.
  String fields store dictionary indices. The exact bits `0x7ff8000000000000`
  mean null; every other nonfinite number is rejected.

The decoder retains the 256-row and 256-KiB page bounds, rejects trailing bytes,
reconstructs ordering tokens from their original row fields, and validates the
complete page before yielding any result. Binary pages require manifest opt-in;
reader support must be deployed before a writer publishes that encoding.

`runtime-correction.json` exercises a separately selected, closed runtime
correction over an immutable legacy account base. The native producer wrote its
Parquet, block pages, account tree, and source proofs. It includes a repeated
transfer capture, two RootClaimed amount repairs, one BasketDeposited event, and
a later forward capture outside the correction range. Tests check that only the
selected runtime kinds in that range are replaced, while paging, aggregation,
identity fences, and physical duplicate semantics remain intact.

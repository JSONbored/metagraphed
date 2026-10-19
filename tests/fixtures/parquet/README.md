Synthetic flat Parquet fixtures generated with PyArrow 25.0.1. No production records.

`economics-wide.parquet` was generated in native CI with PyArrow 26.0.0. It has
12 synthetic extrinsics in four-row groups, all at block 42 / observed_at 10,
with signer `synthetic-signer`, fee 0.125 and tip 0.005. Each `call_args` JSON
object contains a payload just over 1 MiB and nested IDs 0, 7 and 9. For row i,
the payload is `random.Random(i).randbytes(32768).hex()` repeated 16 times plus
`x`. Calls are `{name: src_netuid, value: "7"}`, `{destination_netuid: 9}` and
`{netuid: 0}`. Encoding uses Python's default `json.dumps`, ZSTD level 3,
no dictionary, statistics only for block_number/observed_at, 65,536-byte pages,
one-row write batches, page V2 and page indexes. There are no production rows.

Each has 2,000 rows and row groups of 800, 800, and 400 rows. The columns are:

- `id`: INT64, `9007199254740993 + row` (deliberately above JavaScript's safe integer limit).
- `label`: null every seventh row, otherwise `label-` followed by `row % 31`; dictionary encoded.
- `enabled`: true on even rows.
- `amount`: null every eleventh row, otherwise `row / 8`.

Both use `data_page_size=256`, `write_batch_size=64`, and `write_page_index=False`. One uses data page V1 with ZSTD, the other V2 with Snappy. The small pages force real page selection, dictionary reads, null handling, and row-group crossings without a large fixture.

`history-events-0.parquet` and `history-events-1.parquet` are synthetic ten-row parts of a twenty-row event source, generated with PyArrow. They use five-row groups, ZSTD, page V2, and page indexes. For source row `i`, `block_number` is 7 for rows 4–14 and 8 otherwise; `observed_at` is 10 for rows 0–7 and 20 otherwise; `wide` is the exact INT64 `9007199254740992 + i`; `nullable` is `value` for even rows and null otherwise. These make one block span both parts and multiple observation runs. No production data is included.

`compact-ranges.parquet` contains 2,048 synthetic rows in eight 256-row groups,
written with PyArrow 25.0.1, ZSTD, page V2, `data_page_size=256`,
`write_batch_size=64`, and no page index. Column order is `id`, `small`, `label`,
`payload`, `amount`. `id`, `label`, and `amount` follow the flat fixtures above;
`small` is INT32 `row % 257`, and `payload` is the lowercase SHA-512 hex digest
of the decimal row number. The narrow omitted column and wide omitted payload
exercise bounded coalescing and four-read batches across real compact groups.

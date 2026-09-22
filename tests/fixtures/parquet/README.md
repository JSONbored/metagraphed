Synthetic flat Parquet fixtures generated with PyArrow 25.0.1. No production records.

Each has 2,000 rows and row groups of 800, 800, and 400 rows. The columns are:

- `id`: INT64, `9007199254740993 + row` (deliberately above JavaScript's safe integer limit).
- `label`: null every seventh row, otherwise `label-` followed by `row % 31`; dictionary encoded.
- `enabled`: true on even rows.
- `amount`: null every eleventh row, otherwise `row / 8`.

Both use `data_page_size=256`, `write_batch_size=64`, and `write_page_index=False`. One uses data page V1 with ZSTD, the other V2 with Snappy. The small pages force real page selection, dictionary reads, null handling, and row-group crossings without a large fixture.

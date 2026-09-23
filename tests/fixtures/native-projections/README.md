Synthetic native SQL qualification for all 18 scheduled projection lanes and their 20 output artifacts on each network. No production data or credentials.

`native.json.gz` contains table schemas, source records, the 190 distinct canonical SQL statements and their results, and the resulting artifacts. DuckDB 1.5.5 executed the statements with integer division enabled and one thread. The fixture covers exact 7/30/90-day cutoffs, the immediately adjacent milliseconds, null signers and outcomes, nullable amounts and identities, repeated registration slots, Unicode module names, and ownership changes older than the rolling windows. The gzip wrapper uses a zero timestamp.

The native producer's integration tests execute the same statements against real Parquet and PostgreSQL. Public tests replay their bounded row frames through the canonical builders to prevent artifact, timestamp, query-scope, and protocol drift.

`serving.json.gz` contains the immutable objects and complete manifests emitted by the native Python producer from the same synthetic dataset. Reader tests validate all 40 artifacts, exact object ETags and byte counts, source cutoffs, publication generations, and the scheduled ownership switch on both networks. It contains no production data.

# Native neuron summary readers

`createPgNeuronSummaryStore(runtime, decoder)` supplies `NEURON_SUMMARY_STORE`
to the existing completeness, directory nominator and daily summary readers.
It uses the same PostgreSQL database and pinned read-only document codec as the
other native neuron capabilities. An absent capability retains the existing
reader; an invalid or failing selected capability remains an error.

Completeness reads current documents, accepted memberships and capture receipts
in one PostgreSQL statement. It keeps the source query's exact scalar maximum
before matching a receipt with SQLite numeric affinity. The newest capture must
have a completed receipt with the expected number of joined entries and enough
received rows. An older complete capture cannot certify a newer partial capture.
Per-network block maxima retain raw text ordering and exact integer comparison
before the D1 wire conversion.

Directory nominator counts preserve first-occurrence input order after key
deduplication. Missing counts remain null and a stored zero remains zero. The
scan timestamp is the maximum across the whole count table, including hotkeys
that were not requested.

Daily summaries read the selected documents and memberships atomically. They
retain SQLite integer-key matching and duplicate entry multiplicity. Daily
validator lists use the source's strict numeric-one predicate and preserve
malformed orphan predicate failures. Totals use SQLite truthiness and the shared
compensated SUM implementation, including integer-overflow refusal and nonfinite
wire behavior. Subnet history keeps descending date order, cutoff, exclusive
ceiling and limit semantics.

The synthetic PostgreSQL 18/D1 fixture compares these public reader functions on
both engines. No database initialization, writer transfer or production routing
change is performed by supplying these modules in the repository.

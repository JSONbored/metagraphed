# Native canonical daily views

`createPgNeuronDailyViewStore` supplies `NEURON_DAILY_VIEW_STORE` for bounded
daily rows and data-anchored window bounds. It joins accepted membership and
document rows in one PostgreSQL statement, decodes each selected document once,
and uses the original first-key SQLite paths. Optimized metric and summary
readers remain distinct because they preserve different duplicate semantics.

Row reads admit named columns, a subnet, date bounds or an explicit date set,
date ordering and a required limit. The limit applies to accepted memberships
before document decoding. Window bounds consider only documents with accepted
members and use the existing `shiftIsoDate` arithmetic after reading the newest
source day. Empty and invalid-date behavior remains compatible with the source.

The data API selects these capabilities for concentration history and subnet
turnover; existing summary capabilities serve subnet history, chain turnover
and movers, and the metric capability serves yield history. Subnet turnover
requires the complete two-day population and fails explicitly if its one-million
row preparation ceiling is reached, rather than reporting a partial turnover.

This prepares readers and tests. It does not initialize a database, move source
data, change public traffic or declare unsupported joined history routes ready.

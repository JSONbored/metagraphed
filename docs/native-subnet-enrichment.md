# Native subnet economics and history enrichment

`createPgSubnetEnrichmentStore` supplies `SUBNET_ENRICHMENT_STORE` for subnet
emission history, owner participation, public compute declarations, treasury
readings and daily TAO/USD observations. The existing response builders own all
published ratios, classifications and null handling.

Canonical daily rows and their same-day subnet snapshots are read in one
repeatable-read transaction. The PostgreSQL statement snapshot stays fixed while
the existing bounded SQLite decoder projects original first-key document
values. A concurrent snapshot writer cannot mix a newer relational row into an
older document read. Same-day emission and concentration caps retain the
source covering-index shard order; explicitly UID-ordered histories keep UID
order. Owner position ties retain the source capture-index order. Miner fairness uses the existing canonical daily/live
capabilities; cost-to-participate retains the optimized metric reader.

Relations use explicit methods and bounded complete populations. This adapter
prepares application reads only. It creates no database, migrates no source data
and changes no traffic. Validator-history SQL arithmetic remains separate.

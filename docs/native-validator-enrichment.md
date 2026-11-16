# Native validator and account enrichment

`createPgValidatorEnrichmentStore` supplies the typed
`VALIDATOR_ENRICHMENT_STORE` capability for latest pool prices, subnet tempos,
public account identities and completed neuron receipts. Each method names its
relational source explicitly. Existing response builders retain the same spot
pricing, confirmed-zero nominator counts and degraded enrichment behavior.

Detail and comparison reads use the canonical live-view capability with a
bounded hotkey set. Ordinary keys retain indexed text equality; exceptional
request values use exact byte predicates. This does not relax the separate
source-import text-admissibility requirements.

Leaderboard and account directory reads continue to use the optimized live
reader's duplicate-preserving semantics. Native materialization checks the
completed receipt and current capture before and after its fold, preserving the
previous complete directory while a partial pass is in progress.

The capability prepares application reads only. It does not create databases,
activate a runtime, move source data or change traffic. Joined historical
arithmetic remains a separate qualification scope.

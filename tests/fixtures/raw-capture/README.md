# Raw capture source vectors

The mainnet vector retains original fixed-hash responses from the official public archive. Its header hash was independently reconstructed from SCALE bytes; event/state inclusion and consensus proofs are not established. Metadata identity comes from the prior frozen runtime snapshot. The testnet files qualify only the declared network genesis.

Synthetic test helpers create explicitly synthetic anchored windows for races and malformed-source cases; they do not stand in for missing historical state or runtime-upgrade fixtures. No live capture/backfill is driven by these files.

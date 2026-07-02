-- Bittensor stake semantics (#1856, Phase 1): persist the alpha leg of a stake
-- swap that the poller already decodes but currently drops.
--
-- alpha_amount is the subnet alpha bought (StakeAdded) or sold (StakeRemoved),
-- in TAO units (alpha_rao / 1e9), read from the 4th field of the Stake* event.
-- Null for every non-stake event kind and for StakeMoved (no single alpha leg).
-- Applied as an idempotent ALTER (nullable column never breaks existing rows or
-- the INSERT OR IGNORE load path) — populates going forward only.
--
-- Phase 2 (realized alpha price / slippage) is deferred: it needs the subnet AMM
-- reserves at the event's block, a poller-side state read, not a pure transform.

ALTER TABLE account_events ADD COLUMN alpha_amount REAL;

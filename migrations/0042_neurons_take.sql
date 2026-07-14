-- Validator take/commission (#2548): the percentage of delegator rewards a
-- validator keeps, exposed on-chain per hotkey via SubtensorModule::Delegates
-- (a u16 out of 65535, same ratio convention as rank/validator_trust --
-- verified live against the fullnode 2026-07-14: a raw value of 11796
-- decodes to exactly 0.18, the documented Bittensor default/floor take).
-- Global per-hotkey, not per (netuid, uid) -- stored denormalized on every
-- row for that hotkey, same convention this table already uses for coldkey.
-- NULL means the hotkey had no Delegates entry at capture time (never
-- registered as a delegate, or a snapshot that predates this column).
ALTER TABLE neurons ADD COLUMN IF NOT EXISTS take REAL;

-- neuron_daily's shape mirrors neurons exactly (0011's own comment) so both
-- share NEURON_INSERT_COLUMNS on the write path -- must gain the same column
-- or that shared insert breaks.
ALTER TABLE neuron_daily ADD COLUMN IF NOT EXISTS take REAL;

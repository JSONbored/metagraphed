-- Alpha accounting v2 (#13163, runtime v490; #13161, epic #13142).
--
-- nominator_positions is still built from the legacy SubtensorModule::Alpha
-- scan (#12767 prepared the exporter for this transition). The v2 writers --
-- the engine's AlphaV2 / TotalHotkeySharesV2 / AlphaShareEpoch decode -- land
-- with the engine; this migration only gives their values keyed places to
-- land, mirroring the D1 export columns #12767 already accepts. Every column
-- is nullable because a legacy row truthfully has no v2 measurement: a NULL
-- here is "not captured under v2", never a fabricated zero.
ALTER TABLE app.nominator_positions
    ADD COLUMN alpha_rao text COLLATE "C" CHECK (
        alpha_rao IS NULL OR ((alpha_rao = '0' OR alpha_rao ~ '^[1-9][0-9]*$')
            AND (length(alpha_rao), alpha_rao) <= (20, '18446744073709551615'))
    ),
    ADD COLUMN shares_v2 text COLLATE "C" CHECK (
        shares_v2 IS NULL OR ((shares_v2 = '0' OR shares_v2 ~ '^[1-9][0-9]*$')
            AND (length(shares_v2), shares_v2) <= (39, '340282366920938463463374607431768211455'))
    ),
    ADD COLUMN share_epoch bigint CHECK (share_epoch IS NULL OR share_epoch >= 0);

-- One row per (netuid, hotkey): the pending alpha dividend accrual the engine
-- fills from SubtensorModule.AlphaDividendsPerSubnet /
-- RootAlphaDividendsPerSubnet. Amounts are u64 alpha atomic units crossed as
-- canonical decimal text (same discipline as the root_basket counters);
-- captured_at is epoch-ms, same floor as app.subnet_mechanisms.
CREATE TABLE app.subnet_alpha_dividends (
    netuid bigint NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    hotkey text COLLATE "C" NOT NULL CHECK (hotkey <> ''),
    alpha_divs text COLLATE "C" CHECK (
        alpha_divs IS NULL OR ((alpha_divs = '0' OR alpha_divs ~ '^[1-9][0-9]*$')
            AND (length(alpha_divs), alpha_divs) <= (20, '18446744073709551615'))
    ),
    root_alpha_divs text COLLATE "C" CHECK (
        root_alpha_divs IS NULL OR ((root_alpha_divs = '0' OR root_alpha_divs ~ '^[1-9][0-9]*$')
            AND (length(root_alpha_divs), root_alpha_divs) <= (20, '18446744073709551615'))
    ),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (netuid, hotkey)
);

-- One row per (coldkey, hotkey, netuid, kind): the conviction-lock state the
-- engine fills from SubtensorModule.Lock / HotkeyLock / DecayingLock /
-- OwnerLock and their decaying variants. kind spells the storage item as the
-- chain spells it rather than pinning an enum the runtime still extends.
-- amount is u64 atomic units as decimal text; maturity_block is null for a
-- lock without a maturity (perpetual, or not carried by that variant).
CREATE TABLE app.stake_locks (
    coldkey text COLLATE "C" NOT NULL CHECK (coldkey <> ''),
    hotkey text COLLATE "C" NOT NULL CHECK (hotkey <> ''),
    netuid bigint NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    kind text COLLATE "C" NOT NULL CHECK (kind <> ''),
    amount text COLLATE "C" NOT NULL CHECK (
        (amount = '0' OR amount ~ '^[1-9][0-9]*$')
            AND (length(amount), amount) <= (20, '18446744073709551615')
    ),
    maturity_block bigint CHECK (maturity_block IS NULL OR maturity_block >= 0),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (coldkey, hotkey, netuid, kind)
);

-- The per-validator read path (/validators/{hotkey} tooling and the staleness
-- watchdogs) scans by hotkey; the primary key already serves the coldkey scan.
CREATE INDEX idx_stake_locks_hotkey ON app.stake_locks (hotkey, netuid);

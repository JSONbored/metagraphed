-- The Gamma subsystem (#13164, runtime v490; #13161, epic #13142).
--
-- Gamma is entirely absent from the serving tier today: zero storage reads,
-- zero tables, and its event kinds land raw-only in
-- chain_detail_chain_events. This migration gives the v490 Gamma state its
-- keyed places to land. The writers -- the engine's GammaEnabled /
-- SubnetGammaEnabled / SubnetGammaPrice / SubnetGammaEmission /
-- PendingGammaEmission / UnconvertedGammaEmission /
-- SubnetGammaEmissionWhitelisted / GammaDeposits decode and the structured
-- Gamma event decode -- land with the engine; until they do, every table
-- below is empty and the serving tier declines schema-stably (NULL counts,
-- never fabricated zeros).
--
-- Quantities are u64 atomic units as canonical decimal text (same discipline
-- as app.subnet_alpha_dividends); captured_at is epoch-ms, same floor as the
-- neuron document stamps. Mainnet-only, like every table without a network
-- column.

-- The global Gamma switch (SubtensorModule.GammaEnabled) as a capture
-- series: the newest row is the current state, and the series records when
-- the flag moved. A singleton current-state row would erase exactly the
-- governance history the chain-wide card wants to state.
CREATE TABLE app.chain_gamma (
    enabled boolean NOT NULL,
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (captured_at)
);

-- One row per (netuid, captured_at): the per-subnet Gamma state the engine
-- fills from SubtensorModule.SubnetGammaEnabled / SubnetGammaPrice /
-- SubnetGammaEmission / PendingGammaEmission / UnconvertedGammaEmission /
-- SubnetGammaEmissionWhitelisted. A capture SERIES rather than a
-- current-state row, because the route family serves both the current card
-- and its history; the newest row per netuid is the current state. price is
-- the chain's raw price encoding crossed verbatim as canonical decimal text
-- (u128-bounded) -- the engine's decode owns the scaling, and re-deriving it
-- here would invent precision. Every value column is nullable because a
-- capture truthfully carries only what the chain had at that block: a NULL
-- is "not carried at capture time", never a fabricated zero or false.
CREATE TABLE app.subnet_gamma (
    netuid bigint NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    enabled boolean,
    price text COLLATE "C" CHECK (
        price IS NULL OR ((price = '0' OR price ~ '^[1-9][0-9]*$')
            AND (length(price), price) <= (39, '340282366920938463463374607431768211455'))
    ),
    emission text COLLATE "C" CHECK (
        emission IS NULL OR ((emission = '0' OR emission ~ '^[1-9][0-9]*$')
            AND (length(emission), emission) <= (20, '18446744073709551615'))
    ),
    pending_emission text COLLATE "C" CHECK (
        pending_emission IS NULL OR ((pending_emission = '0' OR pending_emission ~ '^[1-9][0-9]*$')
            AND (length(pending_emission), pending_emission) <= (20, '18446744073709551615'))
    ),
    unconverted_emission text COLLATE "C" CHECK (
        unconverted_emission IS NULL OR ((unconverted_emission = '0' OR unconverted_emission ~ '^[1-9][0-9]*$')
            AND (length(unconverted_emission), unconverted_emission) <= (20, '18446744073709551615'))
    ),
    whitelisted boolean,
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (netuid, captured_at)
);

-- One row per (coldkey, hotkey, netuid): the Gamma deposit state the engine
-- fills from SubtensorModule.GammaDeposits (ColdkeyGammaHotkeys is this
-- table's own key prefix, so it needs no table of its own). spender is the
-- authorized spending account from GammaDepositSpenderSet; daily_cap is the
-- u64 spend ceiling from GammaDepositDailySpendCapSet; closed_at is the
-- block the deposit was closed at (GammaDepositClosed) and NULL while open
-- -- never fabricated as 0, which would claim closure at genesis.
CREATE TABLE app.gamma_deposits (
    coldkey text COLLATE "C" NOT NULL CHECK (coldkey <> ''),
    hotkey text COLLATE "C" NOT NULL CHECK (hotkey <> ''),
    netuid bigint NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    balance text COLLATE "C" NOT NULL CHECK (
        (balance = '0' OR balance ~ '^[1-9][0-9]*$')
            AND (length(balance), balance) <= (20, '18446744073709551615')
    ),
    spender text COLLATE "C" CHECK (spender IS NULL OR spender <> ''),
    daily_cap text COLLATE "C" CHECK (
        daily_cap IS NULL OR ((daily_cap = '0' OR daily_cap ~ '^[1-9][0-9]*$')
            AND (length(daily_cap), daily_cap) <= (20, '18446744073709551615'))
    ),
    closed_at bigint CHECK (closed_at IS NULL OR closed_at >= 0),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (coldkey, hotkey, netuid)
);

-- The chain-wide deposits card reads largest-first; the primary key already
-- serves the per-coldkey scan.
CREATE INDEX idx_gamma_deposits_balance
    ON app.gamma_deposits (length(balance) DESC, balance DESC);

-- One row per (block_number, event_index): the structured ingest of the nine
-- Gamma event kinds (GammaMinted / GammaMoved / GammaDepositClosed /
-- GammaDepositSpenderSet / GammaDepositDailySpendCapSet / GammaSpent /
-- GammaSpendSkipped / SubnetGammaEmissionSet / GammaEmissionMinted) that
-- land raw-only in chain_detail_chain_events today. kind spells the event as
-- the chain spells it rather than pinning an enum the runtime still extends
-- (same reasoning as app.stake_locks.kind). The identity and amount columns
-- are nullable because the kinds carry different shapes: a NULL is "this
-- event does not carry that field", never an erased value.
CREATE TABLE app.gamma_events (
    block_number bigint NOT NULL CHECK (block_number >= 0),
    event_index integer NOT NULL CHECK (event_index >= 0),
    kind text COLLATE "C" NOT NULL CHECK (kind <> ''),
    netuid bigint CHECK (netuid IS NULL OR netuid BETWEEN 0 AND 65535),
    coldkey text COLLATE "C" CHECK (coldkey IS NULL OR coldkey <> ''),
    hotkey text COLLATE "C" CHECK (hotkey IS NULL OR hotkey <> ''),
    amount text COLLATE "C" CHECK (
        amount IS NULL OR ((amount = '0' OR amount ~ '^[1-9][0-9]*$')
            AND (length(amount), amount) <= (20, '18446744073709551615'))
    ),
    occurred_at bigint NOT NULL CHECK (occurred_at >= 1000000000000),
    PRIMARY KEY (block_number, event_index)
);

-- Event-kind timelines (the per-kind feeds the serving tier will read once
-- the decode fills this) scan by kind, newest block first.
CREATE INDEX idx_gamma_events_kind
    ON app.gamma_events (kind, block_number DESC);

-- One row per (netuid, hotkey): the service-URL registry the engine fills
-- from SubtensorModule.Services (events ServiceSet / ServiceRemoved; a
-- removed service deletes its row). set_at is the block the URL was last
-- set at, NULL when the chain did not carry it.
CREATE TABLE app.subnet_services (
    netuid bigint NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    hotkey text COLLATE "C" NOT NULL CHECK (hotkey <> ''),
    service_url text NOT NULL CHECK (service_url <> ''),
    set_at bigint CHECK (set_at IS NULL OR set_at >= 0),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (netuid, hotkey)
);

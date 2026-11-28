-- Each subnet's emission split and lifecycle state (runtime spec 497;
-- MET-7365, ADR 0029 phase 2). The first tables of the `state` schema:
-- decoded on-chain state over time, kept as validity ranges (ADR 0029 §2).
--
-- A row holds the values a capture observed from block `valid_from` on. It is
-- closed at `valid_to` (exclusive) by the first capture that observed other
-- values, so history costs one row per change rather than one per capture,
-- and the current row is the one whose `valid_to` is NULL. The blocks are the
-- capture's own finalized observation blocks: a change happened somewhere in
-- (the previous observation, valid_from], which at the burn tick's 15-minute
-- cadence is about 75 blocks. The event log (SubnetEmissionWeightsSet,
-- EpochConsensusSet) carries the exact block where a reader needs it.
--
-- Mainnet-only, like every table without a network column.

CREATE SCHEMA IF NOT EXISTS state;

-- SubtensorModule.SubnetEmissionWeights, the five fixed slots
-- `[burn, recycle, owner, validator, miner]`, and SubnetGammaEmission, the
-- subnet's `(target netuid, parts)` shares converted each epoch into the
-- target's gamma, at most sixteen and each at most 10%. Every slot and share
-- is u64 parts of u64::MAX, and the five slots and the shares sum to exactly
-- u64::MAX (measured on all 130 mainnet subnets at block 9,602,145). Parts
-- are numeric(20, 0): u64::MAX does not fit a bigint, and a float cannot
-- carry the runtime's exact split.
CREATE TABLE state.subnet_emission_splits (
    netuid integer NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    valid_from bigint NOT NULL CHECK (valid_from >= 0),
    valid_to bigint CHECK (valid_to IS NULL OR valid_to > valid_from),
    burn_parts numeric(20, 0) NOT NULL
        CHECK (burn_parts BETWEEN 0 AND 18446744073709551615),
    recycle_parts numeric(20, 0) NOT NULL
        CHECK (recycle_parts BETWEEN 0 AND 18446744073709551615),
    owner_parts numeric(20, 0) NOT NULL
        CHECK (owner_parts BETWEEN 0 AND 18446744073709551615),
    validator_parts numeric(20, 0) NOT NULL
        CHECK (validator_parts BETWEEN 0 AND 18446744073709551615),
    miner_parts numeric(20, 0) NOT NULL
        CHECK (miner_parts BETWEEN 0 AND 18446744073709551615),
    -- [{"target": <netuid>, "parts": "<u64 as decimal text>"}, ...] in
    -- ascending target order, as the runtime keeps them.
    gamma_shares jsonb NOT NULL CHECK (
        jsonb_typeof(gamma_shares) = 'array'
            AND jsonb_array_length(gamma_shares) <= 16
    ),
    PRIMARY KEY (netuid, valid_from)
);
CREATE UNIQUE INDEX subnet_emission_splits_current
    ON state.subnet_emission_splits (netuid) WHERE valid_to IS NULL;

-- SubtensorModule.SubnetState, the subnet's lifecycle: `registered` (its
-- start call has not completed), `started`, `pending_dissolution` (it has
-- left the active set and waits for cleanup) and `dissolving` (on_idle is
-- cleaning it up); SubnetEpochConsensus, `yuma` or `null` (the largest-stake
-- validator's weights and stake-proportional dividends); and
-- SubnetCreatedViaLease. A netuid with no SubnetState is no subnet, so its
-- current row closes and none opens until the netuid is registered again.
CREATE TABLE state.subnet_lifecycle_states (
    netuid integer NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    valid_from bigint NOT NULL CHECK (valid_from >= 0),
    valid_to bigint CHECK (valid_to IS NULL OR valid_to > valid_from),
    stage text COLLATE "C" NOT NULL CHECK (
        stage IN ('registered', 'started', 'pending_dissolution', 'dissolving')
    ),
    epoch_consensus text COLLATE "C" NOT NULL
        CHECK (epoch_consensus IN ('yuma', 'null')),
    created_via_lease boolean NOT NULL,
    PRIMARY KEY (netuid, valid_from)
);
CREATE UNIQUE INDEX subnet_lifecycle_states_current
    ON state.subnet_lifecycle_states (netuid) WHERE valid_to IS NULL;

-- The newest block each family was observed whole at. A validity range says
-- what held from when; this says until when it is known to hold, so a reader
-- can tell a current row from one whose producer stopped.
CREATE TABLE state.observations (
    family text COLLATE "C" PRIMARY KEY CHECK (
        family IN ('subnet_emission_splits', 'subnet_lifecycle_states')
    ),
    block_number bigint NOT NULL CHECK (block_number >= 0),
    observed_at timestamptz NOT NULL
);

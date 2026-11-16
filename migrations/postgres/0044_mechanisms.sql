-- The mechanism (mechid) dimension (#13162, runtime v490; #13161, epic #13142).
--
-- Ingestion dedupes get_all_metagraphs_info(all_mechanisms=True) to mechid 0
-- today (scripts/fetch-native-subnets.py, scripts/fetch-metagraph-native.py),
-- so every existing row IS mechanism 0 and the DEFAULT 0 backfills them
-- truthfully. The per-mechanism producers (ConsensusByMechanism decode,
-- mechid-keyed neuron state) land with the engine; this migration only gives
-- their rows a keyed place to land and the serving tier a column to read.
--
-- Key order puts mechid directly after netuid: a mechanism is a sub-subnet,
-- so every (netuid) scan stays a prefix scan and every (netuid, mechid) scan
-- becomes one.
--
-- NOT changed here, deliberately: app.neuron_document_projections and the
-- receipt triggers around it stay keyed on (source_table, netuid, day, shard).
-- They remain correct while only mechid-0 documents exist (the DEFAULT below
-- is every current row); the engine change that first writes a mechid > 0
-- document must extend the receipt key in the same PR that makes it possible.

ALTER TABLE app.neurons_members
    ADD COLUMN mechid smallint NOT NULL DEFAULT 0 CHECK (mechid >= 0);
ALTER TABLE app.neurons_members
    DROP CONSTRAINT neurons_members_pkey,
    ADD PRIMARY KEY (netuid, mechid, uid);

ALTER TABLE app.neuron_daily_members
    ADD COLUMN mechid smallint NOT NULL DEFAULT 0 CHECK (mechid >= 0);
ALTER TABLE app.neuron_daily_members
    DROP CONSTRAINT neuron_daily_members_pkey,
    ADD PRIMARY KEY (netuid, mechid, uid, snapshot_date);

ALTER TABLE app.neurons_documents
    ADD COLUMN mechid smallint NOT NULL DEFAULT 0 CHECK (mechid >= 0);
ALTER TABLE app.neurons_documents
    DROP CONSTRAINT neurons_documents_pkey,
    ADD PRIMARY KEY (netuid, mechid, day, shard);

-- One row per (netuid, mechid): the mechanism registry the engine fills from
-- SubtensorModule.MechanismCountCurrent / MechanismEmissionSplit /
-- ConsensusByMechanism. emission_split is the mechanism's share of the
-- subnet's emission (0..1); consensus_mode names the per-mechanism consensus
-- variant as the chain spells it. captured_at is epoch-ms, same floor as the
-- neuron document stamps.
CREATE TABLE app.subnet_mechanisms (
    netuid bigint NOT NULL,
    mechid smallint NOT NULL CHECK (mechid >= 0),
    emission_split double precision CHECK (
        emission_split IS NULL OR (emission_split >= 0 AND emission_split <= 1)
    ),
    consensus_mode text,
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (netuid, mechid)
);

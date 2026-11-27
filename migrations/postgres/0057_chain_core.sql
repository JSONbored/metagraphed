-- The chain core (ADR 0029, phase 1; #13287).
--
-- Finalized chain facts in the typed model: accounts are a bigint surrogate
-- for the 32-byte public key, hashes are bytea, amounts are bigint rao, and
-- the per-block facts are partitioned by network and then by block range, so
-- retention drops whole partitions and never deletes rows. Blocks are kept
-- for all of history; extrinsics, events and account events for a declared
-- window (chain.drop_partitions_below).
--
-- The provenance core's chain index (a producer design that never ran) holds
-- three of these names. Its tables are retired here, refused if any holds a
-- row, so that the names below belong to this model alone.
CREATE SCHEMA IF NOT EXISTS chain;

DO $$
DECLARE
  relation text;
  held bigint;
BEGIN
  FOREACH relation IN ARRAY ARRAY['chain.event_participants', 'chain.events',
    'chain.extrinsics', 'chain.block_publications', 'chain.blocks'] LOOP
    IF to_regclass(relation) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %s', relation) INTO held;
      IF held > 0 THEN
        RAISE EXCEPTION '% holds % rows: the chain core replaces only an empty table', relation, held;
      END IF;
    END IF;
  END LOOP;
END $$;
DROP TABLE IF EXISTS chain.event_participants, chain.events, chain.extrinsics,
  chain.block_publications, chain.blocks CASCADE;

-- The provenance core created this table with more (nullable) columns; a
-- database without it gets the two this model reads.
CREATE TABLE IF NOT EXISTS chain.networks (
  network_id text PRIMARY KEY CHECK (network_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  genesis_hash text NOT NULL CHECK (genesis_hash ~ '^0x[0-9a-f]{64}$')
);
-- Read from each network's chain_getBlockHash(0) on 2026-11-27.
INSERT INTO chain.networks (network_id, genesis_hash) VALUES
  ('finney', '0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03'),
  ('testnet', '0x8f9cf856bf558a14440e75569c9e58594757048d7b3a84b5d25f6bd978263105')
ON CONFLICT (network_id) DO NOTHING;

-- One row per public key ever seen, on any network (a key is the same
-- account on both). ss58 is its generic-prefix (42) rendering, which both
-- networks use; routes resolve an address to `account` once.
CREATE TABLE chain.accounts (
  account bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_key bytea NOT NULL UNIQUE CHECK (octet_length(public_key) = 32),
  ss58 text COLLATE "C" NOT NULL UNIQUE CHECK (ss58 ~ '^[1-9A-HJ-NP-Za-km-z]{47,48}$'),
  -- A pallet-derived account ("modl" + pallet id): its fee and emission
  -- bookkeeping is kept out of the account index (chain.account_events).
  pallet boolean GENERATED ALWAYS AS (substring(public_key FROM 1 FOR 4) = '\x6d6f646c'::bytea) STORED,
  first_network_id text NOT NULL REFERENCES chain.networks,
  first_block bigint NOT NULL CHECK (first_block >= 0)
);

-- Dimensions: a call or event kind is a smallint in the fact tables.
CREATE TABLE chain.calls (
  call smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pallet text COLLATE "C" NOT NULL CHECK (length(pallet) BETWEEN 1 AND 128),
  name text COLLATE "C" NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  UNIQUE (pallet, name)
);
CREATE TABLE chain.event_kinds (
  kind smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pallet text COLLATE "C" NOT NULL CHECK (length(pallet) BETWEEN 1 AND 128),
  name text COLLATE "C" NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  UNIQUE (pallet, name)
);

-- Every finalized block, for all of history. produced_at is the block's own
-- Timestamp.set; fee_rao and tip_rao are its extrinsics' totals.
CREATE TABLE chain.blocks (
  network_id text NOT NULL REFERENCES chain.networks,
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash bytea NOT NULL CHECK (octet_length(block_hash) = 32),
  spec_version integer NOT NULL CHECK (spec_version >= 0),
  produced_at timestamptz,
  extrinsic_count integer NOT NULL CHECK (extrinsic_count >= 0),
  event_count integer NOT NULL CHECK (event_count >= 0),
  fee_rao bigint NOT NULL CHECK (fee_rao >= 0),
  tip_rao bigint NOT NULL CHECK (tip_rao >= 0),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (network_id, block_number),
  UNIQUE (network_id, block_hash)
);
CREATE INDEX blocks_produced_at ON chain.blocks (network_id, produced_at DESC);

CREATE TABLE chain.extrinsics (
  network_id text NOT NULL,
  block_number bigint NOT NULL,
  extrinsic_index integer NOT NULL CHECK (extrinsic_index >= 0),
  -- NULL where the decoder could not say: an undecoded call, an unknown
  -- outcome, an unrendered hash or arguments.
  extrinsic_hash bytea CHECK (octet_length(extrinsic_hash) = 32),
  signer bigint REFERENCES chain.accounts,
  call smallint REFERENCES chain.calls,
  success boolean,
  fee_rao bigint CHECK (fee_rao >= 0),
  tip_rao bigint CHECK (tip_rao >= 0),
  args jsonb,
  PRIMARY KEY (network_id, block_number, extrinsic_index),
  FOREIGN KEY (network_id, block_number) REFERENCES chain.blocks
) PARTITION BY LIST (network_id);
CREATE INDEX extrinsics_hash ON chain.extrinsics (extrinsic_hash) WHERE extrinsic_hash IS NOT NULL;
CREATE INDEX extrinsics_signer ON chain.extrinsics (signer, block_number DESC, extrinsic_index DESC)
  WHERE signer IS NOT NULL;
CREATE INDEX extrinsics_call ON chain.extrinsics (call, block_number DESC, extrinsic_index DESC);

-- phase: 0 initialization, 1 an extrinsic's, 2 finalization.
CREATE TABLE chain.events (
  network_id text NOT NULL,
  block_number bigint NOT NULL,
  event_index integer NOT NULL CHECK (event_index >= 0),
  kind smallint NOT NULL REFERENCES chain.event_kinds,
  phase smallint NOT NULL CHECK (phase IN (0, 1, 2)),
  extrinsic_index integer CHECK (extrinsic_index >= 0),
  args jsonb,
  CHECK ((phase = 1) = (extrinsic_index IS NOT NULL)),
  PRIMARY KEY (network_id, block_number, event_index),
  FOREIGN KEY (network_id, block_number) REFERENCES chain.blocks
) PARTITION BY LIST (network_id);
CREATE INDEX events_kind ON chain.events (kind, block_number DESC, event_index DESC);

-- The account index: one row per staking-domain event that names an account,
-- with its typed amounts. Pallet accounts' Deposit and Withdraw rows are not
-- indexed (about nine in ten of all rows, the per-block emission into every
-- subnet's account); the events themselves stay in chain.events.
CREATE TABLE chain.account_events (
  network_id text NOT NULL,
  block_number bigint NOT NULL,
  event_index integer NOT NULL CHECK (event_index >= 0),
  extrinsic_index integer CHECK (extrinsic_index >= 0),
  kind smallint NOT NULL REFERENCES chain.event_kinds,
  coldkey bigint REFERENCES chain.accounts,
  hotkey bigint REFERENCES chain.accounts,
  netuid integer CHECK (netuid BETWEEN 0 AND 65535),
  uid integer CHECK (uid BETWEEN 0 AND 65535),
  amount_rao bigint,
  alpha_rao bigint,
  CHECK (coldkey IS NOT NULL OR hotkey IS NOT NULL),
  PRIMARY KEY (network_id, block_number, event_index),
  FOREIGN KEY (network_id, block_number) REFERENCES chain.blocks
) PARTITION BY LIST (network_id);
CREATE INDEX account_events_coldkey ON chain.account_events (coldkey, block_number DESC, event_index DESC)
  WHERE coldkey IS NOT NULL;
CREATE INDEX account_events_hotkey ON chain.account_events (hotkey, block_number DESC, event_index DESC)
  WHERE hotkey IS NOT NULL;

-- What each family holds completely, as one contiguous block range per
-- network. A route's completeness claim reads this, not max(block_number).
CREATE TABLE chain.coverage (
  network_id text NOT NULL REFERENCES chain.networks,
  family text NOT NULL CHECK (family IN ('blocks', 'extrinsics', 'events', 'account_events')),
  complete_from bigint NOT NULL CHECK (complete_from >= 0),
  complete_through bigint NOT NULL CHECK (complete_through >= complete_from),
  updated_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (network_id, family)
);

-- Partitions: one list partition per network, then one range partition per
-- 50,400 blocks (seven days at twelve seconds) named <family>_<network>_<k>
-- for blocks [k * 50400, (k + 1) * 50400). The writer calls this before each
-- batch; it runs as the schema's owner so the writer's login needs no DDL
-- authority, and it refuses anything but a network and a bounded range.
CREATE FUNCTION chain.ensure_partitions(p_network text, p_first bigint, p_last bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, chain
AS $$
DECLARE
  span constant bigint := 50400;
  family text;
  parent text;
  part text;
  k bigint;
  created integer := 0;
BEGIN
  IF p_network IS NULL OR p_network !~ '^[a-z][a-z0-9]{0,30}$' THEN
    RAISE EXCEPTION 'chain.ensure_partitions: invalid network';
  END IF;
  IF NOT EXISTS (SELECT FROM chain.networks WHERE network_id = p_network) THEN
    RAISE EXCEPTION 'chain.ensure_partitions: unknown network %', p_network;
  END IF;
  IF p_first IS NULL OR p_last IS NULL OR p_first < 0 OR p_last < p_first
     OR p_last / span - p_first / span > 64 THEN
    RAISE EXCEPTION 'chain.ensure_partitions: invalid block range';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('chain.ensure_partitions'));
  FOREACH family IN ARRAY ARRAY['extrinsics', 'events', 'account_events'] LOOP
    parent := family || '_' || p_network;
    IF to_regclass('chain.' || parent) IS NULL THEN
      EXECUTE format('CREATE TABLE chain.%I PARTITION OF chain.%I FOR VALUES IN (%L) PARTITION BY RANGE (block_number)',
        parent, family, p_network);
      created := created + 1;
    END IF;
    FOR k IN (p_first / span) .. (p_last / span) LOOP
      part := parent || '_' || k;
      IF to_regclass('chain.' || part) IS NULL THEN
        EXECUTE format('CREATE TABLE chain.%I PARTITION OF chain.%I FOR VALUES FROM (%s) TO (%s)',
          part, parent, k * span, (k + 1) * span);
        created := created + 1;
      END IF;
    END LOOP;
  END LOOP;
  RETURN created;
END $$;

-- Retention: drop a family's partitions that end at or below p_below, and
-- move its coverage record's start to the first block still held. Refuses
-- to drop the partition holding the family's newest row.
CREATE FUNCTION chain.drop_partitions_below(p_family text, p_network text, p_below bigint)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, chain
AS $$
DECLARE
  span constant bigint := 50400;
  parent text;
  part record;
  k bigint;
  newest bigint;
  dropped integer := 0;
BEGIN
  IF p_family IS NULL OR p_family NOT IN ('extrinsics', 'events', 'account_events') THEN
    RAISE EXCEPTION 'chain.drop_partitions_below: invalid family';
  END IF;
  IF p_network IS NULL OR p_network !~ '^[a-z][a-z0-9]{0,30}$' THEN
    RAISE EXCEPTION 'chain.drop_partitions_below: invalid network';
  END IF;
  IF p_below IS NULL OR p_below < 0 THEN
    RAISE EXCEPTION 'chain.drop_partitions_below: invalid block';
  END IF;
  parent := p_family || '_' || p_network;
  IF to_regclass('chain.' || parent) IS NULL THEN
    RETURN 0;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('chain.ensure_partitions'));
  EXECUTE format('SELECT max(block_number) FROM chain.%I', parent) INTO newest;
  FOR part IN
    SELECT c.relname
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = ('chain.' || parent)::regclass AND n.nspname = 'chain'
  LOOP
    IF part.relname !~ ('^' || parent || '_[0-9]+$') THEN
      CONTINUE;
    END IF;
    k := substring(part.relname FROM '_([0-9]+)$')::bigint;
    IF (k + 1) * span <= p_below AND (newest IS NULL OR newest >= (k + 1) * span) THEN
      EXECUTE format('DROP TABLE chain.%I', part.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  IF dropped > 0 THEN
    DELETE FROM chain.coverage
    WHERE network_id = p_network AND family = p_family AND complete_through < (p_below / span) * span;
    UPDATE chain.coverage
    SET complete_from = greatest(complete_from, (p_below / span) * span), updated_at = transaction_timestamp()
    WHERE network_id = p_network AND family = p_family;
  END IF;
  RETURN dropped;
END $$;

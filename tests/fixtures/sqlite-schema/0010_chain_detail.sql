-- The chain-detail HOT TIER (#9208): a rolling window of the three decoded
-- per-block families, close enough to chain tip that a block explorer's
-- drill-down is current instead of up to an hour stale.
--
-- WHY THIS EXISTS. `blocks_head` (0003) carries block HEADERS to chain tip, so
-- the block LIST is realtime. Extrinsics and events live only in the R2 Iceberg
-- lakehouse, and rows land there only when the hourly batch decoder runs.
-- Measured in production against head 8,762,608 (2026-08-03): block 8,759,000
-- answered 29 extrinsics / 100 events, block 8,762,600 answered 0 and 0. The
-- list looked healthy right up until someone clicked a recent block.
--
-- These four tables are where the live-follow decode lane POSTs instead
-- (POST /api/v1/internal/chain-detail-sync). They are NOT an archive: history
-- is the lakehouse's job, and src/chain-detail-prune.ts drops everything the
-- cold tier has already absorbed. Nothing here is ever backfilled.
--
-- COLUMN SETS ARE NOT TRANSCRIBED BY HAND. They are exactly the lists the
-- writer binds (CHAIN_DETAIL_*_COLUMNS in src/chain-detail-d1-write.ts), and
-- tests/chain-detail-d1-schema.test.ts asserts that correspondence in both
-- directions -- 0007/0009's anti-drift guarantee, applied here.
--
-- TYPE CHOICES, and the one that is not obvious:
--   block/event/extrinsic indices, netuid, uid, spec_version -> INTEGER
--   observed_at / synced_at (epoch ms)                       -> INTEGER
--   success flag                                             -> INTEGER 0/1
--   call_args / args (the RAW scale_value enum tree)         -> TEXT, verbatim
--   fee_tao / tip_tao / amount_tao / alpha_amount            -> TEXT
--
-- The TAO amounts are TEXT, not REAL, deliberately. The producer sends exact
-- decimal STRINGS because a rao-precision value (9 dp on a quantity that
-- reaches 10^7 TAO) is not representable in a float64 without loss, and
-- round-tripping through REAL would introduce that loss inside our own store
-- rather than at the edge. The serve-time formatters (toTaoOrNull in
-- src/extrinsics.ts / src/account-events.ts) already Number()-coerce a numeric
-- STRING -- they were written for D1 and handle both -- so TEXT costs the read
-- path nothing and keeps the written value exactly what the chain said.
--
-- call_args/args are stored VERBATIM, un-normalized, for the same reason the
-- cold tier does: src/scale-normalize.ts, src/postgres-call-args.ts and
-- src/chain-event-args.ts run at SERVE time, tier-agnostically. Pre-transforming
-- on write would make a hot-tier row decode differently from a cold-tier one,
-- which is precisely the thing every cold-tier module in this family goes out
-- of its way to prevent.

-- The COVERAGE REGISTER, and the reason it is a table rather than a MIN/MAX
-- over the row tables.
--
-- An empty extrinsics array is indistinguishable from a block that genuinely
-- had none -- that ambiguity IS the bug #9208 exists to kill. A row here is the
-- lane's assertion "block N was decoded and this is what it contained", so an
-- empty answer for a block PRESENT here is a measured zero, while a block
-- ABSENT here is outside the window and must be declined, never answered with
-- an empty list. MIN/MAX over `chain_detail_extrinsics` could not tell those
-- apart: a block whose rows are all in one family would read as covered by that
-- family and uncovered by the others.
--
-- It also carries the per-family counts the lane observed, so a partial write
-- is detectable after the fact (count says 143, table holds 140), and it is
-- what the head endpoint and the staleness watchdog read.
CREATE TABLE IF NOT EXISTS chain_detail_blocks (
  block_number        INTEGER NOT NULL,
  block_hash          TEXT    NOT NULL,
  spec_version        INTEGER,
  extrinsic_count     INTEGER NOT NULL,
  chain_event_count   INTEGER NOT NULL,
  account_event_count INTEGER NOT NULL,
  observed_at         INTEGER NOT NULL,
  synced_at           INTEGER NOT NULL,
  PRIMARY KEY (block_number)
);
-- Drill-down by block HASH resolves here before the lakehouse is asked.
CREATE INDEX IF NOT EXISTS idx_chain_detail_blocks_hash
  ON chain_detail_blocks (block_hash);

-- One decoded extrinsic. Natural key (block_number, extrinsic_index), which is
-- also the read order for a block's extrinsics, so the PK index serves the
-- drill-down with no second index.
--
-- NULLABILITY IS LOAD-BEARING on three columns:
--   signer  is NULL for inherents and unsigned extrinsics -- most blocks open
--           with three of them, so NOT NULL here would reject real blocks;
--   success is NULL when no System.ExtrinsicSuccess/Failed event correlated to
--           this index. That is "undetermined", NOT "failed", and the API
--           contract already carries the three-valued shape;
--   fee_tao/tip_tao are NULL on the same unsigned extrinsics that have no
--           signer to charge.
CREATE TABLE IF NOT EXISTS chain_detail_extrinsics (
  block_number    INTEGER NOT NULL,
  extrinsic_index INTEGER NOT NULL,
  extrinsic_hash  TEXT,
  signer          TEXT,
  call_module     TEXT,
  call_function   TEXT,
  success         INTEGER CHECK (success IN (0, 1)),
  fee_tao         TEXT,
  tip_tao         TEXT,
  call_args       TEXT,
  observed_at     INTEGER NOT NULL,
  PRIMARY KEY (block_number, extrinsic_index)
);
-- /api/v1/extrinsics/{hash} drill-down. The composite `<block>-<index>` form of
-- that same route uses the PK instead.
CREATE INDEX IF NOT EXISTS idx_chain_detail_extrinsics_hash
  ON chain_detail_extrinsics (extrinsic_hash);

-- Every event in the block, pallet/method as emitted. `phase` is the SCALE
-- variant name (ApplyExtrinsic | Finalization | Initialization); extrinsic_index
-- is set only for the ApplyExtrinsic phase and NULL for the other two, which is
-- how a block's on-initialize/on-finalize work stays distinguishable from an
-- extrinsic's own effects.
CREATE TABLE IF NOT EXISTS chain_detail_chain_events (
  block_number    INTEGER NOT NULL,
  event_index     INTEGER NOT NULL,
  pallet          TEXT    NOT NULL,
  method          TEXT    NOT NULL,
  args            TEXT,
  phase           TEXT    NOT NULL,
  extrinsic_index INTEGER,
  observed_at     INTEGER NOT NULL,
  PRIMARY KEY (block_number, event_index)
);
-- The events one extrinsic emitted, for the extrinsic-detail drill-down.
CREATE INDEX IF NOT EXISTS idx_chain_detail_chain_events_extrinsic
  ON chain_detail_chain_events (block_number, extrinsic_index);

-- The curated account-scoped projection of the same stream: the subset of
-- events that name an account, with the hotkey/coldkey/netuid/uid/amount legs
-- lifted out of `args` into columns. NOT a duplicate of chain_events -- it is a
-- different, narrower row shape with its own formatter (formatAccountEvent),
-- and the two feed different routes (/blocks/{n}/events vs
-- /blocks/{n}/chain-events).
--
-- event_kind is the VARIANT NAME alone (StakeAdded), never pallet-qualified,
-- matching the lakehouse column the cold tier filters on -- a qualified value
-- here would make an `?kind=` filter match on one tier and miss on the other.
CREATE TABLE IF NOT EXISTS chain_detail_account_events (
  block_number    INTEGER NOT NULL,
  event_index     INTEGER NOT NULL,
  extrinsic_index INTEGER,
  event_kind      TEXT    NOT NULL,
  hotkey          TEXT,
  coldkey         TEXT,
  netuid          INTEGER,
  uid             INTEGER,
  amount_tao      TEXT,
  alpha_amount    TEXT,
  observed_at     INTEGER NOT NULL,
  PRIMARY KEY (block_number, event_index)
);
-- The account_events one extrinsic emitted, embedded in the extrinsic-detail
-- payload exactly as the cold tier embeds them.
CREATE INDEX IF NOT EXISTS idx_chain_detail_account_events_extrinsic
  ON chain_detail_account_events (block_number, extrinsic_index);

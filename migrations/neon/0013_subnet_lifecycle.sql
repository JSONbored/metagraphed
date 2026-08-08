-- When a subnet was registered or deregistered (#10262).
--
-- Nothing records this today. Per-UID registration is well covered --
-- `neurons.registered_at_block`, `is_immunity_period`, a daily history in
-- `neuron_daily`, and three deregistration routes -- but per-SUBNET there is
-- no record at all. `subnets` holds registry metadata (slug, name, overlay)
-- with no lifecycle, and `subnet_emission_enabled_history` tracks emission
-- being switched on and off, which is a different event: a subnet can have
-- emission disabled and still exist.
--
-- The consequences are all silent. A deregistered subnet's `subnet_hyperparams`
-- row lingers forever (#10259), every count derived from it keeps counting a
-- subnet that is gone, and "how many subnets existed on 2026-06-01" is
-- unanswerable.
--
-- ## Modelled on subnet_emission_enabled_history
--
-- Same shape as the existing append-only chain-event history (77 rows, 72
-- netuids): one row per observed transition, never updated, with a
-- `predates_capture` flag. That flag is load-bearing rather than decorative --
-- the 129 subnets alive today were all registered before capture began, so
-- their `registered` rows carry a NULL block, and a consumer must be able to
-- tell "registered before we were watching" from "registered at block 0".
--
-- ## `event` is TEXT with a CHECK, not an enum
--
-- A Postgres enum needs ALTER TYPE to gain a member, which is a migration on a
-- live table for what is otherwise a one-line change; the repo already spells
-- closed sets this way (see `lane_health.verdict`). Re-registration is a second
-- `registered` row rather than a mutation of the first, which is what makes the
-- table answer "when, historically" rather than only "what now".

CREATE TABLE IF NOT EXISTS subnet_lifecycle (
  id               BIGSERIAL PRIMARY KEY,
  netuid           INTEGER NOT NULL,
  -- 'registered' | 'deregistered'
  event            TEXT    NOT NULL,
  -- NULL when the transition predates capture, or when the detecting pass
  -- could not attribute a block. A lifecycle event with no block is still a
  -- fact worth keeping; a fabricated block is not.
  block_number     BIGINT,
  observed_at      BIGINT  NOT NULL,
  -- TRUE for the seed rows: this subnet already existed when the lane first
  -- ran, so its registration is older than anything we can see.
  predates_capture BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT subnet_lifecycle_event_known
    CHECK (event IN ('registered', 'deregistered')),
  -- The same epoch-milliseconds floor 0010 put on the daily tables: 1e12 is
  -- 2001-09-09, and a seconds-valued stamp this decade is ~1.79e9. #9782 is
  -- what this prevents -- a stamp missing three digits produced a row dated
  -- 1970 that no later pass could revise, in a table exactly like this one.
  CONSTRAINT subnet_lifecycle_observed_at_is_millis
    CHECK (observed_at >= 1000000000000)
);

-- One subnet's own history, newest first: the /subnets/{netuid}/lifecycle read.
CREATE INDEX IF NOT EXISTS idx_subnet_lifecycle_netuid_time
  ON subnet_lifecycle (netuid, observed_at DESC);

-- The network-wide feed, windowed: "what changed lately".
CREATE INDEX IF NOT EXISTS idx_subnet_lifecycle_time
  ON subnet_lifecycle (observed_at DESC);

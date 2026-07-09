-- Personal (coldkey) chain identity (#4324/5.1). One row per account, latest
-- only, refreshed daily by the refresh-account-identity workflow (identities
-- change rarely) — latest-only, REPLACE-on-conflict. Distinct from subnet
-- identity (SubtensorModule::SubnetIdentitiesV3, migrations/0031_subnet_identity_history.sql)
-- — this is the identity a coldkey attaches to itself, not a subnet's.
--
-- Scoped to accounts that actually have an identity SET (scripts/fetch-account-
-- identity.py skips coldkeys with no ChainIdentity entry) — most accounts never
-- call set_identity, so this stays small without an explicit keyspace-
-- enumeration limit. Field shape verified from the installed Bittensor SDK's
-- ChainIdentity dataclass (bittensor==10.4.0,
-- bittensor/core/chain_data/chain_identity.py); every field is a plain string,
-- normalized from the chain's "" (unset) to NULL by the fetch script.
--
-- Capture-only for now: no serving route yet (lands with #4328/5.4).
CREATE TABLE IF NOT EXISTS account_identity (
  account       TEXT    NOT NULL, -- coldkey ss58
  name          TEXT,
  url           TEXT,
  github        TEXT,
  image         TEXT,
  discord       TEXT,
  description   TEXT,
  additional    TEXT,
  captured_at   INTEGER NOT NULL, -- epoch milliseconds
  PRIMARY KEY (account)
);

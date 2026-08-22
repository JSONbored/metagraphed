-- The three key-scoped stores could not represent a second identity system.
--
-- `api_quota_daily`, `api_key_usage_daily` and `api_key_blocks` each key on a
-- bare `integer` account_id with NO foreign key. Those integers are
-- `rpc_accounts` ids, but nothing in the database said so, and nothing stopped
-- a second id space being written into the same column.
--
-- There are now two id spaces. `github_accounts` is a separate table with its
-- own `id` sequence and its own `tier` column, and #11562 needs an OAuth
-- caller quota'd, blocked and metered like any other account. Both sequences
-- sit in the same low range today, so `github_accounts.id = 5` and
-- `rpc_accounts.id = 5` would share a quota row, a blocklist entry and a usage
-- row: one caller drawing down another's budget, and a block on one silently
-- blocking the other.
--
-- ## Why this migration is free right now
--
-- All three tables are EMPTY (verified 2026-08-21: 0 rows each). The primary
-- keys and the partial unique index can be repointed with no backfill and no
-- reconciliation. Every row written from here on carries its kind, so this
-- never needs doing again -- and doing it later would mean migrating live
-- billing data.
--
-- ## Why 'rpc' is the default
--
-- Correct for every row that could already exist: before this migration the
-- only writer was the API-key path, whose ids are `rpc_accounts` ids. The
-- default is what makes the column addition safe on a non-empty table too,
-- should this ever be re-run against one.
--
-- The vocabulary is owned by src/account-kind.ts; the CHECK below is what
-- stops a value outside that union creating a third, unqueryable id space.
-- Re-runnable: every statement is guarded, so a partial apply retries cleanly.

ALTER TABLE public.api_quota_daily
    ADD COLUMN IF NOT EXISTS account_kind text NOT NULL DEFAULT 'rpc';
ALTER TABLE public.api_key_usage_daily
    ADD COLUMN IF NOT EXISTS account_kind text NOT NULL DEFAULT 'rpc';
ALTER TABLE public.api_key_blocks
    ADD COLUMN IF NOT EXISTS account_kind text NOT NULL DEFAULT 'rpc';

ALTER TABLE public.api_quota_daily
    DROP CONSTRAINT IF EXISTS api_quota_daily_account_kind_check;
ALTER TABLE public.api_quota_daily
    ADD CONSTRAINT api_quota_daily_account_kind_check
    CHECK (account_kind IN ('rpc', 'github'));
ALTER TABLE public.api_key_usage_daily
    DROP CONSTRAINT IF EXISTS api_key_usage_daily_account_kind_check;
ALTER TABLE public.api_key_usage_daily
    ADD CONSTRAINT api_key_usage_daily_account_kind_check
    CHECK (account_kind IN ('rpc', 'github'));
ALTER TABLE public.api_key_blocks
    DROP CONSTRAINT IF EXISTS api_key_blocks_account_kind_check;
ALTER TABLE public.api_key_blocks
    ADD CONSTRAINT api_key_blocks_account_kind_check
    CHECK (account_kind IN ('rpc', 'github'));

-- The keys themselves. An account is (kind, id) from here on; the id alone is
-- not an identity and must not be usable as one.
ALTER TABLE public.api_quota_daily
    DROP CONSTRAINT IF EXISTS api_quota_daily_pkey;
ALTER TABLE public.api_quota_daily
    ADD CONSTRAINT api_quota_daily_pkey
    PRIMARY KEY (account_kind, account_id, day);

ALTER TABLE public.api_key_usage_daily
    DROP CONSTRAINT IF EXISTS api_key_usage_daily_pkey;
ALTER TABLE public.api_key_usage_daily
    ADD CONSTRAINT api_key_usage_daily_pkey
    PRIMARY KEY (account_kind, account_id, day, route);

-- Leads with the discriminator so a per-account lookup is still one index
-- range rather than a scan filtered after the fact.
DROP INDEX IF EXISTS public.idx_api_key_usage_daily_account_day;
CREATE INDEX IF NOT EXISTS idx_api_key_usage_daily_account_day
    ON public.api_key_usage_daily (account_kind, account_id, day DESC);

-- "One active block per account" was true per id; it has to be true per
-- (kind, id), or blocking a GitHub account would collide with an unrelated
-- active block on the rpc account of the same number.
DROP INDEX IF EXISTS public.idx_api_key_blocks_one_active_per_account;
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_blocks_one_active_per_account
    ON public.api_key_blocks (account_kind, account_id)
    WHERE unblocked_at IS NULL;

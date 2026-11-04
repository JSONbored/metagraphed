-- Source-load compatibility. These INTEGER-affinity D1 columns admit the
-- existing handlers' wide or fractional finite numeric inputs. This migration
-- touches only imported app tables; it needs no native auth/jobs bootstrap.
ALTER TABLE app.github_accounts
    ALTER COLUMN github_user_id TYPE numeric;
ALTER TABLE app.api_key_blocks
    ALTER COLUMN account_id TYPE numeric;
ALTER TABLE app.api_key_usage_daily
    ALTER COLUMN account_id TYPE numeric,
    ALTER COLUMN request_count TYPE numeric,
    ALTER COLUMN rejected_count TYPE numeric;
ALTER TABLE app.api_usage_rollup
    ALTER COLUMN request_count TYPE numeric,
    ALTER COLUMN keyed_count TYPE numeric;

-- Counter imports use sqlite_numeric_aggregate so INTEGER (scale zero) and
-- REAL (nonzero scale for finite values, or explicit Infinity/-Infinity) retain
-- their arithmetic kind. Identifiers use sqlite_numeric because equality does
-- not distinguish these two numeric storage classes. Quota remains finite-only.

-- Identity-plane handoff, collision half (infra#820 composition, 2026-11-16).
--
-- One PostgreSQL 18 composes two migration trees, and exactly one identity
-- table exists in both: this tree's D1-port staging `app.api_keys` (0010,
-- bigint/prefix/secret_hash/unkey shape) against the producer tree's modern
-- `app.api_keys` (uuid/token_digest/scopes -- subnet-ops
-- metagraphed/native-app/migrations, applied after this tree). The recorded
-- decision is (a)-refined: the producer tree owns the identity plane. The
-- staging twin retires here so the composed apply is collision-free.
--
-- `app.rpc_accounts` and `app.github_accounts` are deliberately NOT dropped
-- here: they collide with nothing (the producer tree creates neither), and
-- the native serving path still consumes them live -- the OAuth account-tier
-- lookup and the login upserts run against them through
-- ACCOUNT_STATE_STORE.sql (src/account-identity-pg.ts), which the complete
-- native environment gate (tests/native-environment.pg18.ts) exercises.
-- They retire WITH the infra#820 step-3 mapping re-derivation (#13040) that
-- re-points the read model (bigint ids, account_kind) onto the producer's
-- (uuid accounts via legacy_account_aliases) -- never ahead of it.
--
-- READERS/WRITERS of the retired api_keys shape, and where each retires:
--   * workers/data-api.ts api-key handlers (issue/list/revoke, unkey flows)
--     -- live on the legacy database today, which this migration does not
--     touch; their native-path statements fail by name (42P01) until the
--     step-3 re-point lands them on the producer plane's
--     create/list/revoke_api_key functions (#13040).
--   * Imported legacy key rows land through the infra#820 step-3 mapping
--     (digest model), never a straight copy into this shape.
--   * Serving-owned operational state (api_key_blocks, api_key_usage_daily,
--     api_quota_daily, api_usage_rollup*) stays in this tree, keyed exactly
--     as imported.
--
-- The twin is load-phase staging (0010 "Load phase"); on the composed apply
-- it is created empty by 0010 and retired here before the producer tree
-- runs. A row in it means the ordering above was violated -- import data
-- would be dropped -- so this migration refuses rather than deletes. And the
-- name alone does not identify the twin (engine review, #13224): on an
-- out-of-order or replayed apply the producer's own app.api_keys
-- (uuid/token_digest) can already stand under this name, and dropping THAT --
-- even empty -- would destroy the modern plane's shape. So the drop fires
-- only on the staging shape (legacy secret_hash column, no token_digest);
-- a producer-shaped table is left exactly as it stands.
DO $$
DECLARE
    twin_shape boolean;
    occupied boolean;
BEGIN
    IF EXISTS(SELECT FROM pg_tables WHERE schemaname = 'app' AND tablename = 'api_keys') THEN
        SELECT EXISTS(
                   SELECT FROM information_schema.columns
                   WHERE table_schema = 'app' AND table_name = 'api_keys'
                     AND column_name = 'secret_hash')
               AND NOT EXISTS(
                   SELECT FROM information_schema.columns
                   WHERE table_schema = 'app' AND table_name = 'api_keys'
                     AND column_name = 'token_digest')
            INTO STRICT twin_shape;
        IF twin_shape THEN
            SELECT EXISTS(SELECT FROM app.api_keys LIMIT 1) INTO STRICT occupied;
            IF occupied THEN
                RAISE EXCEPTION 'identity staging twin app.api_keys holds rows; move them through the infra#820 mapping before retiring the shape'
                    USING ERRCODE = '55000';
            END IF;
            DROP TABLE app.api_keys;
        END IF;
    END IF;
END;
$$;

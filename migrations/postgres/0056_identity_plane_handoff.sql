-- Identity-plane handoff (infra#820 composition decision, 2026-11-16).
--
-- One PostgreSQL 18 composes two migration trees, and schema `app` had two
-- owners for the identity family: this tree's D1-port staging twins
-- (`rpc_accounts`, `github_accounts`, `api_keys` from 0010) and the producer
-- tree's modern identity plane (`accounts`, `identities`,
-- `legacy_account_aliases`, `api_keys` with uuid/token_digest shapes --
-- subnet-ops metagraphed/native-app/migrations, applied after this tree).
-- The recorded decision is (a)-refined: the producer tree owns the identity
-- plane; nothing forward-migrates those tables except the producer tree. The
-- staging twins therefore retire here so the composed apply is collision-free.
--
-- READERS/WRITERS of the retired shapes, and where each retires:
--   * workers/data-api.ts identity handlers (tier lookups, api-key
--     issue/list/revoke, unkey flows) -- live on the legacy database today,
--     which this migration does not touch; their native-path statements run
--     through ACCOUNT_STATE_STORE.sql (src/account-identity-pg.ts) and retire
--     with the infra#820 step-3 mapping re-derivation (#13040), which re-points
--     the read model (bigint ids, prefix/secret_hash, account_kind) onto the
--     producer's (uuid accounts, token_digest, scopes/audience).
--   * The import families: legacy identity rows land as
--     `app.legacy_account_aliases` mapping rows against producer-owned
--     accounts/identities -- new mapping semantics owned by the infra#820
--     step-3 re-derivation, never a straight copy into these shapes.
--   * Serving-owned operational state (api_key_blocks, api_key_usage_daily,
--     api_quota_daily, api_usage_rollup*) stays in this tree, keyed by
--     (account_kind, legacy id) exactly as imported; reads resolve to producer
--     identities through legacy_account_aliases.
--
-- The twins are load-phase staging (0010 "Load phase"); on the composed apply
-- they are created empty by 0010 and retired here before the producer tree
-- runs. A row in any of them means the ordering above was violated -- import
-- data would be dropped -- so this migration refuses rather than deletes.
DO $$
DECLARE
    twin text;
    occupied boolean;
BEGIN
    FOREACH twin IN ARRAY ARRAY['rpc_accounts', 'github_accounts', 'api_keys'] LOOP
        IF EXISTS(SELECT FROM pg_tables WHERE schemaname = 'app' AND tablename = twin) THEN
            EXECUTE format('SELECT EXISTS(SELECT FROM app.%I LIMIT 1)', twin) INTO STRICT occupied;
            IF occupied THEN
                RAISE EXCEPTION 'identity staging twin app.% holds rows; move them through the infra#820 mapping before retiring the shape', twin
                    USING ERRCODE = '55000';
            END IF;
        END IF;
    END LOOP;
END;
$$;

DROP TABLE IF EXISTS app.api_keys;
DROP TABLE IF EXISTS app.github_accounts;
DROP TABLE IF EXISTS app.rpc_accounts;

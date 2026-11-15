-- Identity v2 labelling (#13166, runtime v490; #13161, epic #13142).
--
-- app.account_identity(+_history) stores the personal (coldkey) chain
-- identity without recording WHICH SubtensorModule identity map the capture
-- decoded. The live map is SubtensorModule.IdentitiesV2 (coldkey ->
-- { name, url, githubRepo, image, discord, description, additional }),
-- verified against live Finney v490 metadata (read-only state_getMetadata,
-- 2026-11-14): its seven fields map 1:1 onto the stored identity columns
-- (githubRepo lands in `github`; the legacy v1 map is gone from the runtime),
-- so no column is missing and none is stale -- the gap is purely the missing
-- version label.
--
-- storage_version is that label: 2 for a row decoded from IdentitiesV2,
-- higher the day the runtime adds a successor map. NULL on every row the
-- unlabelled capture wrote -- never backfilled as 2, because an unlabelled
-- row is not a measured version. The writer -- the engine's labelled
-- IdentitiesV2 decode (#13166's engine dependency) -- lands with the engine;
-- until it does, every row truthfully carries NULL and the serving surfaces
-- decline the field schema-stably.
ALTER TABLE app.account_identity
    ADD COLUMN storage_version bigint CHECK (
        storage_version IS NULL OR storage_version >= 1
    );

ALTER TABLE app.account_identity_history
    ADD COLUMN storage_version bigint CHECK (
        storage_version IS NULL OR storage_version >= 1
    );

-- Synthetic public serving relations, applied after the fixed SQL001–003 corpus.
-- This fixture does not issue source receipts, qualify candidates, or prove raw
-- custody. Real producer qualification is tested against the native migrations.
SET LOCAL ROLE metagraphed_owner;

ALTER TABLE ops.publications DROP CONSTRAINT publications_scope_check;
ALTER TABLE ops.publications ADD CONSTRAINT publications_scope_check
  CHECK (scope IN ('blocks','ecosystem','stake','account_balance'));
ALTER TABLE ops.publications ADD CONSTRAINT publication_registry_owner
  CHECK (registry_complete = (scope='ecosystem'));

ALTER TABLE registry.subnets RENAME COLUMN registered_at_block TO current_registration_block;
ALTER TABLE registry.subnets RENAME COLUMN is_active TO operational;
ALTER TABLE registry.subnets ALTER COLUMN name DROP NOT NULL;
ALTER TABLE registry.subnets DROP COLUMN mechanism_ids;
ALTER TABLE registry.subnets ADD COLUMN registration_counter numeric(20,0) NOT NULL
  CHECK (registration_counter BETWEEN 0 AND 18446744073709551614);
ALTER TABLE registry.subnets ADD COLUMN counter_source text NOT NULL
  CHECK (counter_source IN ('stored','runtime_default'));
ALTER TABLE registry.subnets ADD COLUMN baseline_history_unqualified boolean NOT NULL;
ALTER TABLE registry.subnets ADD COLUMN lifecycle text NOT NULL
  CHECK (lifecycle IN ('registered','started','pending_dissolution','dissolving'));
ALTER TABLE registry.subnets ADD COLUMN registration_block_source text NOT NULL
  CHECK (registration_block_source IN ('stored','runtime_default'));
ALTER TABLE registry.subnets ADD COLUMN pricing_mode_code integer NOT NULL
  CHECK (pricing_mode_code BETWEEN 0 AND 65535);
ALTER TABLE registry.subnets ADD COLUMN pricing_mode_source text NOT NULL
  CHECK (pricing_mode_source IN ('stored','runtime_default'));
ALTER TABLE registry.subnets ADD COLUMN mechanism_count integer CHECK (mechanism_count BETWEEN 1 AND 16);
ALTER TABLE registry.subnets ADD COLUMN mechanism_count_source text
  CHECK (mechanism_count_source IN ('stored','runtime_default'));
ALTER TABLE registry.subnets ADD COLUMN mechanism_availability text NOT NULL
  CHECK (mechanism_availability IN ('current','unavailable_during_cleanup'));
ALTER TABLE registry.subnets ADD COLUMN mechanisms jsonb NOT NULL
  CHECK (jsonb_typeof(mechanisms)='array' AND jsonb_array_length(mechanisms)<=16);
ALTER TABLE registry.subnets ADD CONSTRAINT subnet_source_semantics CHECK (
  netuid<4096 AND name IS NULL AND current_registration_block BETWEEN 0 AND 4294967295
  AND operational=(lifecycle IN ('registered','started'))
  AND baseline_history_unqualified=(netuid<>0 AND registration_counter=0)
  AND (counter_source<>'runtime_default' OR registration_counter=0)
  AND (registration_block_source<>'runtime_default' OR current_registration_block=0)
  AND (pricing_mode_source<>'runtime_default' OR pricing_mode_code=0)
  AND ((mechanism_availability='current' AND mechanism_count IS NOT NULL AND mechanism_count_source IS NOT NULL
      AND jsonb_array_length(mechanisms)=mechanism_count
      AND (mechanism_count_source<>'runtime_default' OR (mechanism_count=1 AND lifecycle<>'dissolving')))
    OR (mechanism_availability='unavailable_during_cleanup' AND lifecycle='dissolving'
      AND mechanism_count IS NULL AND mechanism_count_source IS NULL AND mechanisms='[]'::jsonb))
);
ALTER TABLE registry.subnets ADD CONSTRAINT subnet_generation_identity
  UNIQUE (publication_id,network_id,netuid,registration_counter);

ALTER TABLE registry.service_catalogs ADD COLUMN registration_counter numeric(20,0) NOT NULL
  CHECK (registration_counter BETWEEN 0 AND 18446744073709551614);
ALTER TABLE registry.schema_captures ADD COLUMN registration_counter numeric(20,0) NOT NULL
  CHECK (registration_counter BETWEEN 0 AND 18446744073709551614);
ALTER TABLE registry.service_versions ADD COLUMN registration_counter numeric(20,0) NOT NULL
  CHECK (registration_counter BETWEEN 0 AND 18446744073709551614);
ALTER TABLE registry.service_catalogs ADD CONSTRAINT catalog_generation_identity
  UNIQUE (catalog_id,network_id,netuid,registration_counter);
ALTER TABLE registry.schema_captures ADD CONSTRAINT schema_generation_identity
  UNIQUE (capture_id,network_id,netuid,registration_counter,service_id);
ALTER TABLE registry.service_catalogs ADD CONSTRAINT catalog_subnet_generation
  FOREIGN KEY (chain_publication_id,network_id,netuid,registration_counter)
  REFERENCES registry.subnets (publication_id,network_id,netuid,registration_counter);
ALTER TABLE registry.service_versions ADD CONSTRAINT service_catalog_generation
  FOREIGN KEY (catalog_id,network_id,netuid,registration_counter)
  REFERENCES registry.service_catalogs (catalog_id,network_id,netuid,registration_counter);
ALTER TABLE registry.service_versions ADD CONSTRAINT service_schema_generation
  FOREIGN KEY (schema_capture_id,network_id,netuid,registration_counter,service_id)
  REFERENCES registry.schema_captures (capture_id,network_id,netuid,registration_counter,service_id);

-- Explicit test admission replaces only the private eligible-view inputs. The
-- reader cannot see or change it. Withdrawal exercises serving refusal without
-- pretending to validate a private source/candidate/custody implementation.
CREATE TABLE registry.fixture_ecosystem_admissions (
  publication_id text PRIMARY KEY,
  network_id text NOT NULL,
  block_number bigint NOT NULL CHECK (block_number BETWEEN 0 AND 4294967295),
  block_publication_id text NOT NULL,
  source_id text NOT NULL CHECK (source_id ~ '^[0-9a-f]{64}$'),
  candidate_id text NOT NULL CHECK (candidate_id ~ '^[0-9a-f]{64}$'),
  snapshot_id text NOT NULL CHECK (snapshot_id ~ '^[0-9a-f]{64}$'),
  projection_contract integer NOT NULL CHECK (projection_contract=1),
  state_block_hash text NOT NULL CHECK (state_block_hash ~ '^0x[0-9a-f]{64}$'),
  state_metadata_digest text NOT NULL CHECK (state_metadata_digest ~ '^[0-9a-f]{64}$'),
  state_spec_version bigint NOT NULL CHECK (state_spec_version BETWEEN 0 AND 4294967295),
  state_transaction_version bigint NOT NULL CHECK (state_transaction_version BETWEEN 0 AND 4294967295),
  state_producer_revision text NOT NULL CHECK (state_producer_revision ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  profile_revision text NOT NULL CHECK (profile_revision ~ '^[a-z][a-z0-9-]{0,95}$'),
  upstream_revision text NOT NULL CHECK (upstream_revision ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  reportable_mechanisms_complete boolean NOT NULL,
  operational_netuids jsonb NOT NULL CHECK (jsonb_typeof(operational_netuids)='array'),
  residual_storage_netuids jsonb NOT NULL CHECK (jsonb_typeof(residual_storage_netuids)='array'),
  fixture_eligible boolean NOT NULL DEFAULT false,
  FOREIGN KEY (publication_id,network_id) REFERENCES ops.publications (publication_id,network_id),
  FOREIGN KEY (block_publication_id,network_id,block_number)
    REFERENCES chain.block_publications (publication_id,network_id,block_number)
);

CREATE VIEW registry.eligible_ecosystem_publications WITH (security_barrier=true) AS
SELECT p.*,a.source_id,a.candidate_id,a.snapshot_id,a.block_publication_id,a.projection_contract,
  a.state_block_hash,a.state_metadata_digest,a.state_spec_version,a.state_transaction_version,
  a.state_producer_revision,a.profile_revision,a.upstream_revision,
  'source_reviewed_candidate'::text AS qualification,false AS state_proof_verified,
  false AS runtime_semantics_attested,true AS enumeration_complete,
  a.reportable_mechanisms_complete,a.operational_netuids,a.residual_storage_netuids
FROM registry.fixture_ecosystem_admissions a
JOIN ops.publications p USING (publication_id)
WHERE a.fixture_eligible AND p.network_id=a.network_id AND p.last_block=a.block_number
  AND p.scope='ecosystem' AND p.stage='published' AND p.registry_complete;

REVOKE ALL ON registry.fixture_ecosystem_admissions FROM PUBLIC,metagraphed_ingest,metagraphed_serve,metagraphed_backup;
REVOKE ALL ON registry.eligible_ecosystem_publications FROM PUBLIC;
GRANT SELECT ON registry.eligible_ecosystem_publications TO metagraphed_serve,metagraphed_ingest,metagraphed_backup;
GRANT USAGE ON SCHEMA registry TO metagraphed_backup;
REVOKE INSERT ON registry.subnets FROM metagraphed_ingest;
-- Synthetic normalized read relations. These deliberately do not install the
-- private migration's encoder, reconstruction, source authority or write guards.
CREATE TABLE registry.schema_documents (
  digest text PRIMARY KEY CHECK(digest ~ '^[0-9a-f]{64}$'),
  document_json text NOT NULL,
  CHECK(digest=encode(sha256(convert_to(document_json,'UTF8')),'hex'))
);
CREATE TABLE registry.service_definitions (
  definition_id text PRIMARY KEY CHECK(definition_id ~ '^[0-9a-f]{64}$'),
  encoding text NOT NULL CHECK(encoding IN ('service-definition-v1','legacy-membership-v1')),
  name text NOT NULL,description text NOT NULL,kind text NOT NULL,base_url text NOT NULL,
  source_urls text[] NOT NULL,authentication jsonb NOT NULL,operations jsonb NOT NULL,
  search_document tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig,name||' '||description)) STORED
);
ALTER TABLE registry.service_versions ADD COLUMN definition_id text NOT NULL REFERENCES registry.service_definitions;
ALTER TABLE registry.schema_captures ADD CONSTRAINT capture_document FOREIGN KEY(digest) REFERENCES registry.schema_documents;
DROP INDEX registry.service_keyword_search;
ALTER TABLE registry.service_versions DROP COLUMN search_document;
ALTER TABLE registry.service_versions DROP COLUMN name,DROP COLUMN description,DROP COLUMN kind,
  DROP COLUMN base_url,DROP COLUMN source_urls,DROP COLUMN authentication,DROP COLUMN operations;
ALTER TABLE registry.schema_captures DROP COLUMN document_json;
CREATE INDEX service_definition_keyword_search ON registry.service_definitions USING gin(search_document);
CREATE INDEX service_membership_definition ON registry.service_versions(definition_id,catalog_id,service_id);
REVOKE ALL ON registry.schema_documents,registry.service_definitions FROM PUBLIC;
GRANT SELECT ON registry.schema_documents,registry.service_definitions TO metagraphed_serve;
REVOKE INSERT ON registry.service_versions,registry.schema_captures FROM metagraphed_ingest;
REVOKE INSERT(catalog_id,network_id,netuid,registered_at_block,chain_publication_id,observed_at,published_at,
  expires_at,producer_revision,expected_service_ids) ON registry.service_catalogs FROM metagraphed_ingest;
-- Test-only stake admissions and bodies reproduce the public read shape. They
-- do not install or stand in for the private source/root publication authority.
CREATE TABLE chain.fixture_stake_admissions (
  publication_id text PRIMARY KEY REFERENCES ops.publications,
  source_id text NOT NULL,root_candidate_id text NOT NULL,request_id text NOT NULL,
  stake_candidate_id text NOT NULL,ecosystem_candidate_id text NOT NULL,snapshot_id text NOT NULL,
  network_id text NOT NULL,block_number bigint NOT NULL,
  block_publication_id text NOT NULL,block_capture_digest text NOT NULL,block_metadata_digest text NOT NULL,
  block_parent_hash text NOT NULL,state_block_hash text NOT NULL,state_metadata_digest text NOT NULL,
  state_spec_version bigint NOT NULL,state_transaction_version bigint NOT NULL,state_producer_revision text NOT NULL,
  member_count bigint NOT NULL CHECK(member_count>=0),claimant_count bigint NOT NULL CHECK(claimant_count>=0),
  projection_contract smallint NOT NULL CHECK(projection_contract=1),fixture_eligible boolean NOT NULL DEFAULT false,
  FOREIGN KEY(publication_id,network_id) REFERENCES ops.publications(publication_id,network_id),
  FOREIGN KEY(block_publication_id,network_id,block_number) REFERENCES chain.block_publications
);
CREATE TABLE chain.fixture_stake_positions (
  publication_id text NOT NULL REFERENCES chain.fixture_stake_admissions,
  coldkey text COLLATE "C" NOT NULL,hotkey text COLLATE "C" NOT NULL,netuid integer NOT NULL,
  position jsonb NOT NULL,PRIMARY KEY(publication_id,coldkey,hotkey,netuid)
);
CREATE TABLE chain.fixture_root_entitlements (
  publication_id text NOT NULL REFERENCES chain.fixture_stake_admissions,
  coldkey_bytes bytea NOT NULL,hotkey_bytes bytea NOT NULL,entitlement jsonb NOT NULL,
  PRIMARY KEY(publication_id,coldkey_bytes,hotkey_bytes)
);
CREATE VIEW chain.eligible_stake_publications WITH(security_barrier=true) AS
SELECT p.*,a.source_id,a.root_candidate_id,a.request_id,a.stake_candidate_id,a.ecosystem_candidate_id,a.snapshot_id,
  a.block_publication_id,a.block_capture_digest,a.block_metadata_digest,a.block_parent_hash,a.member_count,a.claimant_count,a.projection_contract,
  a.state_block_hash,a.state_metadata_digest,a.state_spec_version,a.state_transaction_version,a.state_producer_revision,
  'source_reviewed_candidate'::text AS qualification,false AS state_proof_verified,false AS runtime_semantics_attested
FROM chain.fixture_stake_admissions a JOIN ops.publications p USING(publication_id,network_id)
JOIN chain.blocks b ON b.network_id=a.network_id AND b.block_number=a.block_number AND b.block_hash=a.state_block_hash
  AND b.parent_hash=a.block_parent_hash AND b.metadata_digest=a.block_metadata_digest
JOIN ops.publications captured ON captured.publication_id=a.block_publication_id AND captured.network_id=a.network_id
  AND captured.scope='blocks' AND captured.stage='published'
JOIN chain.raw_eligibility raw ON raw.digest=a.block_capture_digest AND raw.integrity_verified
  AND (raw.kind='opaque' OR raw.metadata_digest=a.block_metadata_digest)
JOIN ops.checkpoints coverage ON coverage.network_id=a.network_id AND coverage.family='blocks'
  AND a.block_number BETWEEN coverage.complete_from AND coverage.complete_through
WHERE a.fixture_eligible AND p.scope='stake' AND p.stage='published' AND NOT p.registry_complete
  AND p.last_block=a.block_number AND p.first_block=a.block_number
  AND NOT EXISTS(SELECT FROM ops.gaps g WHERE g.network_id=a.network_id AND g.family='blocks' AND g.resolved_at IS NULL
    AND g.start_block<=coverage.complete_through AND g.end_block>=coverage.complete_from);
CREATE VIEW chain.published_stake_positions WITH(security_barrier=true) AS
SELECT eligible.publication_id,eligible.network_id,body.coldkey,body.hotkey,body.netuid,body.position
FROM chain.eligible_stake_publications eligible JOIN chain.fixture_stake_positions body USING(publication_id);
CREATE VIEW chain.published_root_entitlements WITH(security_barrier=true) AS
SELECT eligible.publication_id,eligible.network_id,'0x'||encode(body.coldkey_bytes,'hex') AS coldkey,
  '0x'||encode(body.hotkey_bytes,'hex') AS hotkey,body.coldkey_bytes,body.hotkey_bytes,body.entitlement
FROM chain.eligible_stake_publications eligible JOIN chain.fixture_root_entitlements body USING(publication_id);
REVOKE ALL ON chain.fixture_stake_admissions,chain.fixture_stake_positions,chain.fixture_root_entitlements
  FROM PUBLIC,metagraphed_ingest,metagraphed_serve,metagraphed_backup;
REVOKE ALL ON chain.eligible_stake_publications,chain.published_stake_positions,chain.published_root_entitlements FROM PUBLIC;
GRANT SELECT ON chain.eligible_stake_publications,chain.published_stake_positions,chain.published_root_entitlements
  TO metagraphed_ingest,metagraphed_serve,metagraphed_backup;

-- Explicit controlled admissions model the serving boundary only. They do not
-- issue observations, prove physical custody, or replace production SQL028.
CREATE TABLE chain.fixture_account_balance_admissions (
  publication_id text NOT NULL,network_id text NOT NULL,account_id text NOT NULL,
  request_id text NOT NULL,observation_id text NOT NULL,snapshot_id text NOT NULL,
  block_number bigint NOT NULL,block_publication_id text NOT NULL,block_capture_digest text NOT NULL,
  block_metadata_digest text NOT NULL,block_parent_hash text NOT NULL,
  decoder_revision text NOT NULL,profile_revision text NOT NULL,upstream_revision text NOT NULL,
  projection_contract smallint NOT NULL CHECK(projection_contract=1),
  status text NOT NULL CHECK(status IN ('stored','not_stored')),account_info jsonb NOT NULL,
  state_block_hash text NOT NULL,state_metadata_digest text NOT NULL,
  state_spec_version bigint NOT NULL,state_transaction_version bigint NOT NULL,state_producer_revision text NOT NULL,
  fixture_eligible boolean NOT NULL DEFAULT false,
  PRIMARY KEY(publication_id,account_id),
  FOREIGN KEY(publication_id,network_id) REFERENCES ops.publications(publication_id,network_id),
  FOREIGN KEY(block_publication_id,network_id,block_number) REFERENCES chain.block_publications
);
CREATE INDEX fixture_account_balance_latest ON chain.fixture_account_balance_admissions(network_id,account_id,block_number DESC);
CREATE VIEW chain.eligible_account_balance_observations WITH(security_barrier=true) AS
SELECT a.*,p.generation,p.observed_at,p.published_at,n.genesis_hash,
  'rao'::text AS unit,'exact_keys'::text AS lookup_scope,
  'reviewed_source_metadata_candidate'::text AS qualification,false AS state_proof_verified,false AS runtime_semantics_attested
FROM chain.fixture_account_balance_admissions a JOIN ops.publications p USING(publication_id,network_id)
JOIN chain.networks n ON n.network_id=a.network_id
JOIN chain.blocks b ON b.network_id=a.network_id AND b.block_number=a.block_number AND b.block_hash=a.state_block_hash
  AND b.parent_hash=a.block_parent_hash AND b.metadata_digest=a.block_metadata_digest
JOIN ops.publications captured ON captured.publication_id=a.block_publication_id AND captured.network_id=a.network_id
  AND captured.scope='blocks' AND captured.stage='published'
JOIN chain.raw_eligibility raw ON raw.digest=a.block_capture_digest AND raw.integrity_verified
  AND (raw.kind='opaque' OR raw.metadata_digest=a.block_metadata_digest)
JOIN ops.checkpoints coverage ON coverage.network_id=a.network_id AND coverage.family='blocks'
  AND a.block_number BETWEEN coverage.complete_from AND coverage.complete_through
WHERE a.fixture_eligible AND p.scope='account_balance' AND p.stage='published' AND NOT p.registry_complete
  AND p.first_block=a.block_number AND p.last_block=a.block_number
  AND NOT EXISTS(SELECT FROM ops.gaps g WHERE g.network_id=a.network_id AND g.family='blocks'
    AND g.resolved_at IS NULL AND a.block_number BETWEEN g.start_block AND g.end_block);
REVOKE ALL ON chain.fixture_account_balance_admissions FROM PUBLIC,metagraphed_ingest,metagraphed_serve,metagraphed_backup;
REVOKE ALL ON chain.eligible_account_balance_observations FROM PUBLIC;
GRANT SELECT ON chain.eligible_account_balance_observations TO metagraphed_ingest,metagraphed_serve,metagraphed_backup;
RESET ROLE;

-- Re-key live health latest/daily rows onto stable surface_key (#1005 PR2).
--
-- Apply after 0005_surface_key.sql and before deploying prober code that uses
-- ON CONFLICT(surface_key). This migration is intentionally idempotent over the
-- current operational-surface map: it backfills known current ids, collapses any
-- same-key duplicates, then adds unique partial indexes for the new upsert
-- targets. surface_id remains the display/back-compat alias.

UPDATE surface_checks
SET surface_key = CASE surface_id
    WHEN 'allways-api-health' THEN 'srf-e81528d66302ee51'
    WHEN 'allways-crown' THEN 'srf-b4011f2dcaf520b8'
    WHEN 'allways-events-latest' THEN 'srf-cc1a1ad8cf1170b7'
    WHEN 'allways-miners' THEN 'srf-d4a66107344a3f28'
    WHEN 'allways-miners-leaderboard' THEN 'srf-611e6482fd15f376'
    WHEN 'allways-miners-reliability' THEN 'srf-7f553de2b7ed71ea'
    WHEN 'allways-network-overview' THEN 'srf-3517b995dfdb719a'
    WHEN 'allways-protocol-chain-state' THEN 'srf-117ca13385677b0a'
    WHEN 'allways-protocol-constants' THEN 'srf-cc58e48f67eab560'
    WHEN 'allways-sse' THEN 'srf-9a3013f8b54338b4'
    WHEN 'community-sn-14-subnet-api-api-cacheon-ai' THEN 'srf-08ad6da0db95e254'
    WHEN 'community-sn-7-subnet-api-api-all-ways-io' THEN 'srf-7ae24ec1e4ae7d50'
    WHEN 'gittensor-master-repositories' THEN 'srf-150f1f0ade50ced8'
    WHEN 'gittensory-contribution-interface' THEN 'srf-cc923091819b9bf0'
    WHEN 'onfinality-finney-rpc' THEN 'srf-dece284ea80ec36c'
    WHEN 'onfinality-finney-wss' THEN 'srf-09438235257fa944'
    WHEN 'opentensor-archive-rpc' THEN 'srf-d6ad3703dbed701f'
    WHEN 'opentensor-archive-wss' THEN 'srf-62a01e9d17dc2ac8'
    WHEN 'opentensor-finney-rpc' THEN 'srf-3ffcb1a074d13547'
    WHEN 'opentensor-finney-wss' THEN 'srf-f216252c5e5b341f'
    WHEN 'opentensor-lite-rpc' THEN 'srf-2d3306d2cfa2223e'
    WHEN 'opentensor-lite-wss' THEN 'srf-dcf48d017826dc4b'
    WHEN 'sn-107-github-readme-minos-protocol-minos-subnet-subnet-api-1' THEN 'srf-3462824e2b9e0eed'
    WHEN 'sn-109-academia-archives' THEN 'srf-0070df9e44e7d65b'
    WHEN 'sn-110-green-compute-models' THEN 'srf-8fa47d05ebfe89b1'
    WHEN 'sn-110-website-link-www-green-compute-com-data-artifact-10' THEN 'srf-4956e665c57320f3'
    WHEN 'sn-110-website-link-www-green-compute-com-data-artifact-9' THEN 'srf-ae90870b3452e032'
    WHEN 'sn-114-soma-mcp' THEN 'srf-71dfb5eb3db2406d'
    WHEN 'sn-118-website-link-heyditto-ai-data-artifact-3' THEN 'srf-eeeec504a19120d3'
    WHEN 'sn-23-trishool-api-root' THEN 'srf-b98c53721003635a'
    WHEN 'sn-24-quasar-base-model' THEN 'srf-2e8a77e8b3404e86'
    WHEN 'sn-24-quasar-launch-teacher' THEN 'srf-840a2605f8fb23c0'
    WHEN 'sn-24-website-link-silxinc-com-data-artifact-3' THEN 'srf-319b61d8ff50a870'
    WHEN 'sn-29-coldint-fineweb-dataset' THEN 'srf-f51c73d17f954447'
    WHEN 'sn-33-readyai-hf-dataset' THEN 'srf-1e2a3e1a34a5a2b9'
    WHEN 'sn-33-readyai-llms-data-repo' THEN 'srf-369814c5b1cde9c3'
    WHEN 'sn-47-evolai-universal-qa-dataset' THEN 'srf-aa5d5d31a0f78307'
    WHEN 'sn-51-website-common-api' THEN 'srf-c27814da8fc343a3'
    WHEN 'sn-56-gradients-last-boss-battle' THEN 'srf-c0245306b1d6177a'
    WHEN 'sn-56-gradients-latest-tournament-weights' THEN 'srf-2e2ae1882c93c037'
    WHEN 'sn-56-gradients-models' THEN 'srf-8d4249cf3cefb4cc'
    WHEN 'sn-56-gradients-weight-projection-static' THEN 'srf-5aa367d8193a4a6a'
    WHEN 'sn-58-github-readme-handshake58-hs58-subnet-api-2' THEN 'srf-71a5fb1f52db86ad'
    WHEN 'sn-58-handshake58-provider-directory-api' THEN 'srf-1c93ab1da6a59c50'
    WHEN 'sn-58-handshake58-skills-api' THEN 'srf-fdcb03337cc44e64'
    WHEN 'sn-59-github-readme-babelbit-babelbit-subnet-subnet-api-1' THEN 'srf-4a5f786ffee0dd5f'
    WHEN 'sn-6-numinous-api-health' THEN 'srf-4d92fe6304cbb843'
    WHEN 'sn-6-numinous-leaderboard' THEN 'srf-1e61c2a2b07ebb24'
    WHEN 'sn-64-chutes-pricing-api' THEN 'srf-a452646cd344d1a2'
    WHEN 'sn-64-website-link-chutes-ai-data-artifact-5' THEN 'srf-9e534fe113c5b86a'
    WHEN 'sn-64-website-link-chutes-ai-data-artifact-6' THEN 'srf-dea1477f513710c8'
    WHEN 'sn-68-website-link-www-metanova-labs-ai-data-artifact-4' THEN 'srf-1216a921c8908de5'
    WHEN 'sn-70-website-link-nexisgen-ai-data-artifact-5' THEN 'srf-009a5089d0e13e24'
    WHEN 'sn-72-natix-huggingface' THEN 'srf-f58da177e29ec502'
    WHEN 'sn-79-mvtrx-paper' THEN 'srf-0c31e228973cafd3'
    WHEN 'sn-88-investing-assets' THEN 'srf-3d79d0526c25e5cc'
    WHEN 'sn-95-actual-model-registry' THEN 'srf-5a99159ed1a9bd15'
    WHEN 'sn-96-verathos-models-api' THEN 'srf-4f803cf3db704548'
  END
WHERE surface_key IS NULL
  AND surface_id IN (
    'allways-api-health', 'allways-crown', 'allways-events-latest',
    'allways-miners', 'allways-miners-leaderboard',
    'allways-miners-reliability', 'allways-network-overview',
    'allways-protocol-chain-state', 'allways-protocol-constants',
    'allways-sse', 'community-sn-14-subnet-api-api-cacheon-ai',
    'community-sn-7-subnet-api-api-all-ways-io',
    'gittensor-master-repositories', 'gittensory-contribution-interface',
    'onfinality-finney-rpc', 'onfinality-finney-wss',
    'opentensor-archive-rpc', 'opentensor-archive-wss',
    'opentensor-finney-rpc', 'opentensor-finney-wss',
    'opentensor-lite-rpc', 'opentensor-lite-wss',
    'sn-107-github-readme-minos-protocol-minos-subnet-subnet-api-1',
    'sn-109-academia-archives', 'sn-110-green-compute-models',
    'sn-110-website-link-www-green-compute-com-data-artifact-10',
    'sn-110-website-link-www-green-compute-com-data-artifact-9',
    'sn-114-soma-mcp', 'sn-118-website-link-heyditto-ai-data-artifact-3',
    'sn-23-trishool-api-root', 'sn-24-quasar-base-model',
    'sn-24-quasar-launch-teacher',
    'sn-24-website-link-silxinc-com-data-artifact-3',
    'sn-29-coldint-fineweb-dataset', 'sn-33-readyai-hf-dataset',
    'sn-33-readyai-llms-data-repo', 'sn-47-evolai-universal-qa-dataset',
    'sn-51-website-common-api', 'sn-56-gradients-last-boss-battle',
    'sn-56-gradients-latest-tournament-weights', 'sn-56-gradients-models',
    'sn-56-gradients-weight-projection-static',
    'sn-58-github-readme-handshake58-hs58-subnet-api-2',
    'sn-58-handshake58-provider-directory-api',
    'sn-58-handshake58-skills-api',
    'sn-59-github-readme-babelbit-babelbit-subnet-subnet-api-1',
    'sn-6-numinous-api-health', 'sn-6-numinous-leaderboard',
    'sn-64-chutes-pricing-api',
    'sn-64-website-link-chutes-ai-data-artifact-5',
    'sn-64-website-link-chutes-ai-data-artifact-6',
    'sn-68-website-link-www-metanova-labs-ai-data-artifact-4',
    'sn-70-website-link-nexisgen-ai-data-artifact-5',
    'sn-72-natix-huggingface', 'sn-79-mvtrx-paper',
    'sn-88-investing-assets', 'sn-95-actual-model-registry',
    'sn-96-verathos-models-api'
  );

UPDATE surface_status
SET surface_key = (
  SELECT surface_key
  FROM surface_checks
  WHERE surface_checks.surface_id = surface_status.surface_id
    AND surface_checks.surface_key IS NOT NULL
  ORDER BY checked_at DESC
  LIMIT 1
)
WHERE surface_key IS NULL
  AND EXISTS (
    SELECT 1
    FROM surface_checks
    WHERE surface_checks.surface_id = surface_status.surface_id
      AND surface_checks.surface_key IS NOT NULL
  );

UPDATE surface_uptime_daily
SET surface_key = (
  SELECT surface_key
  FROM surface_checks
  WHERE surface_checks.surface_id = surface_uptime_daily.surface_id
    AND surface_checks.surface_key IS NOT NULL
  ORDER BY checked_at DESC
  LIMIT 1
)
WHERE surface_key IS NULL
  AND EXISTS (
    SELECT 1
    FROM surface_checks
    WHERE surface_checks.surface_id = surface_uptime_daily.surface_id
      AND surface_checks.surface_key IS NOT NULL
  );

DELETE FROM surface_status
WHERE surface_key IS NOT NULL
  AND rowid NOT IN (
    SELECT rowid
    FROM (
      SELECT
        rowid,
        ROW_NUMBER() OVER (
          PARTITION BY surface_key
          ORDER BY updated_at DESC, last_checked DESC, surface_id DESC
        ) AS rn
      FROM surface_status
      WHERE surface_key IS NOT NULL
    )
    WHERE rn = 1
  );

DROP TABLE IF EXISTS _surface_uptime_daily_rekey;

CREATE TABLE _surface_uptime_daily_rekey AS
SELECT
  MAX(surface_id) AS surface_id,
  surface_key,
  MAX(netuid) AS netuid,
  day,
  SUM(samples) AS samples,
  SUM(ok_count) AS ok_count,
  CASE
    WHEN SUM(samples) > 0 THEN ROUND(CAST(SUM(ok_count) AS REAL) / SUM(samples), 4)
    ELSE NULL
  END AS uptime_ratio,
  CASE
    WHEN SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN samples ELSE 0 END) > 0
      THEN CAST(ROUND(
        SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN avg_latency_ms * samples ELSE 0 END) /
        SUM(CASE WHEN avg_latency_ms IS NOT NULL THEN samples ELSE 0 END)
      ) AS INTEGER)
    ELSE NULL
  END AS avg_latency_ms,
  CASE
    WHEN SUM(ok_count) = SUM(samples) THEN 'ok'
    WHEN SUM(ok_count) = 0 THEN 'failed'
    ELSE 'degraded'
  END AS status,
  MAX(updated_at) AS updated_at
FROM surface_uptime_daily
WHERE surface_key IS NOT NULL
GROUP BY surface_key, day
HAVING COUNT(*) > 1;

DELETE FROM surface_uptime_daily
WHERE surface_key IS NOT NULL
  AND (surface_key, day) IN (
    SELECT surface_key, day FROM _surface_uptime_daily_rekey
  );

INSERT INTO surface_uptime_daily (
  surface_id, surface_key, netuid, day, samples, ok_count, uptime_ratio,
  avg_latency_ms, status, updated_at
)
SELECT
  surface_id, surface_key, netuid, day, samples, ok_count, uptime_ratio,
  avg_latency_ms, status, updated_at
FROM _surface_uptime_daily_rekey;

DROP TABLE _surface_uptime_daily_rekey;

CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_status_surface_key_unique
  ON surface_status (surface_key)
  WHERE surface_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_surface_uptime_daily_surface_key_day_unique
  ON surface_uptime_daily (surface_key, day)
  WHERE surface_key IS NOT NULL;

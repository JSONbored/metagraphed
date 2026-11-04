-- Native bootstrap only. The source actor has no persistent evaluator state:
-- each owner constructs fresh trigger/metric caches and delivery reservations.
CREATE SCHEMA IF NOT EXISTS realtime;
CREATE TABLE realtime.alerter_owner (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    owner_token uuid,
    lease_until_ms bigint NOT NULL DEFAULT 0 CHECK (lease_until_ms >= 0),
    CHECK (owner_token IS NOT NULL OR lease_until_ms = 0)
);

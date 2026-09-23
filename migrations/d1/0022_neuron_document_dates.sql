-- Date discovery and daily expansion must not read the archived payload pages.
CREATE INDEX neuron_daily_documents_day_idx
ON neuron_daily_documents(day,netuid,shard);

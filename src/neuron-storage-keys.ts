// Shared conflict identities for the neuron writer and archive exporter.
// Serving indexes may order these fields differently without changing identity.
export const NEURON_DAILY_KEYS = ["netuid", "uid", "snapshot_date"] as const;
export const ACCOUNT_POSITION_DAILY_KEYS = [
  "account",
  "netuid",
  "snapshot_date",
] as const;

// Shared wire columns for legacy Alpha and self-stake ingestion. Keep this
// leaf independent of account-position reconstruction and serving readers.
// Source and exact Alpha evidence are appended by their trusted writers.
export const NOMINATOR_POSITION_INSERT_COLUMNS = [
  "coldkey",
  "hotkey",
  "netuid",
  "share_fraction",
  "shares",
  "captured_at",
];

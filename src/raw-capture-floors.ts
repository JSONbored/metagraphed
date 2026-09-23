// Capture ownership boundaries are shared by ingestion and history readers.
// Keep them independent of cron wiring so a read cannot import capture lanes.
export const RAW_CAPTURE_GENESIS_FLOOR = 8_756_635;
export const TESTNET_RAW_CAPTURE_GENESIS_FLOOR = 7_700_000;

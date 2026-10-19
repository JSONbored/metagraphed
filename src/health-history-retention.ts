// Shared retention for surface-check history. Keep the policy import-free so
// retention plans do not import the operational-health cron and its probe graph.
export const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

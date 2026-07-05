// Network-wide axon-server leaderboard: across EVERY subnet over a 7d/30d window, the individual
// servers announcing axon endpoints network-wide — each server's total AxonServed event count
// (summed across every subnet it operates on), its share of the network total, and when it
// first/last announced in the window — ranked by activity. The network-wide drill-in behind
// /api/v1/chain/serving, which only reports the aggregate (distinct servers + total announcements +
// intensity per subnet) and never names the servers across the whole network — the same relationship
// /api/v1/chain/weights/setters has to /api/v1/chain/weights. Read live from the account_events
// AxonServed stream. Pure shaping (buildChainServingServers) + a thin D1 loader
// (loadChainServingServers); the Worker adds the envelope. Null-safe: a cold store yields a
// schema-stable empty leaderboard.

import { SERVING_EVENT_KIND } from "./chain-serving.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

// Supported windows (label -> days) + default, matching the sibling /chain/serving route.
export const CHAIN_SERVING_SERVERS_WINDOWS = { "7d": 7, "30d": 30 };
export const DEFAULT_CHAIN_SERVING_SERVERS_WINDOW = "7d";
export const CHAIN_SERVING_SERVERS_LIMIT_DEFAULT = 20;
export const CHAIN_SERVING_SERVERS_LIMIT_MAX = 100;

// AxonServed ingestion can omit hotkey, so a server is identified by its hotkey when present
// (a hotkey is a network-wide identity, so this correctly merges one server's activity across
// every subnet it announces on), else by its (netuid, uid) — a uid alone has no meaning outside
// its own subnet, so a uid-only server stays scoped to the subnet it was observed on, exactly
// mirroring the sibling chain-weight-setters.mjs identity. Rows whose identity is NULL (no hotkey
// AND no uid) are excluded from the leaderboard rather than collapsed into one bogus server.
const SERVER_IDENTITY =
  "CASE " +
  "WHEN hotkey IS NOT NULL AND hotkey != '' THEN 'hotkey:' || hotkey " +
  "WHEN uid IS NOT NULL THEN 'uid:' || netuid || ':' || uid " +
  "ELSE NULL END";

// Round a share to a stable 4dp precision WITHOUT letting a sub-1 share round up to an exact 1 —
// a server that drove < 100% of the network's serving must not read as a flat 1 while another
// server still holds activity (e.g. 49999/50000 = 0.99998 -> 1.0000). Mirrors the
// anti-overstatement guard in chain-weight-setters.mjs. A genuine sole server (its count == the
// network total) keeps a true 1.
function round(value, dp = 4) {
  const factor = 10 ** dp;
  const rounded = Math.round(value * factor) / factor;
  return rounded >= 1 && value < 1 ? (factor - 1) / factor : rounded;
}

// A non-negative whole count from a D1 COUNT() cell (number, numeric string, or null),
// defaulting to 0 for anything non-finite or negative.
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

// A representative uid cell -> non-negative integer, or null when absent/non-integer.
function toUid(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return null;
}

// A representative hotkey cell -> non-empty string, or null when absent/blank.
function toHotkey(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

// Newest/oldest epoch-ms observed_at -> ISO, or null when not finite/absent. Guards the JS Date
// range so a finite but out-of-range epoch cannot throw, mirroring the sibling routes.
function toIso(value) {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// Shape the network-wide leaderboard from the per-server aggregate rows plus the network-wide
// totals row. `rows` are already ordered by activity (newest-first tiebreak) from the loader;
// `totals` carries announcements (COUNT(*)), distinct_servers (COUNT(DISTINCT identity)) and
// newest_observed (MAX), all network-wide (no netuid filter). `limit` caps the returned page;
// `distinct_servers` always reports the true network-wide total regardless of `limit`. Each
// server's share is its count over the network total, null when the total is zero (no rows).
// Null-safe: null/absent inputs yield the schema-stable empty card.
export function buildChainServingServers(
  rows,
  totals,
  { window, limit = CHAIN_SERVING_SERVERS_LIMIT_DEFAULT } = {},
) {
  const list = Array.isArray(rows) ? rows : [];
  const flooredLimit = Math.floor(Number(limit));
  const normalizedLimit = Number.isFinite(flooredLimit)
    ? Math.max(0, Math.min(flooredLimit, CHAIN_SERVING_SERVERS_LIMIT_MAX))
    : CHAIN_SERVING_SERVERS_LIMIT_DEFAULT;
  const totalAnnouncements = toCount(totals?.announcements);
  const servers = list.slice(0, normalizedLimit).map((row) => {
    const announcements = toCount(row?.announcements);
    return {
      hotkey: toHotkey(row?.hotkey),
      uid: toUid(row?.uid),
      announcements,
      share:
        totalAnnouncements > 0
          ? round(announcements / totalAnnouncements)
          : null,
      first_served_at: toIso(row?.first_served),
      last_served_at: toIso(row?.last_served),
    };
  });
  return {
    schema_version: 1,
    window: window ?? null,
    observed_at: toIso(totals?.newest_observed),
    distinct_servers: toCount(totals?.distinct_servers),
    announcements: totalAnnouncements,
    server_count: servers.length,
    servers,
  };
}

// The network-wide axon-server leaderboard, computed live. Two bounded reads over the
// account_events AxonServed stream over the window (observed_at >= now - windowDays, epoch ms; no
// netuid filter): the per-server leaderboard (GROUP BY the hotkey-or-(netuid,uid) identity, top-N
// by count) and the network-wide totals (count + true distinct servers + newest observed_at,
// matching /chain/serving). Cold/absent store -> the schema-stable empty card.
export async function loadChainServingServers(
  d1,
  { windowLabel, windowDays, limit } = {},
) {
  const cutoff = Date.now() - windowDays * DAY_MS;
  const rows = await d1(
    "SELECT MAX(hotkey) AS hotkey, MAX(uid) AS uid, COUNT(*) AS announcements, " +
      "MIN(observed_at) AS first_served, MAX(observed_at) AS last_served " +
      "FROM account_events WHERE event_kind = ? AND observed_at >= ? " +
      "AND (" +
      SERVER_IDENTITY +
      ") IS NOT NULL GROUP BY " +
      SERVER_IDENTITY +
      " ORDER BY announcements DESC, last_served DESC LIMIT ?",
    [SERVING_EVENT_KIND, cutoff, CHAIN_SERVING_SERVERS_LIMIT_MAX],
  );
  const totals = await d1(
    "SELECT COUNT(*) AS announcements, COUNT(DISTINCT " +
      SERVER_IDENTITY +
      ") AS distinct_servers, MAX(observed_at) AS newest_observed " +
      "FROM account_events WHERE event_kind = ? AND observed_at >= ?",
    [SERVING_EVENT_KIND, cutoff],
  );
  return buildChainServingServers(rows, totals?.[0] ?? null, {
    window: windowLabel,
    limit,
  });
}

-- Five small cron-produced registry snapshots share the existing state database.
CREATE TABLE generated_artifacts (
  key TEXT PRIMARY KEY NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND json_type(payload)='object'),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) WITHOUT ROWID;

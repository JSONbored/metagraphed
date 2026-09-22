-- Native registry provenance and component health (#12176).
CREATE TABLE providers(
 id TEXT NOT NULL,
 overlay TEXT NOT NULL,
 source_commit TEXT NOT NULL,
 updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
 PRIMARY KEY (id)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE subnets(
 netuid INTEGER NOT NULL,
 slug TEXT NOT NULL,
 name TEXT NOT NULL,
 source TEXT NOT NULL DEFAULT 'community',
 overlay TEXT NOT NULL,
 source_commit TEXT NOT NULL,
 updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
 PRIMARY KEY (netuid),
 UNIQUE (slug)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_subnets_source ON subnets (source);
-- statement-breakpoint
CREATE TABLE surfaces(
 id TEXT NOT NULL,
 subnet_netuid INTEGER NOT NULL,
 provider_id TEXT,
 surface_key TEXT NOT NULL,
 kind TEXT NOT NULL,
 url TEXT NOT NULL,
 authority TEXT NOT NULL DEFAULT 'community',
 review_state TEXT NOT NULL DEFAULT 'community-submitted',
 probe_eligible INTEGER NOT NULL DEFAULT 0 CHECK(probe_eligible IN (0,1)),
 public_safe INTEGER NOT NULL DEFAULT 1 CHECK(public_safe IN (0,1)),
 overlay TEXT NOT NULL,
 source_commit TEXT NOT NULL,
 updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER)),
 PRIMARY KEY (id),
 UNIQUE (subnet_netuid, kind, url)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX idx_surfaces_probe ON surfaces (probe_eligible, review_state) WHERE probe_eligible;
-- statement-breakpoint
CREATE INDEX idx_surfaces_provider ON surfaces (provider_id);
-- statement-breakpoint
CREATE TABLE surface_history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 surface_id TEXT,
 subnet_netuid INTEGER NOT NULL,
 action TEXT NOT NULL,
 overlay TEXT NOT NULL,
 source_commit TEXT NOT NULL,
 recorded_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec')*1000 AS INTEGER))
);
-- statement-breakpoint
CREATE INDEX idx_surface_history_subnet ON surface_history (subnet_netuid, recorded_at DESC);
-- statement-breakpoint
CREATE INDEX idx_surface_history_surface ON surface_history (surface_id, recorded_at DESC);
-- statement-breakpoint
CREATE TABLE self_health_checks(
 component TEXT NOT NULL,
 checked_at_ms INTEGER NOT NULL,
 ok INTEGER NOT NULL CHECK(ok IN (0,1)),
 http_status INTEGER,
 latency_ms INTEGER,
 PRIMARY KEY (component, checked_at_ms)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE TABLE self_health_daily(
 day TEXT NOT NULL,
 component TEXT NOT NULL,
 checks INTEGER NOT NULL,
 ok_count INTEGER NOT NULL,
 PRIMARY KEY (day, component)
) WITHOUT ROWID;

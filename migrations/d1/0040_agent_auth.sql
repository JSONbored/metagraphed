-- Private authentication state. Deliberately excluded from public snapshots.
CREATE TABLE agent_auth_registrations (
  id TEXT NOT NULL PRIMARY KEY,
  agent_name TEXT NOT NULL CHECK (length(agent_name) BETWEEN 1 AND 80),
  email_hint TEXT NOT NULL CHECK (length(email_hint) BETWEEN 3 AND 320 AND email_hint = lower(trim(email_hint))),
  permissions TEXT NOT NULL CHECK (permissions = '["profile"]'),
  claim_token_hash TEXT NOT NULL UNIQUE CHECK (length(claim_token_hash) = 64 AND claim_token_hash NOT GLOB '*[^0-9a-f]*'),
  user_code_hash TEXT NOT NULL CHECK (length(user_code_hash) = 64 AND user_code_hash NOT GLOB '*[^0-9a-f]*'),
  claim_version INTEGER NOT NULL DEFAULT 1 CHECK (claim_version > 0),
  created_at INTEGER NOT NULL CHECK (typeof(created_at) = 'integer' AND created_at > 0),
  expires_at INTEGER NOT NULL CHECK (typeof(expires_at) = 'integer' AND expires_at > created_at),
  approved_at INTEGER CHECK (approved_at IS NULL OR (typeof(approved_at) = 'integer' AND approved_at >= created_at AND approved_at < expires_at)),
  owner_kind TEXT CHECK (owner_kind IS NULL OR owner_kind = 'github'),
  owner_id TEXT,
  owner_email TEXT,
  revoked_at INTEGER,
  poll_count INTEGER NOT NULL DEFAULT 0 CHECK (poll_count >= 0),
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  CHECK ((approved_at IS NULL AND owner_kind IS NULL AND owner_id IS NULL AND owner_email IS NULL)
    OR (approved_at IS NOT NULL AND owner_kind IS NOT NULL AND owner_kind = 'github' AND owner_id IS NOT NULL AND owner_email IS NOT NULL AND owner_email = email_hint))
) WITHOUT ROWID;
-- statement-breakpoint

CREATE TABLE agent_auth_ceremonies (
  state_hash TEXT NOT NULL PRIMARY KEY CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^0-9a-f]*'),
  registration_id TEXT NOT NULL REFERENCES agent_auth_registrations(id),
  claim_version INTEGER NOT NULL,
  cookie_hash TEXT NOT NULL CHECK (length(cookie_hash) = 64 AND cookie_hash NOT GLOB '*[^0-9a-f]*'),
  csrf_hash TEXT NOT NULL CHECK (length(csrf_hash) = 64 AND csrf_hash NOT GLOB '*[^0-9a-f]*'),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  oauth_consumed_at INTEGER,
  owner_kind TEXT CHECK (owner_kind IS NULL OR owner_kind = 'github'),
  owner_id TEXT,
  owner_email TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  consumed_by TEXT,
  CHECK ((owner_kind IS NULL AND owner_id IS NULL AND owner_email IS NULL)
    OR (owner_kind IS NOT NULL AND owner_kind = 'github' AND owner_id IS NOT NULL AND owner_email IS NOT NULL AND oauth_consumed_at IS NOT NULL))
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX agent_auth_ceremonies_registration ON agent_auth_ceremonies(registration_id);
-- statement-breakpoint

CREATE TABLE agent_auth_tokens (
  token_hash TEXT NOT NULL PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  registration_id TEXT NOT NULL REFERENCES agent_auth_registrations(id),
  claim_version INTEGER NOT NULL,
  resource TEXT NOT NULL DEFAULT 'https://api.metagraph.sh/mcp'
    CHECK (resource IN ('https://api.metagraph.sh/mcp', 'https://api.metagraph.sh/mcp/core')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
) WITHOUT ROWID;
-- statement-breakpoint
CREATE INDEX agent_auth_tokens_registration ON agent_auth_tokens(registration_id);
-- statement-breakpoint
CREATE INDEX agent_auth_tokens_expiry ON agent_auth_tokens(expires_at);
-- statement-breakpoint
CREATE INDEX agent_auth_ceremonies_expiry ON agent_auth_ceremonies(expires_at);
-- statement-breakpoint
CREATE INDEX agent_auth_registrations_expiry ON agent_auth_registrations(expires_at);

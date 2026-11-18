-- SkillHub initial schema (SPEC section 7)

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tid TEXT NOT NULL,
  oid TEXT NOT NULL,
  email TEXT,
  name TEXT,
  org_role TEXT NOT NULL DEFAULT 'member' CHECK (org_role IN ('owner','member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  UNIQUE (tid, oid)
);
CREATE INDEX users_email ON users (lower(email));

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  description TEXT,
  parent_team_id TEXT REFERENCES teams(id),
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE team_members (
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','maintainer')),
  added_by TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX team_members_user ON team_members (user_id);

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES nodes(id),
  kind TEXT NOT NULL CHECK (kind IN ('folder','doc')),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  inherit INTEGER NOT NULL DEFAULT 1,
  head_version INTEGER NOT NULL DEFAULT 0,
  published_version INTEGER,
  is_skill INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by TEXT
);
CREATE UNIQUE INDEX nodes_sibling_name ON nodes (COALESCE(parent_id, ''), lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX nodes_path ON nodes (path);
CREATE INDEX nodes_parent ON nodes (parent_id);
CREATE INDEX nodes_name ON nodes (lower(name));

CREATE TABLE grants (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user','team')),
  principal_id TEXT NOT NULL,
  role INTEGER NOT NULL CHECK (role BETWEEN 1 AND 4),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (node_id, principal_type, principal_id)
);
CREATE INDEX grants_principal ON grants (principal_type, principal_id);

CREATE TABLE doc_versions (
  doc_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  message TEXT,
  author_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, n)
);

CREATE TABLE drafts (
  doc_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  etag TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  doc_id TEXT REFERENCES nodes(id),
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX assets_doc ON assets (doc_id);

CREATE VIRTUAL TABLE skill_fts USING fts5(
  doc_id UNINDEXED, name, description, body, tokenize = 'porter unicode61'
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX api_tokens_user ON api_tokens (user_id);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  actor_id TEXT,
  via TEXT NOT NULL CHECK (via IN ('ui','rest','mcp','system')),
  client TEXT,
  op TEXT NOT NULL,
  node_id TEXT,
  version INTEGER,
  ok INTEGER NOT NULL,
  detail TEXT
);
CREATE INDEX audit_ts ON audit_log (ts);
CREATE INDEX audit_node ON audit_log (node_id, ts);
CREATE INDEX audit_actor ON audit_log (actor_id, ts);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Pending Entra logins (state, nonce, PKCE verifier). Short lived; swept by cron.
CREATE TABLE login_attempts (
  state_hash TEXT PRIMARY KEY,
  binding_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  verifier TEXT NOT NULL,
  return_to TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Built-in virtual team. Membership is implicit for every active user.
INSERT INTO teams (id, name, description, created_by, created_at)
VALUES ('everyone', 'everyone', 'Every active user', 'system', 0);

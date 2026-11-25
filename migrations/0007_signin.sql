-- Several sign-in methods (Microsoft, Google, an OIDC identity server, email links, passkeys) and invitations.
-- Users stay keyed on (tid, oid): tid is the identity namespace (the Entra tenant id as before, 'google', 'oidc:<issuer>',
-- 'email') and oid the subject in it. See docs/DECISIONS.md (entry 49).

ALTER TABLE login_attempts ADD COLUMN provider TEXT NOT NULL DEFAULT 'microsoft';
ALTER TABLE login_attempts ADD COLUMN invite_hash TEXT;

-- Signed in through an invitation from outside the organization: never an owner.
ALTER TABLE users ADD COLUMN is_external INTEGER NOT NULL DEFAULT 0;

-- An invitation: an email address and the access it brings (folder grants, teams), used once.
CREATE TABLE invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  access TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_at INTEGER,
  accepted_by TEXT,
  revoked_at INTEGER
);
CREATE INDEX invitations_email ON invitations (email);

-- One-time email sign-in links (only the hash is kept).
CREATE TABLE email_links (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  return_to TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX email_links_email ON email_links (email, created_at);

-- WebAuthn credentials (passkeys). id is the credential id, base64url.
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX passkeys_user ON passkeys (user_id);

-- Pending WebAuthn challenges, bound to a browser cookie.
CREATE TABLE webauthn_challenges (
  id_hash TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  user_id TEXT,
  expires_at INTEGER NOT NULL
);

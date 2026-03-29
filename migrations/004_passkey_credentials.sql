-- Passkey (WebAuthn) credentials table
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id TEXT PRIMARY KEY,                      -- Base64URL credential ID
  public_key BYTEA NOT NULL,                -- COSE public key
  counter BIGINT NOT NULL DEFAULT 0,        -- Replay protection counter
  device_type TEXT NOT NULL,                -- 'singleDevice' or 'multiDevice'
  backed_up BOOLEAN NOT NULL DEFAULT FALSE,
  transports TEXT[],                        -- Transport hints
  name TEXT,                                -- User-provided name
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

-- WebAuthn challenges (temporary, with expiry)
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('registration', 'authentication')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL           -- 5 minute expiry
);

-- Index for cleaning up expired challenges
CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expires ON webauthn_challenges(expires_at);

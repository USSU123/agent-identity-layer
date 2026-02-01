-- Agents table: core identity
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT,
  public_key TEXT NOT NULL,
  did TEXT UNIQUE NOT NULL,
  metadata JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Verifications table: attestations about agents
CREATE TABLE IF NOT EXISTS verifications (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  verifier_id TEXT,
  claim_type TEXT NOT NULL,
  claim_value TEXT,
  verified_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  signature TEXT
);

-- Reputation events: actions that affect reputation
CREATE TABLE IF NOT EXISTS reputation_events (
  id SERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  event_type TEXT NOT NULL,
  score_delta INTEGER DEFAULT 0,
  description TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- API keys for authentication
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT UNIQUE NOT NULL,
  owner_id TEXT,
  name TEXT,
  permissions JSONB DEFAULT '["read"]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

-- Rate limiting table
CREATE TABLE IF NOT EXISTS rate_limits (
  id SERIAL PRIMARY KEY,
  identifier TEXT NOT NULL,
  action_type TEXT NOT NULL,
  count INTEGER DEFAULT 1,
  window_start TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(identifier, action_type)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agents_did ON agents(did);
CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id);
CREATE INDEX IF NOT EXISTS idx_verifications_agent ON verifications(agent_id);
CREATE INDEX IF NOT EXISTS idx_reputation_agent ON reputation_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_rate_limits_lookup ON rate_limits(identifier, action_type);

-- Enable RLS
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE reputation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- Public read access for agents and verifications
CREATE POLICY "Public read access" ON agents FOR SELECT USING (true);
CREATE POLICY "Public read access" ON verifications FOR SELECT USING (true);
CREATE POLICY "Public read access" ON reputation_events FOR SELECT USING (true);

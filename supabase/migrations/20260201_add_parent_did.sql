-- Add parent_did for hierarchical identities (org -> workers)
ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_did TEXT REFERENCES agents(did);

-- Index for looking up workers by parent
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents(parent_did);

-- Add agent_type to distinguish main vs worker
ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_type TEXT DEFAULT 'main';

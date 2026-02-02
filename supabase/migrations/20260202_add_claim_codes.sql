-- Add claim_code for linking agents to human accounts
ALTER TABLE agents ADD COLUMN IF NOT EXISTS claim_code TEXT UNIQUE;

-- Add user_id to link agents to Supabase Auth users
ALTER TABLE agents ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id);

-- Index for claim code lookups
CREATE INDEX IF NOT EXISTS idx_agents_claim_code ON agents(claim_code);

-- Index for user lookups
CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);

-- Function to generate random claim code
CREATE OR REPLACE FUNCTION generate_claim_code()
RETURNS TEXT AS $$
DECLARE
  chars TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result TEXT := '';
  i INTEGER;
BEGIN
  FOR i IN 1..6 LOOP
    result := result || substr(chars, floor(random() * length(chars) + 1)::integer, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Update RLS policies for user-specific access
DROP POLICY IF EXISTS "Public read access" ON agents;

-- Public can read basic agent info (for verification)
CREATE POLICY "Public read basic" ON agents 
  FOR SELECT 
  USING (true);

-- Users can only update/delete their own agents
CREATE POLICY "Users manage own agents" ON agents 
  FOR ALL 
  USING (auth.uid() = user_id);

-- Service role can do anything (for API)
CREATE POLICY "Service role full access" ON agents 
  FOR ALL 
  USING (auth.role() = 'service_role');

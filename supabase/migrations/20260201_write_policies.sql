-- Add write policies (idempotent)
DO $$ 
BEGIN
  -- INSERT policies
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow agent registration' AND tablename = 'agents') THEN
    CREATE POLICY "Allow agent registration" ON agents FOR INSERT WITH CHECK (true);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow reputation events' AND tablename = 'reputation_events') THEN
    CREATE POLICY "Allow reputation events" ON reputation_events FOR INSERT WITH CHECK (true);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow verifications' AND tablename = 'verifications') THEN
    CREATE POLICY "Allow verifications" ON verifications FOR INSERT WITH CHECK (true);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow rate limits insert' AND tablename = 'rate_limits') THEN
    CREATE POLICY "Allow rate limits insert" ON rate_limits FOR INSERT WITH CHECK (true);
  END IF;
  
  -- UPDATE policies
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow agent updates' AND tablename = 'agents') THEN
    CREATE POLICY "Allow agent updates" ON agents FOR UPDATE USING (true) WITH CHECK (true);
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'Allow rate limit updates' AND tablename = 'rate_limits') THEN
    CREATE POLICY "Allow rate limit updates" ON rate_limits FOR UPDATE USING (true) WITH CHECK (true);
  END IF;
END $$;

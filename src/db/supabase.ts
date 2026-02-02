import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Load credentials
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://vlccvdskepntaskqniwm.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_SERVICE_KEY) {
  console.warn('SUPABASE_SERVICE_KEY not set - database operations will fail');
}

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Types matching our schema
export interface Agent {
  id: string;
  name: string;
  owner_id: string | null;
  public_key: string;
  did: string;
  metadata: Record<string, any>;
  status: string;
  created_at: string;
  updated_at: string;
  // New fields for auth
  claim_code: string | null;
  user_id: string | null;
  parent_did: string | null;
  agent_type: string;
}

// Generate a random 6-character claim code
export function generateClaimCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

export interface Verification {
  id: string;
  agent_id: string;
  verifier_id: string | null;
  claim_type: string;
  claim_value: string | null;
  verified_at: string;
  expires_at: string | null;
  signature: string | null;
}

export interface ReputationEvent {
  id: number;
  agent_id: string;
  event_type: string;
  score_delta: number;
  description: string | null;
  metadata: Record<string, any>;
  created_at: string;
}

export interface RateLimit {
  id: number;
  identifier: string;
  action_type: string;
  count: number;
  window_start: string;
}

// Database operations
export const db = {
  // Agents
  async createAgent(agent: Omit<Agent, 'created_at' | 'updated_at'>): Promise<Agent | null> {
    const { data, error } = await supabase
      .from('agents')
      .insert(agent)
      .select()
      .single();
    
    if (error) {
      console.error('Error creating agent:', error);
      return null;
    }
    return data;
  },

  async getAgentByDid(did: string): Promise<Agent | null> {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .eq('did', did)
      .single();
    
    if (error) return null;
    return data;
  },

  async getAgentById(id: string): Promise<Agent | null> {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .eq('id', id)
      .single();
    
    if (error) return null;
    return data;
  },

  async getAllAgents(): Promise<Agent[]> {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .order('created_at', { ascending: false });
    
    if (error) return [];
    return data || [];
  },

  async updateAgent(id: string, updates: Partial<Agent>): Promise<Agent | null> {
    const { data, error } = await supabase
      .from('agents')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    
    if (error) return null;
    return data;
  },

  // Verifications
  async createVerification(verification: Omit<Verification, 'verified_at'>): Promise<Verification | null> {
    const { data, error } = await supabase
      .from('verifications')
      .insert(verification)
      .select()
      .single();
    
    if (error) return null;
    return data;
  },

  async getVerificationsByAgent(agentId: string): Promise<Verification[]> {
    const { data, error } = await supabase
      .from('verifications')
      .select('*')
      .eq('agent_id', agentId);
    
    if (error) return [];
    return data || [];
  },

  // Reputation Events
  async createReputationEvent(event: Omit<ReputationEvent, 'id' | 'created_at'>): Promise<ReputationEvent | null> {
    const { data, error } = await supabase
      .from('reputation_events')
      .insert(event)
      .select()
      .single();
    
    if (error) {
      console.error('Error creating reputation event:', error);
      return null;
    }
    return data;
  },

  async getReputationEvents(agentId: string, limit = 100): Promise<ReputationEvent[]> {
    const { data, error } = await supabase
      .from('reputation_events')
      .select('*')
      .eq('agent_id', agentId)
      .order('created_at', { ascending: false })
      .limit(limit);
    
    if (error) return [];
    return data || [];
  },

  async getReputationScore(agentId: string): Promise<{ total: number; count: number }> {
    const { data, error } = await supabase
      .from('reputation_events')
      .select('score_delta')
      .eq('agent_id', agentId);
    
    if (error || !data) return { total: 0, count: 0 };
    
    const total = data.reduce((sum, e) => sum + (e.score_delta || 0), 0);
    return { total, count: data.length };
  },

  // Rate Limiting - with atomic increment to prevent race conditions
  // Uses optimistic locking: increment first, then check if over limit
  async checkRateLimit(identifier: string, actionType: string, maxCount: number, windowMs: number): Promise<boolean> {
    const windowStart = new Date(Date.now() - windowMs).toISOString();
    const now = new Date().toISOString();
    const key = `${identifier}:${actionType}`;
    
    // Clean up expired records for this key first
    await supabase
      .from('rate_limits')
      .delete()
      .eq('identifier', identifier)
      .eq('action_type', actionType)
      .lt('window_start', windowStart);
    
    // Try to insert new record (will fail if exists due to unique constraint)
    const { error: insertError } = await supabase
      .from('rate_limits')
      .insert({
        identifier,
        action_type: actionType,
        count: 1,
        window_start: now
      });
    
    // If insert succeeded, this is the first request in the window
    if (!insertError) {
      return true;
    }
    
    // Record exists - get current count and check
    const { data: current } = await supabase
      .from('rate_limits')
      .select('id, count')
      .eq('identifier', identifier)
      .eq('action_type', actionType)
      .gte('window_start', windowStart)
      .single();
    
    if (!current) {
      // Record was cleaned up, allow this request
      return true;
    }
    
    if (current.count >= maxCount) {
      return false; // Already at limit
    }
    
    // Increment - there's still a small race window here but it's much smaller
    // For true atomicity, we'd need a Supabase RPC function
    await supabase
      .from('rate_limits')
      .update({ count: current.count + 1 })
      .eq('id', current.id)
      .eq('count', current.count); // Optimistic lock: only update if count hasn't changed
    
    return true;
  },

  // Cleanup old rate limits
  async cleanupRateLimits(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from('rate_limits')
      .delete()
      .lt('window_start', cutoff);
  },

  // Claim an agent with a claim code (links to user)
  async claimAgent(claimCode: string, userId: string): Promise<Agent | null> {
    // Find the agent with this claim code
    const { data: agent, error: findError } = await supabase
      .from('agents')
      .select('*')
      .eq('claim_code', claimCode)
      .is('user_id', null) // Only unclaimed agents
      .single();

    if (findError || !agent) {
      console.error('Agent not found or already claimed:', findError);
      return null;
    }

    // Claim the agent
    const { data: claimed, error: claimError } = await supabase
      .from('agents')
      .update({ user_id: userId })
      .eq('id', agent.id)
      .select()
      .single();

    if (claimError) {
      console.error('Error claiming agent:', claimError);
      return null;
    }

    // Also claim all child agents (sub-agents)
    await supabase
      .from('agents')
      .update({ user_id: userId })
      .eq('parent_did', agent.did);

    return claimed;
  },

  // Get all agents for a user (including sub-agents)
  async getAgentsByUser(userId: string): Promise<Agent[]> {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) return [];
    return data || [];
  },

  // Get agent by claim code
  async getAgentByClaimCode(claimCode: string): Promise<Agent | null> {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .eq('claim_code', claimCode)
      .single();

    if (error) return null;
    return data;
  },

  // Get child agents (sub-agents) of a parent
  async getChildAgents(parentDid: string): Promise<Agent[]> {
    const { data, error } = await supabase
      .from('agents')
      .select('*')
      .eq('parent_did', parentDid)
      .order('created_at', { ascending: false });

    if (error) return [];
    return data || [];
  }
};

export function initializeDatabase(): void {
  console.log('Supabase database connected:', SUPABASE_URL);
}

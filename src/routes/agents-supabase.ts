import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db, Agent, supabase, generateClaimCode } from '../db/supabase';
import { generateKeyPair, generateDID, createDIDDocument, verify } from '../utils/crypto';

const router = Router();

// In-memory rate limit store for verify endpoint (1000 req/min per IP)
const verifyRateLimits = new Map<string, { count: number; resetAt: number }>();
const MAX_RATE_LIMIT_ENTRIES = 50000; // Cap to prevent memory exhaustion

function checkVerifyRateLimit(ip: string): boolean {
  const now = Date.now();
  const limit = verifyRateLimits.get(ip);
  
  if (!limit || now > limit.resetAt) {
    // Check map size before adding new entry
    if (verifyRateLimits.size >= MAX_RATE_LIMIT_ENTRIES) {
      // Emergency cleanup: remove all expired entries
      for (const [key, val] of verifyRateLimits.entries()) {
        if (now > val.resetAt) {
          verifyRateLimits.delete(key);
        }
      }
      // If still too large, remove oldest entries
      if (verifyRateLimits.size >= MAX_RATE_LIMIT_ENTRIES) {
        const entriesToRemove = verifyRateLimits.size - MAX_RATE_LIMIT_ENTRIES + 10000;
        let removed = 0;
        for (const key of verifyRateLimits.keys()) {
          if (removed >= entriesToRemove) break;
          verifyRateLimits.delete(key);
          removed++;
        }
      }
    }
    verifyRateLimits.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  
  if (limit.count >= 1000) {
    return false;
  }
  
  limit.count++;
  return true;
}

// Clean up old rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, limit] of verifyRateLimits.entries()) {
    if (now > limit.resetAt) {
      verifyRateLimits.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// Simple HTML sanitization - strips all tags
function sanitizeName(input: string): string {
  return input
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/[<>]/g, '')    // Remove any remaining angle brackets
    .trim()
    .substring(0, 255);      // Enforce max length
}

/**
 * POST /agents/register
 * Register a new agent identity
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { name: rawName, owner_id, metadata = {}, public_key, parent_did: topLevelParentDid } = req.body;
    // Accept parent_did at top level OR in metadata
    const parentDid = topLevelParentDid || metadata?.parent_did || null;
    const agentType = parentDid ? 'worker' : (metadata?.agent_type || 'main');

    if (!rawName) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // Validate and sanitize name
    if (typeof rawName !== 'string') {
      return res.status(400).json({ error: 'Name must be a string' });
    }
    
    const name = sanitizeName(rawName);
    
    if (name.length < 1) {
      return res.status(400).json({ error: 'Name cannot be empty after sanitization' });
    }

    // Rate limit check
    const clientIP = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const canRegister = await db.checkRateLimit(String(clientIP), 'registration', 10, 24 * 60 * 60 * 1000);
    
    if (!canRegister) {
      return res.status(429).json({ 
        error: 'Registration rate limit exceeded',
        message: 'Maximum 10 agent registrations per IP per 24 hours'
      });
    }

    // If registering as worker, verify parent exists
    if (parentDid) {
      const parent = await db.getAgentByDid(parentDid);
      if (!parent) {
        return res.status(400).json({ error: 'Parent agent not found', parent_did: parentDid });
      }
    }

    const id = uuidv4();
    let keyPair = null;
    let publicKey = public_key;

    if (!publicKey) {
      keyPair = generateKeyPair();
      publicKey = keyPair.publicKey;
    }

    // Generate DID - workers get parent prefix
    let did: string;
    if (parentDid) {
      const workerId = generateDID(publicKey).split(':')[2].substring(0, 8);
      did = `${parentDid}:w:${workerId}`;
    } else {
      did = generateDID(publicKey);
    }

    // Generate claim code only for main agents (not sub-agents)
    const claimCode = parentDid ? null : generateClaimCode();

    // If this is a sub-agent, inherit user_id from parent
    let userId = null;
    if (parentDid) {
      const parent = await db.getAgentByDid(parentDid);
      if (parent?.user_id) {
        userId = parent.user_id;
      }
    }

    const fullMetadata = {
      ...metadata,
      agent_type: agentType,
      parent_did: parentDid,
      registration_ip: clientIP,
      registration_timestamp: new Date().toISOString()
    };

    // Create agent with new fields
    const { data: agent, error: insertError } = await supabase
      .from('agents')
      .insert({
        id,
        name,
        owner_id: owner_id || null,
        public_key: publicKey,
        did,
        metadata: fullMetadata,
        status: 'active',
        claim_code: claimCode,
        user_id: userId,
        parent_did: parentDid,
        agent_type: agentType
      })
      .select()
      .single();

    if (insertError || !agent) {
      console.error('Insert error:', insertError);
      return res.status(500).json({ error: 'Failed to register agent' });
    }

    if (!agent) {
      return res.status(500).json({ error: 'Failed to register agent' });
    }

    // Log initial reputation event
    await db.createReputationEvent({
      agent_id: id,
      event_type: 'registration',
      score_delta: 10,
      description: 'Initial registration',
      metadata: {}
    });

    const response: any = {
      id,
      did,
      name,
      owner_id,
      public_key: publicKey,
      agent_type: agentType,
      parent_did: parentDid,
      created_at: agent.created_at
    };

    if (keyPair) {
      response.private_key = keyPair.privateKey;
      response.warning = 'SAVE YOUR PRIVATE KEY - IT WILL NOT BE SHOWN AGAIN';
    }

    // Include claim code for main agents
    if (claimCode) {
      response.claim_code = claimCode;
      response.claim_instructions = 'Go to clawid.co, create an account, and enter this code to link this agent to your dashboard.';
    }

    res.status(201).json(response);
  } catch (error: any) {
    console.error('Registration error:', error);
    if (error.message?.includes('duplicate') || error.code === '23505') {
      return res.status(409).json({ error: 'Agent with this public key already exists' });
    }
    res.status(500).json({ error: 'Failed to register agent' });
  }
});

/**
 * POST /agents/claim
 * Claim an agent with a claim code (links to user account)
 * Requires Authorization header with Supabase JWT
 */
router.post('/claim', async (req: Request, res: Response) => {
  try {
    const { claim_code } = req.body;
    
    if (!claim_code) {
      return res.status(400).json({ error: 'claim_code is required' });
    }

    // Get user from Authorization header (Supabase JWT)
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Authorization required',
        message: 'Sign in at clawid.co and provide your access token'
      });
    }

    const token = authHeader.substring(7);
    
    // Verify the JWT with Supabase
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ 
        error: 'Invalid token',
        message: 'Please sign in again at clawid.co'
      });
    }

    // Find agent with this claim code
    const { data: agent, error: findError } = await supabase
      .from('agents')
      .select('*')
      .eq('claim_code', claim_code.toUpperCase())
      .single();

    if (findError || !agent) {
      return res.status(404).json({ 
        error: 'Invalid claim code',
        message: 'No agent found with this claim code. Check the code and try again.'
      });
    }

    if (agent.user_id) {
      return res.status(400).json({ 
        error: 'Already claimed',
        message: 'This agent has already been claimed by an account.'
      });
    }

    // Claim the agent (and all its sub-agents)
    const { error: claimError } = await supabase
      .from('agents')
      .update({ user_id: user.id })
      .eq('id', agent.id);

    if (claimError) {
      console.error('Claim error:', claimError);
      return res.status(500).json({ error: 'Failed to claim agent' });
    }

    // Also claim all child agents
    await supabase
      .from('agents')
      .update({ user_id: user.id })
      .eq('parent_did', agent.did);

    // Count claimed agents (main + children)
    const { count: childCount } = await supabase
      .from('agents')
      .select('*', { count: 'exact', head: true })
      .eq('parent_did', agent.did);

    res.json({
      success: true,
      message: 'Agent claimed successfully!',
      agent: {
        did: agent.did,
        name: agent.name
      },
      sub_agents_claimed: childCount || 0
    });
  } catch (error) {
    console.error('Claim error:', error);
    res.status(500).json({ error: 'Failed to claim agent' });
  }
});

/**
 * GET /agents/my
 * Get all agents owned by the authenticated user
 * Requires Authorization header with Supabase JWT
 */
router.get('/my', async (req: Request, res: Response) => {
  try {
    // Get user from Authorization header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ 
        error: 'Authorization required',
        message: 'Sign in at clawid.co to view your agents'
      });
    }

    const token = authHeader.substring(7);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Get all agents for this user
    const { data: agents, error } = await supabase
      .from('agents')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch agents' });
    }

    // Get reputation for each
    const agentsWithRep = await Promise.all((agents || []).map(async (agent) => {
      const { total } = await db.getReputationScore(agent.id);
      return {
        ...agent,
        reputation: Math.round((3.0 + total / 100) * 100) / 100
      };
    }));

    // Organize by main agents and their workers
    const mainAgents = agentsWithRep.filter(a => !a.parent_did);
    const result = mainAgents.map(main => ({
      ...main,
      workers: agentsWithRep.filter(a => a.parent_did === main.did)
    }));

    res.json({
      user_id: user.id,
      email: user.email,
      agents: result,
      total_agents: agentsWithRep.length
    });
  } catch (error) {
    console.error('My agents error:', error);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

/**
 * GET /verify/:did
 * Platform verification endpoint - verify if an agent is registered
 * Returns verification status, reputation, and basic profile
 */
router.get('/verify/:did', async (req: Request, res: Response) => {
  try {
    const { did } = req.params;
    
    // Rate limit check
    const clientIP = String(req.ip || req.headers['x-forwarded-for'] || 'unknown');
    if (!checkVerifyRateLimit(clientIP)) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        message: 'Maximum 1000 verification requests per minute per IP',
        retry_after_seconds: 60
      });
    }

    // Validate DID format
    if (!did || did.trim() === '') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'DID parameter is required',
        example: 'GET /verify/did:agent:abc123'
      });
    }

    // Check DID format - must start with "did:agent:"
    if (!did.startsWith('did:agent:')) {
      return res.status(400).json({
        error: 'Invalid DID format',
        message: 'DID must start with "did:agent:"',
        provided: did,
        expected_format: 'did:agent:<identifier>'
      });
    }

    // Look up agent by exact DID match
    const agent = await db.getAgentByDid(did);

    if (!agent) {
      return res.json({
        verified: false,
        did: did,
        message: 'Agent not registered',
        register_url: 'https://agent-identity.onrender.com/register'
      });
    }

    // Get reputation and task count
    const { total: totalScore, count: eventCount } = await db.getReputationScore(agent.id);
    const reputation = Math.round(Math.max(0, Math.min(5, 3.0 + (totalScore / 100))) * 100) / 100;
    
    // Count tasks completed from work_report events
    const events = await db.getReputationEvents(agent.id, 1000);
    const tasksCompleted = events
      .filter(e => e.event_type === 'work_report')
      .reduce((sum, e) => sum + (e.metadata?.tasks_completed || 0), 0);

    res.json({
      verified: true,
      did: agent.did,
      name: agent.name,
      reputation: reputation,
      tasks_completed: tasksCompleted,
      registered_at: agent.created_at,
      flags: agent.status === 'flagged' ? 1 : 0,
      verification_url: `https://agent-identity.onrender.com/agent/${encodeURIComponent(agent.did)}`
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ 
      error: 'Verification failed',
      message: 'An internal error occurred during verification'
    });
  }
});

/**
 * GET /agents/:id
 * Get agent profile by ID or DID
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const isDID = id.startsWith('did:');
    
    const agent = isDID 
      ? await db.getAgentByDid(id)
      : await db.getAgentById(id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const didDocument = createDIDDocument(agent.did, agent.public_key, agent.owner_id || undefined);
    const { total } = await db.getReputationScore(agent.id);
    const reputation = 3.0 + (total / 100);

    res.json({
      ...agent,
      reputation: Math.round(Math.max(0, Math.min(5, reputation)) * 100) / 100,
      did_document: didDocument
    });
  } catch (error) {
    console.error('Get agent error:', error);
    res.status(500).json({ error: 'Failed to fetch agent' });
  }
});

/**
 * POST /agents/:id/verify
 * Verify agent identity by checking a signature
 */
router.post('/:id/verify', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { message, signature } = req.body;

    if (!message || !signature) {
      return res.status(400).json({ error: 'Message and signature are required' });
    }

    const isDID = id.startsWith('did:');
    const agent = isDID 
      ? await db.getAgentByDid(id)
      : await db.getAgentById(id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const isValid = verify(message, signature, agent.public_key);

    if (isValid) {
      await db.createReputationEvent({
        agent_id: agent.id,
        event_type: 'verification_success',
        score_delta: 1,
        description: 'Successful identity verification',
        metadata: {}
      });
    }

    res.json({
      verified: isValid,
      agent_id: agent.id,
      did: agent.did,
      verified_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({ error: 'Failed to verify agent' });
  }
});

/**
 * GET /agents/:id/reputation
 * Get reputation score for an agent
 */
router.get('/:id/reputation', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const isDID = id.startsWith('did:');
    
    const agent = isDID 
      ? await db.getAgentByDid(id)
      : await db.getAgentById(id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const { total: totalScore, count: eventCount } = await db.getReputationScore(agent.id);
    const recentEvents = await db.getReputationEvents(agent.id, 10);
    const verifications = await db.getVerificationsByAgent(agent.id);

    const createdAt = new Date(agent.created_at);
    const ageInDays = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

    res.json({
      agent_id: agent.id,
      did: agent.did,
      reputation: {
        score: totalScore,
        event_count: eventCount,
        verification_count: verifications.length,
        age_days: ageInDays,
        status: agent.status
      },
      recent_events: recentEvents
    });
  } catch (error) {
    console.error('Reputation error:', error);
    res.status(500).json({ error: 'Failed to fetch reputation' });
  }
});

/**
 * POST /agents/:id/work-report
 * Submit work performance report (requires signature)
 */
router.post('/:id/work-report', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { 
      period,
      tasks_completed = 0,
      corrections = 0,
      positive_feedback = 0,
      errors = 0,
      timestamp,
      signature
    } = req.body;

    const isDID = id.startsWith('did:');
    const agent = isDID 
      ? await db.getAgentByDid(id)
      : await db.getAgentById(id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Signature verification
    if (!signature) {
      return res.status(401).json({ 
        error: 'Signature required',
        message: 'Work reports must be signed by the agent'
      });
    }

    const reportData = {
      did: agent.did,
      period: period || new Date().toISOString().split('T')[0],
      tasks_completed,
      corrections,
      positive_feedback,
      errors
    };
    const canonicalMessage = JSON.stringify(reportData);
    
    if (!verify(canonicalMessage, signature, agent.public_key)) {
      return res.status(401).json({ 
        error: 'Invalid signature',
        message: 'Signature does not match agent public key'
      });
    }

    // Validate inputs
    const validatedTasks = Math.max(0, Math.min(1000, Math.floor(tasks_completed)));
    const validatedCorrections = Math.max(0, Math.min(100, Math.floor(corrections)));
    const validatedPositive = Math.max(0, Math.min(100, Math.floor(positive_feedback)));
    const validatedErrors = Math.max(0, Math.min(100, Math.floor(errors)));

    // Rate limit (5 reports per 24h)
    const canReport = await db.checkRateLimit(agent.id, 'work_report', 5, 24 * 60 * 60 * 1000);
    if (!canReport) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        message: 'Maximum 5 work reports per 24 hours'
      });
    }

    // Calculate delta
    let delta = (validatedTasks * 0.01) - (validatedCorrections * 0.05) + (validatedPositive * 0.02) - (validatedErrors * 0.03);
    delta = Math.max(-0.5, Math.min(0.5, delta)); // Cap at ±0.5
    const roundedDelta = Math.round(delta * 1000) / 1000;

    const { total: currentScore } = await db.getReputationScore(agent.id);
    const oldReputation = 3.0 + (currentScore / 100);

    await db.createReputationEvent({
      agent_id: agent.id,
      event_type: 'work_report',
      score_delta: Math.round(roundedDelta * 100),
      description: `Work report: ${validatedTasks} tasks, ${validatedCorrections} corrections`,
      metadata: {
        period: period || new Date().toISOString().split('T')[0],
        tasks_completed: validatedTasks,
        corrections: validatedCorrections,
        positive_feedback: validatedPositive,
        errors: validatedErrors,
        signature_verified: true
      }
    });

    const newReputation = Math.max(0, Math.min(5, oldReputation + roundedDelta));

    res.json({
      success: true,
      agent_id: agent.id,
      did: agent.did,
      period,
      delta: roundedDelta,
      old_reputation: Math.round(oldReputation * 100) / 100,
      new_reputation: Math.round(newReputation * 100) / 100,
      recorded_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Work report error:', error);
    res.status(500).json({ error: 'Failed to record work report' });
  }
});

/**
 * GET /agents/:id/workers
 * List all workers under this agent
 */
router.get('/:id/workers', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const isDID = id.startsWith('did:');
    
    const agent = isDID 
      ? await db.getAgentByDid(id)
      : await db.getAgentById(id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Find all agents where metadata.parent_did matches this agent
    const { data: workers, error } = await supabase
      .from('agents')
      .select('*')
      .contains('metadata', { parent_did: agent.did });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch workers' });
    }

    // Get reputation for each worker
    const workersWithRep = await Promise.all((workers || []).map(async (worker: any) => {
      const { total } = await db.getReputationScore(worker.id);
      return {
        ...worker,
        reputation: Math.round((3.0 + total / 100) * 100) / 100
      };
    }));

    res.json({
      parent_did: agent.did,
      parent_name: agent.name,
      workers: workersWithRep,
      worker_count: workersWithRep.length
    });
  } catch (error) {
    console.error('List workers error:', error);
    res.status(500).json({ error: 'Failed to list workers' });
  }
});

/**
 * GET /agents/stats
 * Get aggregate statistics for dashboard
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    // Get all agents for counting
    const { data: agents, error } = await supabase
      .from('agents')
      .select('id, metadata, created_at');
    
    if (error) throw error;

    const total = agents?.length || 0;
    const mainAgents = agents?.filter(a => a.metadata?.agent_type !== 'worker').length || 0;
    const workers = total - mainAgents;

    // Get verification count
    const { count: verificationCount } = await supabase
      .from('verifications')
      .select('*', { count: 'exact', head: true });

    // Get recent registrations (last 24h)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentAgents = agents?.filter(a => a.created_at > oneDayAgo).length || 0;

    res.json({
      total_agents: total,
      main_agents: mainAgents,
      worker_agents: workers,
      total_verifications: verificationCount || 0,
      registrations_24h: recentAgents
    });
  } catch (error) {
    console.error('Stats error:', error);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * GET /agents
 * List all agents with pagination
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 100));
    const offset = Math.max(0, parseInt(req.query.offset as string) || 0);

    // Get total count
    const { count: totalCount } = await supabase
      .from('agents')
      .select('*', { count: 'exact', head: true });

    // Get paginated agents
    const { data: agents, error } = await supabase
      .from('agents')
      .select('*')
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;
    
    // Get reputation for each agent
    const agentsWithRep = await Promise.all((agents || []).map(async (agent) => {
      const { total } = await db.getReputationScore(agent.id);
      return {
        ...agent,
        reputation: Math.round((3.0 + total / 100) * 100) / 100
      };
    }));

    res.json({
      agents: agentsWithRep,
      pagination: {
        total: totalCount || 0,
        limit,
        offset
      }
    });
  } catch (error) {
    console.error('List agents error:', error);
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

export default router;

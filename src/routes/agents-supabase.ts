import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db, Agent, supabase } from '../db/supabase';
import { generateKeyPair, generateDID, createDIDDocument, verify, sign } from '../utils/crypto';

const router = Router();

/**
 * POST /agents/register
 * Register a new agent identity
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { name, owner_id, metadata = {}, public_key } = req.body;
    const parentDid = metadata?.parent_did || null;
    const agentType = parentDid ? 'worker' : (metadata?.agent_type || 'main');

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
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

    const fullMetadata = {
      ...metadata,
      agent_type: agentType,
      parent_did: parentDid,
      registration_ip: clientIP,
      registration_timestamp: new Date().toISOString()
    };

    const agent = await db.createAgent({
      id,
      name,
      owner_id: owner_id || null,
      public_key: publicKey,
      did,
      metadata: fullMetadata,
      status: 'active'
    });

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
 * GET /agents
 * List all agents
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const agents = await db.getAllAgents();
    
    // Get reputation for each agent
    const agentsWithRep = await Promise.all(agents.map(async (agent) => {
      const { total } = await db.getReputationScore(agent.id);
      return {
        ...agent,
        reputation: Math.round((3.0 + total / 100) * 100) / 100
      };
    }));

    res.json({
      agents: agentsWithRep,
      pagination: {
        total: agents.length,
        limit: 100,
        offset: 0
      }
    });
  } catch (error) {
    console.error('List agents error:', error);
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

export default router;

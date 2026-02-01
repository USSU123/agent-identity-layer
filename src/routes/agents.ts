import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db, Agent } from '../db/schema';
import { generateKeyPair, generateDID, createDIDDocument, verify, sign } from '../utils/crypto';

const router = Router();

/**
 * POST /agents/register
 * Register a new agent identity
 * 
 * SECURITY: Rate limited per IP to prevent sybil attacks
 */
router.post('/register', (req: Request, res: Response) => {
  try {
    const { name, owner_id, metadata = {}, public_key } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // ========== SECURITY: Registration Rate Limit ==========
    // Limit registrations per IP to prevent sybil attacks
    const clientIP = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    
    const regLimitStmt = db.prepare(`
      SELECT COUNT(*) as reg_count 
      FROM agents 
      WHERE metadata LIKE ? 
        AND created_at > datetime('now', '-24 hours')
    `);
    const { reg_count } = regLimitStmt.get(`%"registration_ip":"${clientIP}"%`) as { reg_count: number };
    
    if (reg_count >= 10) {
      return res.status(429).json({ 
        error: 'Registration rate limit exceeded',
        message: 'Maximum 10 agent registrations per IP per 24 hours'
      });
    }

    const id = uuidv4();
    let keyPair = null;
    let publicKey = public_key;

    // If no public key provided, generate one (and return private key ONCE)
    if (!publicKey) {
      keyPair = generateKeyPair();
      publicKey = keyPair.publicKey;
    }

    const did = generateDID(publicKey);

    const stmt = db.prepare(`
      INSERT INTO agents (id, name, owner_id, public_key, did, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // Store registration metadata including IP for rate limiting
    const fullMetadata = {
      ...metadata,
      registration_ip: clientIP,
      registration_timestamp: new Date().toISOString()
    };
    stmt.run(id, name, owner_id || null, publicKey, did, JSON.stringify(fullMetadata));

    // Log reputation event for registration
    const eventStmt = db.prepare(`
      INSERT INTO reputation_events (agent_id, event_type, score_delta, description)
      VALUES (?, 'registration', 10, 'Initial registration')
    `);
    eventStmt.run(id);

    const response: any = {
      id,
      did,
      name,
      owner_id,
      public_key: publicKey,
      created_at: new Date().toISOString()
    };

    // Only return private key on creation (one time!)
    if (keyPair) {
      response.private_key = keyPair.privateKey;
      response.warning = 'SAVE YOUR PRIVATE KEY - IT WILL NOT BE SHOWN AGAIN';
    }

    res.status(201).json(response);
  } catch (error: any) {
    console.error('Registration error:', error);
    if (error.message?.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Agent with this public key already exists' });
    }
    res.status(500).json({ error: 'Failed to register agent' });
  }
});

/**
 * GET /agents/:id
 * Get agent profile by ID or DID
 */
router.get('/:id', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    // Check if it's a DID or UUID
    const isDID = id.startsWith('did:');
    
    const stmt = db.prepare(
      isDID 
        ? 'SELECT * FROM agents WHERE did = ?' 
        : 'SELECT * FROM agents WHERE id = ?'
    );
    
    const agent = stmt.get(id) as Agent | undefined;

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Generate DID document
    const didDocument = createDIDDocument(agent.did, agent.public_key, agent.owner_id || undefined);

    // Get reputation score
    const repStmt = db.prepare(`
      SELECT COALESCE(SUM(score_delta), 0) as total_score
      FROM reputation_events WHERE agent_id = ?
    `);
    const { total_score } = repStmt.get(agent.id) as { total_score: number };
    const reputation = 3.0 + (total_score / 100);

    res.json({
      ...agent,
      metadata: JSON.parse(agent.metadata || '{}'),
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
router.post('/:id/verify', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { message, signature } = req.body;

    if (!message || !signature) {
      return res.status(400).json({ error: 'Message and signature are required' });
    }

    const isDID = id.startsWith('did:');
    const stmt = db.prepare(
      isDID 
        ? 'SELECT * FROM agents WHERE did = ?' 
        : 'SELECT * FROM agents WHERE id = ?'
    );
    
    const agent = stmt.get(id) as Agent | undefined;

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const isValid = verify(message, signature, agent.public_key);

    if (isValid) {
      // Log successful verification
      const eventStmt = db.prepare(`
        INSERT INTO reputation_events (agent_id, event_type, score_delta, description)
        VALUES (?, 'verification_success', 1, 'Successful identity verification')
      `);
      eventStmt.run(agent.id);
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
router.get('/:id/reputation', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    
    const isDID = id.startsWith('did:');
    const agentStmt = db.prepare(
      isDID 
        ? 'SELECT * FROM agents WHERE did = ?' 
        : 'SELECT * FROM agents WHERE id = ?'
    );
    
    const agent = agentStmt.get(id) as Agent | undefined;

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Calculate reputation score
    const scoreStmt = db.prepare(`
      SELECT 
        COALESCE(SUM(score_delta), 0) as total_score,
        COUNT(*) as event_count
      FROM reputation_events 
      WHERE agent_id = ?
    `);
    const scoreResult = scoreStmt.get(agent.id) as { total_score: number; event_count: number };

    // Get recent events
    const eventsStmt = db.prepare(`
      SELECT * FROM reputation_events 
      WHERE agent_id = ? 
      ORDER BY created_at DESC 
      LIMIT 10
    `);
    const recentEvents = eventsStmt.all(agent.id);

    // Get verification count
    const verifyStmt = db.prepare(`
      SELECT COUNT(*) as count FROM verifications WHERE agent_id = ?
    `);
    const verifyResult = verifyStmt.get(agent.id) as { count: number };

    // Calculate age in days
    const createdAt = new Date(agent.created_at);
    const ageInDays = Math.floor((Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24));

    res.json({
      agent_id: agent.id,
      did: agent.did,
      reputation: {
        score: scoreResult.total_score,
        event_count: scoreResult.event_count,
        verification_count: verifyResult.count,
        age_days: ageInDays,
        status: agent.status
      },
      recent_events: recentEvents.map((e: any) => ({
        ...e,
        metadata: JSON.parse(e.metadata || '{}')
      }))
    });
  } catch (error) {
    console.error('Reputation error:', error);
    res.status(500).json({ error: 'Failed to fetch reputation' });
  }
});

/**
 * POST /agents/:id/work-report
 * Submit work performance report
 * 
 * SECURITY: Requires signature to prove agent owns the identity
 */
router.post('/:id/work-report', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { 
      period,
      tasks_completed = 0,
      corrections = 0,
      positive_feedback = 0,
      errors = 0,
      timestamp,
      signature  // REQUIRED: Agent must sign the report
    } = req.body;

    const isDID = id.startsWith('did:');
    const agentStmt = db.prepare(
      isDID 
        ? 'SELECT * FROM agents WHERE did = ?' 
        : 'SELECT * FROM agents WHERE id = ?'
    );
    
    const agent = agentStmt.get(id) as Agent | undefined;

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // ========== SECURITY: Signature Verification ==========
    // Agent must sign the report to prove they own the identity
    if (!signature) {
      return res.status(401).json({ 
        error: 'Signature required',
        message: 'Work reports must be signed by the agent to prevent manipulation'
      });
    }

    // Create canonical message to verify
    const reportData = {
      did: agent.did,
      period: period || new Date().toISOString().split('T')[0],
      tasks_completed,
      corrections,
      positive_feedback,
      errors
    };
    const canonicalMessage = JSON.stringify(reportData);
    
    const signatureValid = verify(canonicalMessage, signature, agent.public_key);
    if (!signatureValid) {
      return res.status(401).json({ 
        error: 'Invalid signature',
        message: 'Signature does not match agent public key'
      });
    }

    // ========== SECURITY: Input Validation ==========
    // Prevent negative values (gaming the system)
    const validatedTasks = Math.max(0, Math.min(1000, Math.floor(tasks_completed)));
    const validatedCorrections = Math.max(0, Math.min(100, Math.floor(corrections)));
    const validatedPositive = Math.max(0, Math.min(100, Math.floor(positive_feedback)));
    const validatedErrors = Math.max(0, Math.min(100, Math.floor(errors)));

    // ========== SECURITY: Rate Limiting (per agent) ==========
    // Check how many reports this agent has submitted in last 24h
    const rateLimitStmt = db.prepare(`
      SELECT COUNT(*) as report_count 
      FROM reputation_events 
      WHERE agent_id = ? 
        AND event_type = 'work_report' 
        AND created_at > datetime('now', '-24 hours')
    `);
    const { report_count } = rateLimitStmt.get(agent.id) as { report_count: number };
    
    if (report_count >= 5) {
      return res.status(429).json({ 
        error: 'Rate limit exceeded',
        message: 'Maximum 5 work reports per 24 hours'
      });
    }

    // ========== SECURITY: Daily Delta Cap ==========
    // Limit how much reputation can change per day (prevents massive gaming)
    const MAX_DAILY_DELTA = 0.5;
    
    const dailyDeltaStmt = db.prepare(`
      SELECT COALESCE(SUM(score_delta), 0) as daily_delta
      FROM reputation_events 
      WHERE agent_id = ? 
        AND event_type = 'work_report' 
        AND created_at > datetime('now', '-24 hours')
    `);
    const { daily_delta } = dailyDeltaStmt.get(agent.id) as { daily_delta: number };

    // Calculate score delta based on work performance
    // +0.01 per task, -0.05 per correction, +0.02 per positive, -0.03 per error
    let delta = (validatedTasks * 0.01) - (validatedCorrections * 0.05) + (validatedPositive * 0.02) - (validatedErrors * 0.03);
    
    // Apply daily cap
    const currentDailyDelta = daily_delta / 100; // Scale back from storage
    const remainingAllowance = MAX_DAILY_DELTA - Math.abs(currentDailyDelta);
    if (Math.abs(delta) > remainingAllowance) {
      delta = delta > 0 ? remainingAllowance : -remainingAllowance;
    }
    
    // Round to 3 decimal places
    const roundedDelta = Math.round(delta * 1000) / 1000;

    // Get current reputation
    const repStmt = db.prepare(`
      SELECT COALESCE(SUM(score_delta), 0) as current_score
      FROM reputation_events WHERE agent_id = ?
    `);
    const { current_score } = repStmt.get(agent.id) as { current_score: number };
    
    // Base reputation is 3.0, scale events appropriately
    const oldReputation = 3.0 + (current_score / 100); // Scale down events
    
    // Log the work report event
    const eventStmt = db.prepare(`
      INSERT INTO reputation_events (agent_id, event_type, score_delta, description, metadata)
      VALUES (?, 'work_report', ?, ?, ?)
    `);
    
    const description = `Work report: ${validatedTasks} tasks, ${validatedCorrections} corrections, ${validatedPositive} positive, ${validatedErrors} errors`;
    const metadata = JSON.stringify({
      period: period || new Date().toISOString().split('T')[0],
      tasks_completed: validatedTasks,
      corrections: validatedCorrections,
      positive_feedback: validatedPositive,
      errors: validatedErrors,
      timestamp: timestamp || new Date().toISOString(),
      signature_verified: true,
      rate_limit_remaining: 5 - report_count - 1,
      daily_delta_remaining: Math.round((MAX_DAILY_DELTA - Math.abs(currentDailyDelta + roundedDelta)) * 1000) / 1000
    });
    
    eventStmt.run(agent.id, roundedDelta * 100, description, metadata); // Scale up for storage

    // Calculate new reputation
    const newReputation = Math.max(0, Math.min(5, oldReputation + roundedDelta));

    res.json({
      success: true,
      agent_id: agent.id,
      did: agent.did,
      period,
      delta: roundedDelta,
      old_reputation: Math.round(oldReputation * 100) / 100,
      new_reputation: Math.round(newReputation * 100) / 100,
      reputation: Math.round(newReputation * 100) / 100,
      recorded_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Work report error:', error);
    res.status(500).json({ error: 'Failed to record work report' });
  }
});

/**
 * POST /agents/:id/sign
 * Sign a message with agent's private key (for testing)
 */
router.post('/:id/sign', (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { message, privateKey } = req.body;

    if (!message || !privateKey) {
      return res.status(400).json({ error: 'Message and privateKey are required' });
    }

    const signature = sign(message, privateKey);

    res.json({
      did: id,
      message,
      signature,
      signed_at: new Date().toISOString()
    });
  } catch (error) {
    console.error('Sign error:', error);
    res.status(500).json({ error: 'Failed to sign message' });
  }
});

/**
 * GET /agents
 * List all agents
 */
router.get('/', (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
    const offset = parseInt(req.query.offset as string) || 0;

    const stmt = db.prepare(`
      SELECT a.*, 
        COALESCE((SELECT SUM(score_delta) FROM reputation_events WHERE agent_id = a.id), 0) as reputation_score
      FROM agents a
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `);
    
    const agents = stmt.all(limit, offset);
    
    const countStmt = db.prepare('SELECT COUNT(*) as total FROM agents');
    const { total } = countStmt.get() as { total: number };

    res.json({
      agents: agents.map((a: any) => ({
        ...a,
        metadata: JSON.parse(a.metadata || '{}')
      })),
      pagination: {
        total,
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

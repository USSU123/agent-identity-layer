import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db, Agent, Verification } from '../db/schema';
import { verify as verifySig } from '../utils/crypto';

const router = Router();

/**
 * POST /verify
 * Verify a claim about an agent
 * 
 * Body:
 * - agent_id: ID or DID of agent to verify
 * - claim_type: Type of claim (identity, capability, ownership, etc.)
 * - claim_value: Optional value for the claim
 * - message: Message that was signed (optional, for signature verification)
 * - signature: Signature to verify (optional)
 * - verifier_id: ID of the verifying party (optional)
 */
router.post('/', (req: Request, res: Response) => {
  try {
    const { 
      agent_id, 
      claim_type, 
      claim_value, 
      message, 
      signature,
      verifier_id,
      expires_in_days 
    } = req.body;

    if (!agent_id || !claim_type) {
      return res.status(400).json({ 
        error: 'agent_id and claim_type are required' 
      });
    }

    // Find the agent
    const isDID = agent_id.startsWith('did:');
    const agentStmt = db.prepare(
      isDID 
        ? 'SELECT * FROM agents WHERE did = ?' 
        : 'SELECT * FROM agents WHERE id = ?'
    );
    
    const agent = agentStmt.get(agent_id) as Agent | undefined;

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    // If signature provided, verify it
    let signatureValid = null;
    if (message && signature) {
      signatureValid = verifySig(message, signature, agent.public_key);
      
      if (!signatureValid) {
        return res.status(401).json({
          verified: false,
          error: 'Signature verification failed',
          agent_id: agent.id,
          did: agent.did
        });
      }
    }

    // Create verification record
    const verificationId = uuidv4();
    const expiresAt = expires_in_days 
      ? new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000).toISOString()
      : null;

    const stmt = db.prepare(`
      INSERT INTO verifications (id, agent_id, verifier_id, claim_type, claim_value, expires_at, signature)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      verificationId, 
      agent.id, 
      verifier_id || null, 
      claim_type, 
      claim_value || null,
      expiresAt,
      signature || null
    );

    // Add reputation event
    const eventStmt = db.prepare(`
      INSERT INTO reputation_events (agent_id, event_type, score_delta, description, metadata)
      VALUES (?, 'claim_verified', 5, ?, ?)
    `);
    eventStmt.run(
      agent.id, 
      `Claim verified: ${claim_type}`,
      JSON.stringify({ claim_type, claim_value, verifier_id })
    );

    res.status(201).json({
      verified: true,
      verification_id: verificationId,
      agent_id: agent.id,
      did: agent.did,
      claim_type,
      claim_value,
      signature_verified: signatureValid,
      verified_at: new Date().toISOString(),
      expires_at: expiresAt
    });

  } catch (error) {
    console.error('Verify claim error:', error);
    res.status(500).json({ error: 'Failed to verify claim' });
  }
});

/**
 * GET /verify/:agent_id/claims
 * Get all verified claims for an agent
 */
router.get('/:agent_id/claims', (req: Request, res: Response) => {
  try {
    const { agent_id } = req.params;

    const isDID = agent_id.startsWith('did:');
    const agentStmt = db.prepare(
      isDID 
        ? 'SELECT * FROM agents WHERE did = ?' 
        : 'SELECT * FROM agents WHERE id = ?'
    );
    
    const agent = agentStmt.get(agent_id) as Agent | undefined;

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const claimsStmt = db.prepare(`
      SELECT * FROM verifications 
      WHERE agent_id = ? 
      AND (expires_at IS NULL OR expires_at > datetime('now'))
      ORDER BY verified_at DESC
    `);
    
    const claims = claimsStmt.all(agent.id);

    res.json({
      agent_id: agent.id,
      did: agent.did,
      claims: claims,
      total: claims.length
    });

  } catch (error) {
    console.error('Get claims error:', error);
    res.status(500).json({ error: 'Failed to fetch claims' });
  }
});

export default router;

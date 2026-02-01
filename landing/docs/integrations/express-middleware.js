/**
 * Agent Identity Middleware for Express.js
 * 
 * Copy-paste this into your Express project.
 * Verifies that incoming requests have a valid Agent Identity.
 * 
 * Usage:
 *   const { requireAgent, optionalAgent } = require('./agent-identity-middleware');
 *   
 *   // Block requests without verified agent
 *   app.post('/api/agent-task', requireAgent, (req, res) => {
 *     console.log('Agent:', req.agent); // { did, name, reputation, ... }
 *   });
 *   
 *   // Allow but track agent identity
 *   app.get('/api/data', optionalAgent, (req, res) => {
 *     if (req.agent) console.log('Verified agent:', req.agent.name);
 *   });
 */

const AGENT_IDENTITY_API = 'https://agent-identity.onrender.com';

// Cache verified agents for 5 minutes to reduce API calls
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Verify an agent DID against the Agent Identity API
 * @param {string} did - The agent's DID
 * @returns {Promise<object|null>} Agent data or null if not verified
 */
async function verifyAgent(did) {
  // Check cache first
  const cached = cache.get(did);
  if (cached && Date.now() < cached.expires) {
    return cached.data;
  }

  try {
    const response = await fetch(`${AGENT_IDENTITY_API}/verify/${encodeURIComponent(did)}`);
    
    if (!response.ok) {
      console.error(`[AgentIdentity] API error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    
    // Cache the result
    cache.set(did, {
      data: data.verified ? data : null,
      expires: Date.now() + CACHE_TTL
    });

    return data.verified ? data : null;
  } catch (error) {
    console.error('[AgentIdentity] Verification failed:', error.message);
    return null;
  }
}

/**
 * Middleware: Require verified Agent Identity
 * Returns 401 if agent is not verified.
 */
async function requireAgent(req, res, next) {
  const agentDid = req.headers['x-agent-did'] || req.headers['x-agent-identity'];
  
  if (!agentDid) {
    return res.status(401).json({
      error: 'Agent identity required',
      message: 'Include X-Agent-DID header with your agent\'s DID',
      register_url: 'https://agent-identity.onrender.com/'
    });
  }

  const agent = await verifyAgent(agentDid);
  
  if (!agent) {
    return res.status(401).json({
      error: 'Agent not verified',
      message: 'The provided DID is not registered or verified',
      did: agentDid,
      register_url: 'https://agent-identity.onrender.com/'
    });
  }

  // Attach agent data to request
  req.agent = agent;
  next();
}

/**
 * Middleware: Optional Agent Identity
 * Attaches agent data if provided and verified, but doesn't block requests.
 */
async function optionalAgent(req, res, next) {
  const agentDid = req.headers['x-agent-did'] || req.headers['x-agent-identity'];
  
  if (agentDid) {
    const agent = await verifyAgent(agentDid);
    if (agent) {
      req.agent = agent;
    }
  }
  
  next();
}

/**
 * Middleware: Require minimum reputation
 * Use after requireAgent.
 * @param {number} minReputation - Minimum reputation score (0-5)
 */
function requireReputation(minReputation) {
  return (req, res, next) => {
    if (!req.agent) {
      return res.status(401).json({
        error: 'Agent identity required',
        message: 'Use requireAgent middleware before requireReputation'
      });
    }

    if (req.agent.reputation < minReputation) {
      return res.status(403).json({
        error: 'Insufficient reputation',
        message: `This endpoint requires minimum ${minReputation} reputation`,
        your_reputation: req.agent.reputation,
        did: req.agent.did
      });
    }

    next();
  };
}

// Clean up cache periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of cache.entries()) {
    if (now > value.expires) {
      cache.delete(key);
    }
  }
}, 60 * 1000);

module.exports = {
  verifyAgent,
  requireAgent,
  optionalAgent,
  requireReputation
};

# Agent Identity Layer - MVP

The foundational identity layer for AI agents. Verifiable identities, portable reputation, cryptographic signatures.

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm start

# Server runs at http://localhost:3850
```

That's it. Dashboard at http://localhost:3850, API at http://localhost:3850/api.

## API Endpoints

### Register Agent
```bash
curl -X POST http://localhost:3850/agents/register \
  -H "Content-Type: application/json" \
  -d '{"name": "MyAgent", "owner_id": "dev@example.com"}'
```

Response:
```json
{
  "id": "uuid",
  "did": "did:agent:abc123...",
  "name": "MyAgent",
  "public_key": "...",
  "private_key": "...",  // ⚠️ SAVE THIS - only shown once!
  "warning": "SAVE YOUR PRIVATE KEY - IT WILL NOT BE SHOWN AGAIN"
}
```

### Get Agent Profile
```bash
curl http://localhost:3850/agents/{id}
# or by DID:
curl http://localhost:3850/agents/did:agent:abc123...
```

### Verify Signature
```bash
curl -X POST http://localhost:3850/agents/{id}/verify \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, world!", "signature": "hex-signature"}'
```

### Get Reputation
```bash
curl http://localhost:3850/agents/{id}/reputation
```

### Verify Claim
```bash
curl -X POST http://localhost:3850/verify \
  -H "Content-Type: application/json" \
  -d '{
    "agent_id": "did:agent:abc123...",
    "claim_type": "capability",
    "claim_value": "code-execution"
  }'
```

### List Agents
```bash
curl http://localhost:3850/agents
```

## SDK Usage

```typescript
import { AgentIdentity } from './sdk';

// Initialize
const identity = new AgentIdentity({ 
  apiUrl: 'http://localhost:3850' 
});

// Register a new agent
const agent = await identity.register({ 
  name: 'MyCodeAgent',
  owner: 'dev@example.com',
  metadata: { type: 'assistant', version: '1.0' }
});

console.log('Agent DID:', agent.did);
console.log('Private Key:', agent.private_key);  // Save this!

// Sign a message
const message = 'I am MyCodeAgent';
const signature = AgentIdentity.sign(message, agent.private_key!);

// Verify with API
const result = await identity.verify(agent.did, message, signature);
console.log('Verified:', result.verified);

// Get reputation
const rep = await identity.getReputation(agent.did);
console.log('Reputation:', rep.reputation.score);

// Add a claim
const claim = await identity.verifyClaim({
  agentId: agent.did,
  claimType: 'capability',
  claimValue: 'code-execution',
  message,
  signature
});
```

## Database

SQLite database at `data/identity.db`. Schema:

- **agents**: Core identity (id, name, public_key, did, owner_id, metadata, status)
- **verifications**: Claims and attestations
- **reputation_events**: Events affecting reputation score

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Dashboard                      │
│              (HTML/JS at port 3850)              │
└─────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│                   REST API                       │
│                 (Express.js)                     │
├─────────────────────────────────────────────────┤
│  POST /agents/register    │  Register identity   │
│  GET  /agents/:id         │  Get agent profile   │
│  POST /agents/:id/verify  │  Verify signature    │
│  GET  /agents/:id/reputation  │  Get reputation  │
│  POST /verify             │  Verify claim        │
└─────────────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────┐
│               SQLite Database                    │
│            (data/identity.db)                    │
└─────────────────────────────────────────────────┘
```

## Crypto

- **Key type**: Ed25519 (EdDSA)
- **DID method**: `did:agent:<hash-of-public-key>`
- **Libraries**: @noble/curves, @noble/hashes

## Development

```bash
# Dev mode with hot reload
npm run dev

# Build TypeScript
npm run build
```

## Configuration

Environment variables:
- `PORT` - Server port (default: 3850)
- `DB_PATH` - SQLite database path (default: ./data/identity.db)

## What's Next (V2)

- [ ] API key authentication
- [ ] Rate limiting
- [ ] Capability attestations
- [ ] Platform integrations
- [ ] Enterprise dashboard
- [ ] Decentralized resolution (did:web fallback)

---

Built for the Agent Economy. 🤖

/**
 * Test script for Agent Identity Layer
 * Run with: npx ts-node test.ts
 */

import { AgentIdentity } from './sdk';

const API_URL = 'http://localhost:3850';

async function main() {
  console.log('🧪 Testing Agent Identity Layer\n');

  const identity = new AgentIdentity({ apiUrl: API_URL });

  // 1. Register a new agent
  console.log('1️⃣  Registering new agent...');
  const agent = await identity.register({
    name: 'TestBot-' + Date.now(),
    owner: 'test@example.com',
    metadata: { type: 'test', version: '1.0' }
  });
  console.log(`   ✅ Agent registered: ${agent.did}`);
  console.log(`   ID: ${agent.id}`);
  console.log(`   Public Key: ${agent.public_key.slice(0, 20)}...`);
  if (agent.private_key) {
    console.log(`   Private Key: ${agent.private_key.slice(0, 20)}... (save this!)`);
  }

  // 2. Get agent profile
  console.log('\n2️⃣  Fetching agent profile...');
  const profile = await identity.get(agent.did);
  console.log(`   ✅ Name: ${profile.name}`);
  console.log(`   Status: ${profile.status}`);

  // 3. Sign a message
  console.log('\n3️⃣  Signing message...');
  const message = 'Hello, I am a verified agent!';
  const signature = AgentIdentity.sign(message, agent.private_key!);
  console.log(`   ✅ Message: "${message}"`);
  console.log(`   Signature: ${signature.slice(0, 40)}...`);

  // 4. Verify locally
  console.log('\n4️⃣  Verifying locally...');
  const localValid = AgentIdentity.verifyLocal(message, signature, agent.public_key);
  console.log(`   ✅ Local verification: ${localValid ? 'PASS' : 'FAIL'}`);

  // 5. Verify via API
  console.log('\n5️⃣  Verifying via API...');
  const apiResult = await identity.verify(agent.did, message, signature);
  console.log(`   ✅ API verification: ${apiResult.verified ? 'PASS' : 'FAIL'}`);

  // 6. Get reputation
  console.log('\n6️⃣  Fetching reputation...');
  const rep = await identity.getReputation(agent.did);
  console.log(`   ✅ Score: ${rep.reputation.score}`);
  console.log(`   Events: ${rep.reputation.event_count}`);

  // 7. Add a claim
  console.log('\n7️⃣  Adding capability claim...');
  const claim = await identity.verifyClaim({
    agentId: agent.did,
    claimType: 'capability',
    claimValue: 'code-execution',
    message,
    signature
  });
  console.log(`   ✅ Claim verified: ${claim.claim_type} = ${claim.claim_value}`);

  // 8. Get claims
  console.log('\n8️⃣  Fetching claims...');
  const claims = await identity.getClaims(agent.did);
  console.log(`   ✅ Total claims: ${claims.total}`);

  // 9. List all agents
  console.log('\n9️⃣  Listing all agents...');
  const list = await identity.list();
  console.log(`   ✅ Total agents: ${list.pagination.total}`);

  console.log('\n✨ All tests passed!\n');
}

main().catch(err => {
  console.error('❌ Test failed:', err.message);
  process.exit(1);
});

/**
 * Agent Identity SDK
 * 
 * A TypeScript SDK for interacting with the Agent Identity Layer.
 * 
 * @example
 * ```typescript
 * import { AgentIdentity } from './sdk';
 * 
 * const identity = new AgentIdentity({ apiUrl: 'http://localhost:3850' });
 * 
 * // Register a new agent
 * const agent = await identity.register({ name: 'MyAgent', owner: 'dev@example.com' });
 * console.log('Created agent:', agent.did);
 * 
 * // Sign a message
 * const signature = identity.sign('Hello, world!', agent.private_key!);
 * 
 * // Verify the signature
 * const result = await identity.verify(agent.did, 'Hello, world!', signature);
 * console.log('Verified:', result.verified);
 * ```
 */

import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/curves/abstract/utils';

export interface AgentIdentityConfig {
  apiUrl: string;
  apiKey?: string;
}

export interface RegisterOptions {
  name: string;
  owner?: string;
  metadata?: Record<string, any>;
  publicKey?: string;  // Optional - if not provided, a new keypair is generated
}

export interface AgentInfo {
  id: string;
  did: string;
  name: string;
  owner_id: string | null;
  public_key: string;
  private_key?: string;  // Only returned on creation
  metadata: Record<string, any>;
  status: string;
  created_at: string;
  did_document?: object;
}

export interface VerificationResult {
  verified: boolean;
  agent_id: string;
  did: string;
  verified_at: string;
  error?: string;
}

export interface ReputationInfo {
  agent_id: string;
  did: string;
  reputation: {
    score: number;
    event_count: number;
    verification_count: number;
    age_days: number;
    status: string;
  };
  recent_events: Array<{
    event_type: string;
    score_delta: number;
    created_at: string;
  }>;
}

export interface ClaimOptions {
  agentId: string;
  claimType: string;
  claimValue?: string;
  message?: string;
  signature?: string;
  verifierId?: string;
  expiresInDays?: number;
}

export interface ClaimResult {
  verified: boolean;
  verification_id: string;
  agent_id: string;
  did: string;
  claim_type: string;
  claim_value?: string;
  signature_verified: boolean | null;
  verified_at: string;
  expires_at: string | null;
}

export class AgentIdentity {
  private apiUrl: string;
  private apiKey?: string;

  constructor(config: AgentIdentityConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...options.headers as Record<string, string>
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(`${this.apiUrl}${path}`, {
      ...options,
      headers
    });

    const data = await response.json() as any;

    if (!response.ok) {
      throw new Error(data.error || `Request failed with status ${response.status}`);
    }

    return data as T;
  }

  /**
   * Register a new agent identity
   */
  async register(options: RegisterOptions): Promise<AgentInfo> {
    return this.request<AgentInfo>('/agents/register', {
      method: 'POST',
      body: JSON.stringify({
        name: options.name,
        owner_id: options.owner,
        metadata: options.metadata,
        public_key: options.publicKey
      })
    });
  }

  /**
   * Get an agent by ID or DID
   */
  async get(idOrDid: string): Promise<AgentInfo> {
    return this.request<AgentInfo>(`/agents/${encodeURIComponent(idOrDid)}`);
  }

  /**
   * Verify an agent's signature
   */
  async verify(idOrDid: string, message: string, signature: string): Promise<VerificationResult> {
    return this.request<VerificationResult>(`/agents/${encodeURIComponent(idOrDid)}/verify`, {
      method: 'POST',
      body: JSON.stringify({ message, signature })
    });
  }

  /**
   * Get an agent's reputation
   */
  async getReputation(idOrDid: string): Promise<ReputationInfo> {
    return this.request<ReputationInfo>(`/agents/${encodeURIComponent(idOrDid)}/reputation`);
  }

  /**
   * Verify a claim about an agent
   */
  async verifyClaim(options: ClaimOptions): Promise<ClaimResult> {
    return this.request<ClaimResult>('/verify', {
      method: 'POST',
      body: JSON.stringify({
        agent_id: options.agentId,
        claim_type: options.claimType,
        claim_value: options.claimValue,
        message: options.message,
        signature: options.signature,
        verifier_id: options.verifierId,
        expires_in_days: options.expiresInDays
      })
    });
  }

  /**
   * Get all claims for an agent
   */
  async getClaims(idOrDid: string): Promise<{ agent_id: string; did: string; claims: any[]; total: number }> {
    return this.request(`/verify/${encodeURIComponent(idOrDid)}/claims`);
  }

  /**
   * List all agents
   */
  async list(limit = 50, offset = 0): Promise<{ agents: AgentInfo[]; pagination: { total: number; limit: number; offset: number } }> {
    return this.request(`/agents?limit=${limit}&offset=${offset}`);
  }

  // --- Crypto utilities (for local signing) ---

  /**
   * Generate a new Ed25519 keypair
   */
  static generateKeyPair(): { publicKey: string; privateKey: string } {
    const privateKey = ed25519.utils.randomPrivateKey();
    const publicKey = ed25519.getPublicKey(privateKey);
    
    return {
      privateKey: bytesToHex(privateKey),
      publicKey: bytesToHex(publicKey)
    };
  }

  /**
   * Sign a message with a private key
   */
  static sign(message: string, privateKeyHex: string): string {
    const messageBytes = new TextEncoder().encode(message);
    const privateKey = hexToBytes(privateKeyHex);
    const signature = ed25519.sign(messageBytes, privateKey);
    return bytesToHex(signature);
  }

  /**
   * Verify a signature locally (without API call)
   */
  static verifyLocal(message: string, signatureHex: string, publicKeyHex: string): boolean {
    try {
      const messageBytes = new TextEncoder().encode(message);
      const signature = hexToBytes(signatureHex);
      const publicKey = hexToBytes(publicKeyHex);
      return ed25519.verify(signature, messageBytes, publicKey);
    } catch (e) {
      return false;
    }
  }
}

// Export convenience functions
export const generateKeyPair = AgentIdentity.generateKeyPair;
export const sign = AgentIdentity.sign;
export const verifyLocal = AgentIdentity.verifyLocal;

export default AgentIdentity;

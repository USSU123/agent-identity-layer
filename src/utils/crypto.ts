import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/curves/abstract/utils';

export interface KeyPair {
  publicKey: string;  // hex
  privateKey: string; // hex
}

/**
 * Generate a new Ed25519 keypair
 */
export function generateKeyPair(): KeyPair {
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
export function sign(message: string, privateKeyHex: string): string {
  const messageBytes = new TextEncoder().encode(message);
  const privateKey = hexToBytes(privateKeyHex);
  const signature = ed25519.sign(messageBytes, privateKey);
  return bytesToHex(signature);
}

/**
 * Verify a signature
 */
export function verify(message: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signature = hexToBytes(signatureHex);
    const publicKey = hexToBytes(publicKeyHex);
    return ed25519.verify(signature, messageBytes, publicKey);
  } catch (e) {
    return false;
  }
}

/**
 * Hash data using SHA-256
 */
export function hash(data: string): string {
  const bytes = new TextEncoder().encode(data);
  return bytesToHex(sha256(bytes));
}

/**
 * Generate a DID from a public key
 * Format: did:agent:<base58-encoded-public-key>
 */
export function generateDID(publicKeyHex: string): string {
  // Simple approach: use first 16 bytes of hash of public key
  const keyHash = hash(publicKeyHex).slice(0, 32);
  return `did:agent:${keyHash}`;
}

/**
 * Create a DID Document
 */
export function createDIDDocument(did: string, publicKeyHex: string, controller?: string) {
  return {
    "@context": ["https://www.w3.org/ns/did/v1"],
    "id": did,
    "verificationMethod": [{
      "id": `${did}#key-1`,
      "type": "Ed25519VerificationKey2020",
      "controller": did,
      "publicKeyHex": publicKeyHex
    }],
    "authentication": [`${did}#key-1`],
    "controller": controller || did
  };
}

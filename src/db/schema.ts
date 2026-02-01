import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../data/identity.db');

// Ensure data directory exists
import fs from 'fs';
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const db: DatabaseType = new Database(DB_PATH);

// Enable WAL mode for better concurrent performance
db.pragma('journal_mode = WAL');

// Initialize schema
export function initializeDatabase() {
  db.exec(`
    -- Agents table: core identity
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT,
      public_key TEXT NOT NULL,
      did TEXT UNIQUE NOT NULL,
      metadata TEXT DEFAULT '{}',
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- Verifications table: attestations about agents
    CREATE TABLE IF NOT EXISTS verifications (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      verifier_id TEXT,
      claim_type TEXT NOT NULL,
      claim_value TEXT,
      verified_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT,
      signature TEXT,
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    -- Reputation events: actions that affect reputation
    CREATE TABLE IF NOT EXISTS reputation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      score_delta INTEGER DEFAULT 0,
      description TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (agent_id) REFERENCES agents(id)
    );

    -- API keys for authentication
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      key_hash TEXT UNIQUE NOT NULL,
      owner_id TEXT,
      name TEXT,
      permissions TEXT DEFAULT '["read"]',
      created_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT
    );

    -- Create indexes
    CREATE INDEX IF NOT EXISTS idx_agents_did ON agents(did);
    CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id);
    CREATE INDEX IF NOT EXISTS idx_verifications_agent ON verifications(agent_id);
    CREATE INDEX IF NOT EXISTS idx_reputation_agent ON reputation_events(agent_id);
  `);

  console.log('Database initialized at:', DB_PATH);
}

// Agent types
export interface Agent {
  id: string;
  name: string;
  owner_id: string | null;
  public_key: string;
  did: string;
  metadata: string;
  status: string;
  created_at: string;
  updated_at: string;
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
  metadata: string;
  created_at: string;
}

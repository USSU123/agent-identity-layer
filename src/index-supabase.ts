import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { initializeDatabase } from './db/supabase';
import agentsRouter from './routes/agents-supabase';

const app = express();
const PORT = process.env.PORT || 3850;

// Middleware
const corsOptions = {
  origin: [
    'https://agent-identity.onrender.com',
    'http://localhost:3850',
    'http://localhost:3000'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-Agent-DID', 'X-Agent-Identity'],
  credentials: false
};
app.use(cors(corsOptions));
app.use(express.json());

// Serve static files
app.use('/dashboard', express.static(path.join(__dirname, '../dashboard')));
app.use('/docs', express.static(path.join(__dirname, '../landing/docs')));
app.use(express.static(path.join(__dirname, '../landing')));

// Explicit badge.js route (ensure it's served correctly)
app.get('/badge.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, '../landing/badge.js'));
});

// API Routes
app.use('/agents', agentsRouter);

// Convenience route: /verify/:did (also available at /agents/verify/:did)
app.get('/verify/:did', (req, res) => {
  // Forward to the agents router
  req.url = `/verify/${req.params.did}`;
  agentsRouter(req, res, () => {});
});

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'agent-identity-layer',
    version: '0.2.0',
    database: 'supabase',
    timestamp: new Date().toISOString()
  });
});

// API docs
app.get('/api', (req, res) => {
  res.json({
    name: 'Agent Identity Layer API',
    version: '0.2.0',
    database: 'supabase',
    endpoints: {
      'POST /agents/register': 'Register a new agent identity',
      'GET /agents': 'List all agents',
      'GET /agents/:id': 'Get agent profile by ID or DID',
      'POST /agents/:id/verify': 'Verify agent signature',
      'GET /agents/:id/reputation': 'Get agent reputation score',
      'POST /agents/:id/work-report': 'Submit work performance (signed)'
    },
    documentation: 'https://github.com/yourusername/agent-identity'
  });
});

// Landing page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../landing/index.html'));
});

// Legal pages
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, '../landing/terms.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, '../landing/privacy.html'));
});

// Dashboard at /dashboard
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/index.html'));
});

// Initialize and start
initializeDatabase();

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🤖 Agent Identity Layer (Supabase)                          ║
║                                                               ║
║   API:        http://localhost:${PORT}/api                       ║
║   Dashboard:  http://localhost:${PORT}                           ║
║   Health:     http://localhost:${PORT}/health                    ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

export default app;

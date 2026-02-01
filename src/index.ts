import express from 'express';
import cors from 'cors';
import path from 'path';
import { initializeDatabase } from './db/schema';
import agentsRouter from './routes/agents';
import verifyRouter from './routes/verify';

const app = express();
const PORT = process.env.PORT || 3850;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static dashboard
app.use(express.static(path.join(__dirname, '../dashboard')));

// API Routes
app.use('/agents', agentsRouter);
app.use('/verify', verifyRouter);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'agent-identity-layer',
    version: '0.1.0',
    timestamp: new Date().toISOString()
  });
});

// API docs
app.get('/api', (req, res) => {
  res.json({
    name: 'Agent Identity Layer API',
    version: '0.1.0',
    endpoints: {
      'POST /agents/register': 'Register a new agent identity',
      'GET /agents': 'List all agents',
      'GET /agents/:id': 'Get agent profile by ID or DID',
      'POST /agents/:id/verify': 'Verify agent signature',
      'GET /agents/:id/reputation': 'Get agent reputation score',
      'POST /verify': 'Verify a claim about an agent',
      'GET /verify/:id/claims': 'Get verified claims for an agent'
    },
    documentation: 'See README.md for full documentation'
  });
});

// Dashboard route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../dashboard/index.html'));
});

// Initialize database and start server
initializeDatabase();

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🤖 Agent Identity Layer                                     ║
║                                                               ║
║   API:        http://localhost:${PORT}/api                       ║
║   Dashboard:  http://localhost:${PORT}                           ║
║   Health:     http://localhost:${PORT}/health                    ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

export default app;

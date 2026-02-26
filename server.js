const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const WebSocket = require('ws');
require('dotenv').config();

const app = express();
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'postgres',
  database: process.env.DB_NAME || 'documents_db',
  password: process.env.DB_PASSWORD || 'postgres',
  port: process.env.DB_PORT || 5432,
});

// REST APIs

// POST /api/documents
app.post('/api/documents', async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content are required' });
  }
  try {
    const result = await pool.query(
      'INSERT INTO documents (title, content, version) VALUES ($1, $2, 0) RETURNING *',
      [title, content]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/documents
app.get('/api/documents', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM documents ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET /api/documents/:id
app.get('/api/documents/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE /api/documents/:id
app.delete('/api/documents/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const result = await pool.query('DELETE FROM documents WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.json({ message: 'Document deleted successfully', document: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Operational Transformation Logic
function applyOperation(content, op) {
  if (op.type === 'insert') {
    return content.slice(0, op.position) + op.chars + content.slice(op.position);
  } else if (op.type === 'delete') {
    return content.slice(0, op.position) + content.slice(op.position + op.length);
  }
  return content;
}

function transform(op, concurrentOp) {
  if (op.type === 'insert' && concurrentOp.type === 'insert') {
    if (op.position > concurrentOp.position || (op.position === concurrentOp.position && op.userId > concurrentOp.userId)) {
      return { ...op, position: op.position + concurrentOp.chars.length };
    }
  } else if (op.type === 'insert' && concurrentOp.type === 'delete') {
    if (op.position > concurrentOp.position) {
      const overlap = Math.max(0, Math.min(op.position - concurrentOp.position, concurrentOp.length));
      return { ...op, position: op.position - overlap };
    }
  } else if (op.type === 'delete' && concurrentOp.type === 'insert') {
    if (op.position >= concurrentOp.position) {
      return { ...op, position: op.position + concurrentOp.chars.length };
    } else if (op.position + op.length > concurrentOp.position) {
      return { ...op, length: op.length + concurrentOp.chars.length };
    }
  } else if (op.type === 'delete' && concurrentOp.type === 'delete') {
    if (op.position >= concurrentOp.position) {
      if (op.position >= concurrentOp.position + concurrentOp.length) {
        return { ...op, position: op.position - concurrentOp.length };
      } else {
        const overlap = (concurrentOp.position + concurrentOp.length) - op.position;
        const newLen = op.length - overlap;
        return { ...op, position: concurrentOp.position, length: Math.max(0, newLen) };
      }
    }
  }
  return { ...op };
}

// WebSocket State
const docsState = new Map();

wss.on('connection', (ws) => {
  ws.on('message', async (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      return;
    }

    const { type, docId, userId, operation, version, cursor } = data;

    if (type === 'JOIN') {
      try {
        const result = await pool.query('SELECT content, version FROM documents WHERE id = $1', [docId]);
        if (result.rows.length === 0) {
          ws.send(JSON.stringify({ error: 'Document not found' }));
          return;
        }

        if (!docsState.has(docId)) {
          docsState.set(docId, {
            content: result.rows[0].content || '',
            version: result.rows[0].version || 0,
            history: [],
            clients: new Map()
          });
        }

        const state = docsState.get(docId);
        state.clients.set(ws, userId);

        ws.send(JSON.stringify({
          type: 'INIT',
          content: state.content,
          version: state.version,
          users: Array.from(state.clients.values())
        }));

        broadcast(docId, { type: 'USER_JOINED', userId }, ws);
      } catch (e) {
        console.error('Failed to load doc', e);
        return;
      }
    } else if (type === 'OPERATION') {
      const state = docsState.get(docId);
      if (!state) return;

      let op = { ...operation, userId: state.clients.get(ws) || userId };
      const clientVersion = version;

      if (clientVersion < state.version) {
        // Find where client diverged
        let idx = state.history.findIndex(h => h.version === clientVersion);
        if (idx === -1) idx = 0; // Fallback if history missing elements due to compaction, though we don't compact here

        const missedOps = state.history.slice(idx);
        for (const missed of missedOps) {
          op = transform(op, missed.op);
        }
      }

      state.content = applyOperation(state.content, op);
      const currentVersion = state.version;
      state.history.push({ version: currentVersion, op });
      state.version++;

      broadcast(docId, {
        type: 'OPERATION',
        userId: op.userId,
        operation: op,
        version: state.version
      });

      pool.query('UPDATE documents SET content = $1, version = $2 WHERE id = $3', [state.content, state.version, docId]).catch(console.error);
    } else if (type === 'CURSOR') {
      const state = docsState.get(docId);
      if (!state) return;
      broadcast(docId, { type: 'CURSOR', userId: state.clients.get(ws) || userId, cursor }, ws);
    } else if (type === 'LEAVE') {
      handleLeave(ws, docId);
    }
  });

  ws.on('close', () => {
    docsState.forEach((state, docId) => {
      if (state.clients.has(ws)) {
        handleLeave(ws, docId);
      }
    });
  });

  function handleLeave(clientWs, docId) {
    const state = docsState.get(docId);
    if (state && state.clients.has(clientWs)) {
      const userId = state.clients.get(clientWs);
      state.clients.delete(clientWs);
      broadcast(docId, { type: 'USER_LEFT', userId });
    }
  }

  function broadcast(docId, message, excludeWs = null) {
    const state = docsState.get(docId);
    if (!state) return;
    const msgStr = JSON.stringify(message);
    for (const [clientWs] of state.clients.entries()) {
      // NOTE: We do not exclude anyone for OPERATION, unless excludeWs is explicitly passed (e.g., JOIN, LEAVE)
      if (clientWs !== excludeWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(msgStr);
      }
    }
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

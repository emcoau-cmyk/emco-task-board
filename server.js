const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('.'));
app.use(express.json());

// In-memory storage (replace with DB in production)
let users = {};
let tasks = [];
let taskState = {};
let history = [];
let userSessions = new Map();

// User management
const generateToken = () => crypto.randomBytes(16).toString('hex');

app.post('/api/login', (req, res) => {
  const { username } = req.body;
  if (!username || username.trim().length === 0) {
    return res.status(400).json({ error: 'Username required' });
  }
  const userId = crypto.randomUUID();
  const token = generateToken();
  users[userId] = { 
    id: userId, 
    username: username.trim(),
    token,
    joinedAt: new Date(),
    color: `hsl(${Math.random() * 360}, 70%, 50%)`
  };
  res.json({ userId, token, user: users[userId] });
});

app.post('/api/auth', (req, res) => {
  const { userId, token } = req.body;
  const user = users[userId];
  if (user && user.token === token) {
    res.json({ authenticated: true, user });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// WebSocket for real-time sync
wss.on('connection', (ws) => {
  let userId = null;
  let username = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.type === 'auth') {
        userId = msg.userId;
        username = users[userId]?.username;
        userSessions.set(userId, ws);
        
        // Send initial state
        ws.send(JSON.stringify({
          type: 'sync',
          tasks,
          taskState,
          history,
          users: Object.values(users),
          activeUsers: Array.from(userSessions.keys()).map(id => users[id])
        }));
        
        // Notify others
        broadcast({
          type: 'user-joined',
          user: users[userId]
        });
      }
      
      if (msg.type === 'task-add') {
        const task = {
          ...msg.task,
          id: crypto.randomUUID(),
          createdBy: userId,
          createdAt: new Date(),
          comments: []
        };
        tasks.push(task);
        broadcast({ type: 'task-added', task });
      }
      
      if (msg.type === 'task-update') {
        const task = tasks.find(t => t.id === msg.id);
        if (task) {
          Object.assign(task, msg.updates);
          task.updatedAt = new Date();
          task.updatedBy = userId;
          broadcast({ type: 'task-updated', task });
        }
      }
      
      if (msg.type === 'task-move') {
        taskState[msg.id] = msg.status;
        broadcast({
          type: 'task-moved',
          id: msg.id,
          status: msg.status,
          movedBy: userId,
          timestamp: new Date()
        });
      }
      
      if (msg.type === 'task-delete') {
        tasks = tasks.filter(t => t.id !== msg.id);
        delete taskState[msg.id];
        broadcast({ type: 'task-deleted', id: msg.id });
      }
      
      if (msg.type === 'task-skip') {
        const task = tasks.find(t => t.id === msg.id);
        if (task) {
          task.skipped = msg.skipped;
          broadcast({ type: 'task-skipped', id: msg.id, skipped: msg.skipped });
        }
      }
      
      if (msg.type === 'comment-add') {
        const task = tasks.find(t => t.id === msg.taskId);
        if (task) {
          const comment = {
            id: crypto.randomUUID(),
            author: userId,
            authorName: username,
            text: msg.text,
            timestamp: new Date()
          };
          task.comments = task.comments || [];
          task.comments.push(comment);
          broadcast({ type: 'comment-added', taskId: msg.taskId, comment });
        }
      }
      
      if (msg.type === 'period-close') {
        const period = {
          ...msg.period,
          id: crypto.randomUUID(),
          closedBy: userId,
          closedAt: new Date()
        };
        history.unshift(period);
        taskState = {};
        tasks.forEach(t => t.skipped = false);
        broadcast({ type: 'period-closed', period, newState: taskState });
      }
      
    } catch (e) {
      console.error('WebSocket message error:', e);
    }
  });

  ws.on('close', () => {
    if (userId) {
      userSessions.delete(userId);
      broadcast({
        type: 'user-left',
        userId,
        username
      });
    }
  });
});

function broadcast(msg) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(msg));
    }
  });
}

// REST endpoints for initial data
app.get('/api/tasks', (req, res) => {
  res.json({ tasks, taskState, history });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`EMCO Task Board running on http://localhost:${PORT}`);
});

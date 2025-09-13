// Claudio v5.4.0 - Ultra-Low Latency Music Platform
// Signaling Server for WebRTC Connections
// Ready for one-click Render.com deployment

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// Configuration
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage (will be replaced with PostgreSQL in production)
const rooms = new Map();
const users = new Map();
const connections = new Map();

// Room management
class Room {
  constructor(id, name, maxUsers = 8) {
    this.id = id;
    this.name = name;
    this.maxUsers = maxUsers;
    this.users = new Map();
    this.createdAt = new Date();
    this.isActive = true;
  }

  addUser(user) {
    if (this.users.size >= this.maxUsers) {
      return false;
    }
    this.users.set(user.id, user);
    return true;
  }

  removeUser(userId) {
    return this.users.delete(userId);
  }

  getUsers() {
    return Array.from(this.users.values());
  }

  isEmpty() {
    return this.users.size === 0;
  }
}

// User management
class User {
  constructor(socketId, username, instrument = 'Unknown') {
    this.id = socketId;
    this.socketId = socketId;
    this.username = username;
    this.instrument = instrument;
    this.roomId = null;
    this.isConnected = true;
    this.audioEnabled = true;
    this.latency = 0;
    this.joinedAt = new Date();
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    activeRooms: rooms.size,
    connectedUsers: users.size,
    uptime: process.uptime()
  });
});

// API endpoints
app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.values()).map(room => ({
    id: room.id,
    name: room.name,
    userCount: room.users.size,
    maxUsers: room.maxUsers,
    isActive: room.isActive,
    createdAt: room.createdAt
  }));
  res.json(roomList);
});

app.post('/api/rooms', (req, res) => {
  const { name, maxUsers } = req.body;
  const roomId = generateRoomId();
  const room = new Room(roomId, name, maxUsers);
  rooms.set(roomId, room);
  
  res.json({
    success: true,
    room: {
      id: room.id,
      name: room.name,
      maxUsers: room.maxUsers
    }
  });
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);
  connections.set(socket.id, { connectedAt: new Date() });

  // User joins a room
  socket.on('join-room', (data) => {
    const { roomId, username, instrument } = data;
    
    // Validate room exists
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }

    // Create user
    const user = new User(socket.id, username, instrument);
    
    // Try to add user to room
    if (!room.addUser(user)) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }

    // Update user's room
    user.roomId = roomId;
    users.set(socket.id, user);
    
    // Join socket room
    socket.join(roomId);
    
    // Notify all users in room
    const roomUsers = room.getUsers();
    io.to(roomId).emit('user-joined', {
      user: {
        id: user.id,
        username: user.username,
        instrument: user.instrument
      },
      users: roomUsers.map(u => ({
        id: u.id,
        username: u.username,
        instrument: u.instrument,
        audioEnabled: u.audioEnabled
      }))
    });

    // Send welcome message to user
    socket.emit('joined-room', {
      roomId: roomId,
      userId: socket.id,
      users: roomUsers.map(u => ({
        id: u.id,
        username: u.username,
        instrument: u.instrument,
        audioEnabled: u.audioEnabled
      }))
    });

    console.log(`User ${username} (${instrument}) joined room ${roomId}`);
  });

  // WebRTC signaling
  socket.on('offer', (data) => {
    const { targetId, offer } = data;
    socket.to(targetId).emit('offer', {
      senderId: socket.id,
      offer: offer
    });
  });

  socket.on('answer', (data) => {
    const { targetId, answer } = data;
    socket.to(targetId).emit('answer', {
      senderId: socket.id,
      answer: answer
    });
  });

  socket.on('ice-candidate', (data) => {
    const { targetId, candidate } = data;
    socket.to(targetId).emit('ice-candidate', {
      senderId: socket.id,
      candidate: candidate
    });
  });

  // Audio control
  socket.on('toggle-audio', (data) => {
    const user = users.get(socket.id);
    if (user) {
      user.audioEnabled = data.enabled;
      const room = rooms.get(user.roomId);
      if (room) {
        socket.to(user.roomId).emit('user-audio-toggled', {
          userId: socket.id,
          audioEnabled: user.audioEnabled
        });
      }
    }
  });

  // Latency measurement
  socket.on('ping', (timestamp) => {
    socket.emit('pong', timestamp);
  });

  socket.on('latency-update', (data) => {
    const user = users.get(socket.id);
    if (user) {
      user.latency = data.latency;
    }
  });

  // Chat messaging
  socket.on('chat-message', (data) => {
    const user = users.get(socket.id);
    if (user && user.roomId) {
      io.to(user.roomId).emit('chat-message', {
        userId: socket.id,
        username: user.username,
        message: data.message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Connection quality monitoring
  socket.on('connection-quality', (data) => {
    const user = users.get(socket.id);
    if (user) {
      // Broadcast connection quality to room for adaptive streaming
      socket.to(user.roomId).emit('peer-quality-update', {
        userId: socket.id,
        quality: data
      });
    }
  });

  // Disconnect handling
  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);
    
    const user = users.get(socket.id);
    if (user && user.roomId) {
      const room = rooms.get(user.roomId);
      if (room) {
        room.removeUser(socket.id);
        
        // Notify other users
        socket.to(user.roomId).emit('user-left', {
          userId: socket.id,
          username: user.username
        });

        // Clean up empty rooms
        if (room.isEmpty()) {
          rooms.delete(user.roomId);
          console.log(`Room ${user.roomId} deleted (empty)`);
        }
      }
    }

    // Clean up user data
    users.delete(socket.id);
    connections.delete(socket.id);
  });

  // Error handling
  socket.on('error', (error) => {
    console.error(`Socket error for ${socket.id}:`, error);
  });
});

// Utility functions
function generateRoomId() {
  return Math.random().toString(36).substr(2, 8).toUpperCase();
}

// Cleanup old rooms periodically
setInterval(() => {
  const now = new Date();
  for (const [roomId, room] of rooms.entries()) {
    // Remove rooms older than 24 hours with no users
    if (room.isEmpty() && (now - room.createdAt) > 24 * 60 * 60 * 1000) {
      rooms.delete(roomId);
      console.log(`Cleaned up old room: ${roomId}`);
    }
  }
}, 60 * 60 * 1000); // Run every hour

// Error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
server.listen(PORT, () => {
  console.log(`🎵 Claudio Signaling Server v5.4.0 running on port ${PORT}`);
  console.log(`🌟 Environment: ${NODE_ENV}`);
  console.log(`🚀 Ready for ultra-low latency music connections!`);
});

module.exports = app;
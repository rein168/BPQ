const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config().parsed || {};

const port = process.env.PORT || 3000;

const db = require('./db');
const sessionService = require('./services/sessionService');
const sessionRoutes = require('./routes/sessions');
const courtRoutes = require('./routes/courts');
const playerRoutes = require('./routes/players');
const queueRoutes = require('./routes/queue');
const { registerSocketHandlers } = require('./sockets/handlers');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: [`http://localhost:${port}`, `http://127.0.0.1:${port}`] },
  pingInterval: 30000,
  pingTimeout: 60000,
  transports: ['websocket', 'polling'],
  maxHttpBufferSize: 1e6,
  connectTimeout: 60000,
});

const APP_VERSION = require('./package.json').version;

// Initialize Service
sessionService.init(io);

app.set('view engine', 'ejs');
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(cookieParser(process.env.COOKIE_SECRET || 'default_secret_change_me'));
app.use(express.static('public'));

// Inject app version for cache-busting
app.use((req, res, next) => {
  res.locals.APP_VERSION = APP_VERSION;
  next();
});

// Routes
app.use('/api/sessions', sessionRoutes);
app.use('/api/courts', courtRoutes);
app.use('/api/players', playerRoutes);
app.use('/api/queue', queueRoutes);

// Main dashboard page
app.get('/', (req, res) => {
  res.render('dashboard');
});

// Session queue page
app.get('/session/:sessionId', (req, res) => {
  res.render('session-queue');
});

// Socket.io handlers
registerSocketHandlers(io);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: APP_VERSION });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Process-level error handling
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
server.listen(port, () => {
  console.log(`\n🎾 BPQ (Badminton Players Queueing) running on port ${port}`);
  console.log(`📱 Open http://localhost:${port}\n`);
});

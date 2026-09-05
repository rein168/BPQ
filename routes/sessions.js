const express = require('express');
const router = express.Router();
const sessionService = require('../services/sessionService');
const { requireHost, hashPin, verifyPin, grantHostAccess } = require('../middleware/auth');

// Create a new session (with optional PIN)
router.post('/', (req, res) => {
  try {
    const { name, pin, courtCount, gameDate } = req.body;
    let trimmedName = (name && typeof name === 'string') ? name.trim() : '';
    // Default to formatted date if no name provided
    if (trimmedName.length === 0) {
      if (gameDate && /^\d{4}-\d{2}-\d{2}$/.test(gameDate)) {
        const d = new Date(gameDate + 'T00:00:00');
        trimmedName = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      } else {
        trimmedName = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      }
    }
    if (trimmedName.length > 100) {
      return res.status(400).json({ error: 'Session name must be under 100 characters' });
    }

    // Validate PIN if provided
    let pinHash = null;
    if (pin) {
      if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) {
        return res.status(400).json({ error: 'PIN must be 4-6 digits' });
      }
      pinHash = hashPin(pin);
    }

    // Court count: host sets this; minimum 1, maximum 20
    const courts = Math.max(1, Math.min(parseInt(courtCount, 10) || 4, 20));
    const validDate = gameDate && /^\d{4}-\d{2}-\d{2}$/.test(gameDate) ? gameDate : null;
    const sessionId = sessionService.createSession(trimmedName, pinHash, courts, validDate);

    // Grant host access to the creator
    grantHostAccess(res, req, sessionId);

    res.json({ success: true, sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Authenticate to a session (enter PIN to gain host access)
router.post('/:sessionId/auth', (req, res) => {
  try {
    const { pin } = req.body;
    const session = sessionService.getSession(req.params.sessionId);

    if (!session) return res.status(404).json({ error: 'Session not found' });

    // If session has no PIN, grant access to anyone
    if (!session.pin_hash) {
      grantHostAccess(res, req, session.id);
      return res.json({ success: true, role: 'host' });
    }

    if (!pin || typeof pin !== 'string') {
      return res.status(400).json({ error: 'PIN required' });
    }

    if (!verifyPin(pin, session.pin_hash)) {
      return res.status(403).json({ error: 'Incorrect PIN' });
    }

    grantHostAccess(res, req, session.id);
    res.json({ success: true, role: 'host' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check if current user is host of a session
router.get('/:sessionId/role', (req, res) => {
  try {
    const sessionId = Number(req.params.sessionId);
    const session = sessionService.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });

    let isHost = false;
    try {
      const hostSessions = req.signedCookies.hostSessions;
      if (hostSessions) {
        const authorized = JSON.parse(hostSessions);
        isHost = Array.isArray(authorized) && authorized.includes(sessionId);
      }
    } catch {
      // Invalid cookie, not a host
    }

    // Sessions without a PIN treat everyone as host (backward compat)
    if (!session.pin_hash) {
      isHost = true;
      // Also set the cookie so requireHost middleware passes on subsequent API calls
      grantHostAccess(res, req, sessionId);
    }

    res.json({
      role: isHost ? 'host' : 'viewer',
      hasPin: !!session.pin_hash,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all sessions
router.get('/', (req, res) => {
  try {
    const sessions = sessionService.getAllSessions();
    // Strip pin_hash, add player count and max capacity
    const sanitized = sessions.map(({ pin_hash, ...rest }) => {
      const playerCount = sessionService.getSessionPlayers(rest.id).length;
      const courts = sessionService.getSessionCourts(rest.id);
      const maxPlayers = courts.length * 8;
      return {
        ...rest,
        hasPin: !!pin_hash,
        playerCount,
        maxPlayers,
      };
    });
    res.json({ sessions: sanitized });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get specific session
router.get('/:sessionId', (req, res) => {
  try {
    const session = sessionService.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    // Strip pin_hash
    const { pin_hash, ...sanitized } = session;
    res.json({ session: { ...sanitized, hasPin: !!pin_hash } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// End session (host only)
router.post('/:sessionId/end', requireHost, (req, res) => {
  try {
    sessionService.endSession(req.params.sessionId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get match history for session (anyone can view)
router.get('/:sessionId/history', (req, res) => {
  try {
    const history = sessionService.getMatchHistory(req.params.sessionId);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get session stats (anyone can view)
router.get('/:sessionId/stats', (req, res) => {
  try {
    const stats = sessionService.getSessionStats(req.params.sessionId);
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

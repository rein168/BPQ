const express = require('express');
const router = express.Router();
const sessionService = require('../services/sessionService');

// Create a new session
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Session name required' });
    const trimmedName = name.trim();
    if (trimmedName.length === 0 || trimmedName.length > 100) {
      return res.status(400).json({ error: 'Session name must be 1-100 characters' });
    }

    const sessionId = await sessionService.createSession(trimmedName);
    res.json({ success: true, sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all sessions
router.get('/', async (req, res) => {
  try {
    const sessions = await sessionService.getAllSessions();
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get specific session
router.get('/:sessionId', async (req, res) => {
  try {
    const session = await sessionService.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// End session
router.post('/:sessionId/end', async (req, res) => {
  try {
    await sessionService.endSession(req.params.sessionId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get match history for session
router.get('/:sessionId/history', async (req, res) => {
  try {
    const history = await sessionService.getMatchHistory(req.params.sessionId);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

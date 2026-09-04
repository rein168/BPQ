const express = require('express');
const router = express.Router();
const sessionService = require('../services/sessionService');
const { requireHost } = require('../middleware/auth');

// Get courts for a session
router.get('/session/:sessionId', (req, res) => {
  try {
    const courts = sessionService.getSessionCourts(req.params.sessionId);
    res.json({ courts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a court to a session (host only)
router.post('/add', requireHost, (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    const courtId = sessionService.addCourt(sessionId);
    res.json({ success: true, courtId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove a court from a session (host only)
router.post('/remove', requireHost, (req, res) => {
  try {
    const { sessionId, courtId } = req.body;
    if (!sessionId || !courtId) return res.status(400).json({ error: 'Session ID and court ID required' });
    sessionService.removeCourt(sessionId, courtId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;

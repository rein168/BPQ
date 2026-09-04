const express = require('express');
const router = express.Router();
const sessionService = require('../services/sessionService');
const { requireHost } = require('../middleware/auth');

// Auto-allocate players to courts based on skill levels (host only)
router.post('/allocate', requireHost, (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

    const result = sessionService.autoAllocateCourts(sessionId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// End a match on a court (host only)
router.post('/:courtId/finish', requireHost, (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

    const result = sessionService.endCourt(sessionId, req.params.courtId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get court status (anyone can view)
router.get('/:sessionId/:courtId/status', (req, res) => {
  try {
    const status = sessionService.getCourtStatus(req.params.sessionId, req.params.courtId);
    res.json({ status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

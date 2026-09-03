const express = require('express');
const router = express.Router();
const sessionService = require('../services/sessionService');

// Auto-allocate players to courts based on skill levels
router.post('/allocate', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    
    const result = await sessionService.autoAllocateCourts(sessionId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// End a match on a court (game finished)
router.post('/:courtId/finish', async (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });
    
    const result = await sessionService.endCourt(sessionId, req.params.courtId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get court status
router.get('/:sessionId/:courtId/status', async (req, res) => {
  try {
    const status = await sessionService.getCourtStatus(req.params.sessionId, req.params.courtId);
    res.json({ status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

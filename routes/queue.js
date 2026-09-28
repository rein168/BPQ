const express = require('express');
const router = express.Router();
const sessionService = require('../services/sessionService');
const { requireHost } = require('../middleware/auth');

// Auto-allocate players to courts based on skill levels + fairness (host only)
router.post('/allocate', requireHost, (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

    const result = sessionService.autoAllocateCourts(sessionId);
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Begin match on a court (start the timer — anyone can trigger)
router.post('/begin/:courtId', (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

    sessionService.beginMatch(sessionId, req.params.courtId);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// End a match on a court (anyone can do this — players on the court or host)
router.post('/:courtId/finish', (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

    const result = sessionService.endCourt(sessionId, req.params.courtId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Cancel an assignment that hasn't started (host only)
router.post('/:courtId/cancel', requireHost, (req, res) => {
  try {
    sessionService.cancelAssignment(req.body.sessionId, req.params.courtId);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Swap a player on a court for someone in the queue (host only)
router.post('/:courtId/swap', requireHost, (req, res) => {
  try {
    const { sessionId, outPlayerId, inPlayerId } = req.body;
    if (!outPlayerId || !inPlayerId) {
      return res.status(400).json({ error: 'Player to swap out and substitute are required' });
    }
    sessionService.swapPlayer(sessionId, req.params.courtId, outPlayerId, inPlayerId);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
});

// Record score for a completed match (host only)
router.post('/score/:matchId', requireHost, (req, res) => {
  try {
    const { sessionId, scoreA, scoreB } = req.body;

    if (typeof scoreA !== 'number' || typeof scoreB !== 'number') {
      return res.status(400).json({ error: 'Scores must be numbers' });
    }
    if (scoreA < 0 || scoreB < 0 || scoreA > 99 || scoreB > 99) {
      return res.status(400).json({ error: 'Scores must be 0-99' });
    }

    sessionService.recordScore(sessionId, req.params.matchId, scoreA, scoreB);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Get court status (anyone can view)
router.get('/:sessionId/:courtId/status', (req, res) => {
  try {
    const status = sessionService.getCourtStatus(req.params.sessionId, req.params.courtId);
    res.json({ status });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;

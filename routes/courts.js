const express = require('express');
const router = express.Router();
const sessionService = require('../services/sessionService');

// Get all active courts
router.get('/', (req, res) => {
  try {
    const courts = sessionService.getAllCourts();
    res.json({ courts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new court
router.post('/', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Court name required' });
    const trimmedName = name.trim();
    if (trimmedName.length === 0 || trimmedName.length > 50) {
      return res.status(400).json({ error: 'Court name must be 1-50 characters' });
    }

    const courtId = sessionService.createCourt(trimmedName);
    res.json({ success: true, courtId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

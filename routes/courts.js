const express = require('express');
const router = express.Router();
const sessionService = require('../services/sessionService');

// Get all active courts
router.get('/', async (req, res) => {
  try {
    const courts = await sessionService.getAllCourts();
    res.json({ courts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new court
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Court name required' });
    
    const courtId = await sessionService.createCourt(name);
    res.json({ success: true, courtId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

const express = require('express');
const router = express.Router();
const sessionService = require('../services/sessionService');

// Import player roster (cut & paste + skill assignment)
router.post('/import', async (req, res) => {
  try {
    const { sessionId, players } = req.body;
    // players: [{ name: string, skill_level: 'Beginner' | 'Intermediate' }, ...]
    
    if (!sessionId || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    // Validate skill levels
    const validSkills = ['Beginner', 'Intermediate'];
    for (const player of players) {
      if (!player.name || !validSkills.includes(player.skill_level)) {
        return res.status(400).json({ error: 'Invalid player data' });
      }
    }

    const count = await sessionService.importPlayerRoster(sessionId, players);
    res.json({ success: true, imported: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all players in session
router.get('/session/:sessionId', async (req, res) => {
  try {
    const players = await sessionService.getSessionPlayers(req.params.sessionId);
    res.json({ players });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update player skill level
router.put('/:playerId/skill', async (req, res) => {
  try {
    const { skillLevel } = req.body;
    if (!['Beginner', 'Intermediate'].includes(skillLevel)) {
      return res.status(400).json({ error: 'Invalid skill level' });
    }
    await sessionService.updatePlayerSkill(req.params.playerId, skillLevel);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

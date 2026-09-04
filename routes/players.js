const express = require('express');
const router = express.Router();
const sessionService = require('../services/sessionService');
const { requireHost } = require('../middleware/auth');

// Import player roster (host only)
router.post('/import', requireHost, (req, res) => {
  try {
    const { sessionId, players } = req.body;

    if (!sessionId || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({ error: 'Invalid input' });
    }

    if (players.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 players per import' });
    }

    // Validate skill levels and input lengths
    const validSkills = ['Beginner', 'Intermediate'];
    for (const player of players) {
      if (!player.name || typeof player.name !== 'string') {
        return res.status(400).json({ error: 'Invalid player data' });
      }
      const trimmedName = player.name.trim();
      if (trimmedName.length === 0 || trimmedName.length > 100) {
        return res.status(400).json({ error: 'Player name must be 1-100 characters' });
      }
      if (!validSkills.includes(player.skill_level)) {
        return res.status(400).json({ error: 'Invalid player data' });
      }
      player.name = trimmedName;
    }

    const count = sessionService.importPlayerRoster(sessionId, players);
    res.json({ success: true, imported: count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all players in session with stats (anyone can view)
router.get('/session/:sessionId', (req, res) => {
  try {
    const players = sessionService.getPlayersWithStats(req.params.sessionId);
    res.json({ players });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update player skill level (host only)
router.put('/:playerId/skill', requireHost, (req, res) => {
  try {
    const { skillLevel } = req.body;
    if (!['Beginner', 'Intermediate'].includes(skillLevel)) {
      return res.status(400).json({ error: 'Invalid skill level' });
    }
    sessionService.updatePlayerSkill(req.params.playerId, skillLevel);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Set player status (break = anyone, others = host only)
router.put('/:playerId/status', (req, res) => {
  try {
    const { sessionId, status } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

    // 'break' can be toggled by the player themselves (viewer)
    // All other status changes require host
    const viewerAllowed = ['break', 'waiting']; // player can go on break or come back
    if (!viewerAllowed.includes(status)) {
      // Check host access
      const hostSessions = req.signedCookies.hostSessions;
      let isHost = false;
      try {
        if (hostSessions) {
          const authorized = JSON.parse(hostSessions);
          isHost = Array.isArray(authorized) && authorized.includes(Number(sessionId));
        }
      } catch {
        // not a host
      }
      if (!isHost) {
        return res.status(403).json({ error: 'Host access required for this status change' });
      }
    }

    sessionService.setPlayerStatus(req.params.playerId, sessionId, status);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Remove a player from session (host only)
router.delete('/:playerId', requireHost, (req, res) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID required' });

    sessionService.removePlayer(req.params.playerId, sessionId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

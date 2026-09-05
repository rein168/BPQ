const express = require('express');
const router = express.Router();
const sessionService = require('../services/sessionService');
const { requireHost } = require('../middleware/auth');

// Player self-registration (no auth — anyone with the link/QR)
router.post('/register', (req, res) => {
  try {
    const { sessionId, name, skillLevel, mixPreference } = req.body;
    if (!sessionId || !name || !skillLevel) {
      return res.status(400).json({ error: 'Session ID, name, and skill level are required' });
    }

    const trimmedName = name.trim();
    if (trimmedName.length === 0 || trimmedName.length > 100) {
      return res.status(400).json({ error: 'Name must be 1-100 characters' });
    }

    const validSkills = ['Beginner', 'Intermediate', 'Advanced'];
    if (!validSkills.includes(skillLevel)) {
      return res.status(400).json({ error: 'Invalid skill level' });
    }

    const validMixPrefs = ['same_level', 'mix_me_in'];
    const mixPref = validMixPrefs.includes(mixPreference) ? mixPreference : 'same_level';

    // Check session exists and is active
    const session = sessionService.getSession(sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (session.status === 'ended') return res.status(400).json({ error: 'Session has ended' });

    // Check for duplicate name in session
    const existing = sessionService.getSessionPlayers(sessionId);
    const duplicate = existing.find(p => p.name.toLowerCase() === trimmedName.toLowerCase());
    if (duplicate) {
      return res.status(409).json({ error: 'A player with that name is already in this session', playerId: duplicate.id });
    }

    // Cap registration at courts × 8 (FCFS)
    const maxPlayers = sessionService.getMaxPlayers(sessionId);
    if (existing.length >= maxPlayers) {
      return res.status(400).json({ error: 'Game is full (' + maxPlayers + ' players max for ' + (maxPlayers / 8) + ' courts). Contact the host to add more courts.' });
    }

    const playerId = sessionService.registerPlayer(sessionId, trimmedName, skillLevel, mixPref);
    res.json({ success: true, playerId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Look up a player by name in a session (for arrival page on different device)
router.post('/lookup', (req, res) => {
  try {
    const { sessionId, name } = req.body;
    if (!sessionId || !name) {
      return res.status(400).json({ error: 'Session ID and name required' });
    }
    const trimmedName = name.trim();
    if (!trimmedName) return res.status(400).json({ error: 'Name required' });

    const players = sessionService.getSessionPlayers(sessionId);
    const match = players.find(p => p.name.toLowerCase() === trimmedName.toLowerCase());
    if (!match) {
      return res.status(404).json({ error: 'No player with that name found. Did you register?' });
    }
    res.json({ success: true, playerId: match.id, name: match.name, arrived: match.arrived_at != null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Player check-in (arrival — updates arrived_at timestamp)
router.post('/checkin', (req, res) => {
  try {
    const { sessionId, playerId } = req.body;
    if (!sessionId || !playerId) {
      return res.status(400).json({ error: 'Session ID and player ID required' });
    }
    const result = sessionService.checkInPlayer(playerId, sessionId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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
    const validSkills = ['Beginner', 'Intermediate', 'Advanced'];
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
    if (!['Beginner', 'Intermediate', 'Advanced'].includes(skillLevel)) {
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

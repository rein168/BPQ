const bcrypt = require('bcryptjs');

const COOKIE_OPTS = {
  signed: true,
  httpOnly: true,
  sameSite: 'strict',
  secure: process.env.NODE_ENV === 'production',
};

// Read a signed cookie holding a JSON array of numeric IDs
function readIdList(req, name) {
  try {
    const raw = req.signedCookies[name];
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * True if this request has host access to the session (signed cookie set
 * when creating the session or entering its PIN).
 */
function isHostOf(req, sessionId) {
  return readIdList(req, 'hostSessions').includes(Number(sessionId));
}

/**
 * Middleware that checks if the request has host-level access to a session.
 * Extracts sessionId from req.body.sessionId or req.params.sessionId.
 */
function requireHost(req, res, next) {
  const sessionId = req.body.sessionId || req.params.sessionId;

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }

  if (!req.signedCookies.hostSessions) {
    return res.status(403).json({ error: 'Host access required. Please authenticate with the session PIN.' });
  }

  if (!isHostOf(req, sessionId)) {
    return res.status(403).json({ error: 'You are not the host of this session' });
  }

  next();
}

/**
 * Hash a 4-6 digit PIN. Async so bcrypt doesn't block the event loop.
 */
function hashPin(pin) {
  return bcrypt.hash(pin, 10);
}

/**
 * Verify a PIN against its hash.
 */
function verifyPin(pin, hash) {
  return bcrypt.compare(pin, hash);
}

/**
 * Add a session ID to the host sessions cookie.
 */
function grantHostAccess(res, req, sessionId) {
  const authorized = readIdList(req, 'hostSessions');
  if (!authorized.includes(Number(sessionId))) {
    authorized.push(Number(sessionId));
  }

  res.cookie('hostSessions', JSON.stringify(authorized), {
    ...COOKIE_OPTS,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
  });
}

/**
 * Remember that this device registered or checked in a player, so it can
 * manage that player's own break/leave status. Keeps the most recent 50.
 */
function grantPlayerAccess(res, req, playerId) {
  const ids = readIdList(req, 'myPlayers').filter(id => id !== Number(playerId));
  ids.push(Number(playerId));

  res.cookie('myPlayers', JSON.stringify(ids.slice(-50)), {
    ...COOKIE_OPTS,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  });
}

/**
 * True if this device registered or checked in the player.
 */
function hasPlayerAccess(req, playerId) {
  return readMyPlayers(req).includes(Number(playerId));
}

function readMyPlayers(req) {
  return readIdList(req, 'myPlayers');
}

module.exports = {
  requireHost,
  isHostOf,
  hashPin,
  verifyPin,
  grantHostAccess,
  grantPlayerAccess,
  hasPlayerAccess,
  readMyPlayers,
};

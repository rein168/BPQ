const bcrypt = require('bcryptjs');

/**
 * Middleware that checks if the request has host-level access to a session.
 * Host access is granted via a signed cookie set when creating or authenticating
 * to a session with the correct PIN.
 *
 * Extracts sessionId from req.body.sessionId, req.params.sessionId, or req.params.courtId
 * (for court-scoped routes where sessionId is in the body).
 */
function requireHost(req, res, next) {
  const sessionId = req.body.sessionId || req.params.sessionId;

  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }

  const hostSessions = req.signedCookies.hostSessions;
  if (!hostSessions) {
    return res.status(403).json({ error: 'Host access required. Please authenticate with the session PIN.' });
  }

  let authorized;
  try {
    authorized = JSON.parse(hostSessions);
  } catch {
    return res.status(403).json({ error: 'Invalid session cookie' });
  }

  if (!Array.isArray(authorized) || !authorized.includes(Number(sessionId))) {
    return res.status(403).json({ error: 'You are not the host of this session' });
  }

  next();
}

/**
 * Hash a 4-6 digit PIN.
 */
function hashPin(pin) {
  return bcrypt.hashSync(pin, 10);
}

/**
 * Verify a PIN against its hash.
 */
function verifyPin(pin, hash) {
  return bcrypt.compareSync(pin, hash);
}

/**
 * Add a session ID to the host sessions cookie.
 */
function grantHostAccess(res, req, sessionId) {
  let authorized = [];
  try {
    if (req.signedCookies.hostSessions) {
      authorized = JSON.parse(req.signedCookies.hostSessions);
    }
  } catch {
    authorized = [];
  }

  if (!authorized.includes(Number(sessionId))) {
    authorized.push(Number(sessionId));
  }

  res.cookie('hostSessions', JSON.stringify(authorized), {
    signed: true,
    httpOnly: true,
    sameSite: 'strict',
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    secure: process.env.NODE_ENV === 'production',
  });
}

module.exports = { requireHost, hashPin, verifyPin, grantHostAccess };

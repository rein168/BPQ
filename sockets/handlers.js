const sessionService = require('../services/sessionService');

// Sockets are read-only: clients join a session room and receive state.
// All mutations go through the REST API, which enforces host auth.
const registerSocketHandlers = (io) => {
  io.on('connection', (socket) => {
    const sendState = (sessionId) => {
      try {
        const state = sessionService.getSessionState(sessionId);
        if (state) socket.emit(`session:${sessionId}`, state);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    };

    // Join a session room and send the current state to this socket only
    socket.on('join-session', (sessionId) => {
      const id = Number(sessionId);
      if (!Number.isInteger(id)) return;
      socket.join(`session:${id}`);
      sendState(id);
    });

    // Re-fetch state (e.g. after an action) for this socket only
    socket.on('get-session-state', (sessionId) => {
      const id = Number(sessionId);
      if (!Number.isInteger(id)) return;
      sendState(id);
    });
  });
};

module.exports = { registerSocketHandlers };

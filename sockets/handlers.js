const sessionService = require('../services/sessionService');

const registerSocketHandlers = (io) => {
  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Join a session room
    socket.on('join-session', (sessionId) => {
      socket.join(`session:${sessionId}`);
      try {
        sessionService.broadcastSessionState(sessionId);
      } catch (err) {
        console.error('Error joining session:', err);
      }
    });

    // Auto-allocate courts
    socket.on('allocate-courts', (sessionId) => {
      try {
        const result = sessionService.autoAllocateCourts(sessionId);
        io.to(`session:${sessionId}`).emit('courts-allocated', result);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    // End match on a court (game finished)
    socket.on('finish-match', (data) => {
      const { sessionId, courtId } = data;
      try {
        const result = sessionService.endCourt(sessionId, courtId);
        io.to(`session:${sessionId}`).emit('match-finished', {
          courtId,
          durationMs: result.durationMs,
          message: 'Game finished! Next game can start.'
        });
        // Broadcast updated state
        sessionService.broadcastSessionState(sessionId);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    // Get session state
    socket.on('get-session-state', (sessionId) => {
      try {
        sessionService.broadcastSessionState(sessionId);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });
};

module.exports = { registerSocketHandlers };

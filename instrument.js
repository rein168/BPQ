// Sentry must be initialized before express/http are required so its
// auto-instrumentation can hook them. server.js requires this file first.
require('dotenv').config();
const Sentry = require('@sentry/node');

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.2,
  });
  console.log('✅ Sentry error tracking enabled');
}

module.exports = Sentry;

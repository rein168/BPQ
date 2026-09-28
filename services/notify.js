// "You're up" push notifications via OneSignal's REST API.
//
// Players opt in on the arrive page, which logs the device in to OneSignal
// with the external ID "bbq-player-<id>". Sending needs the REST API key
// (server-side secret), so this is a no-op unless both env vars are set:
//   ONESIGNAL_APP_ID, ONESIGNAL_REST_API_KEY

const ONESIGNAL_API = 'https://api.onesignal.com/notifications';

function isConfigured() {
  return !!(process.env.ONESIGNAL_APP_ID && process.env.ONESIGNAL_REST_API_KEY);
}

/**
 * Tell each player their court is ready. Fire-and-forget: failures are
 * logged and never affect allocation.
 * @param {{name: string}} court
 * @param {{id: number, name: string}[]} players
 * @param {string} sessionUrl absolute link to open on tap (optional)
 */
function notifyCourtReady(court, players, sessionUrl) {
  if (!isConfigured() || players.length === 0) return;

  const body = {
    app_id: process.env.ONESIGNAL_APP_ID,
    target_channel: 'push',
    include_aliases: { external_id: players.map((p) => 'bbq-player-' + p.id) },
    headings: { en: "You're up! 🏸" },
    contents: { en: `${court.name}: ${players.map((p) => p.name).join(', ')}` },
    ...(sessionUrl ? { url: sessionUrl } : {}),
  };

  fetch(ONESIGNAL_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Key ' + process.env.ONESIGNAL_REST_API_KEY,
    },
    body: JSON.stringify(body),
  })
    .then(async (res) => {
      if (!res.ok) console.error('OneSignal push failed:', res.status, await res.text());
    })
    .catch((err) => console.error('OneSignal push error:', err.message));
}

module.exports = { notifyCourtReady, isConfigured };

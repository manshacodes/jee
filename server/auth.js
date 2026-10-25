import { timingSafeEqual } from 'node:crypto';

/**
 * Optional HTTP Basic gate.
 *
 * The app has no user accounts -- it is a personal reader -- but a public
 * deployment still needs to keep strangers from reading the feed and changing
 * the fetch interval. Setting APP_PASSWORD turns the gate on; leaving it unset
 * keeps localhost friction-free.
 *
 * Basic auth is deliberate rather than a login form: the browser re-sends the
 * header on every request, including the service worker and manifest fetches,
 * so nothing in the PWA path needs to know about sessions.
 */

const USER = process.env.APP_USER || 'admin';
const PASSWORD = process.env.APP_PASSWORD || '';

/** Constant-time compare that tolerates differing lengths. */
function matches(a, b) {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still burn a comparison so the reply time does not leak the length.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export const isEnabled = () => PASSWORD.length > 0;

export function requireAuth(req, res, next) {
  if (!isEnabled()) return next();

  // Health checks run before a platform will route traffic, so they must not
  // be gated. It reveals nothing but uptime.
  if (req.path === '/api/health') return next();

  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    let decoded = '';
    try {
      decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    } catch {
      decoded = '';
    }
    const index = decoded.indexOf(':');
    if (index !== -1) {
      const user = decoded.slice(0, index);
      const pass = decoded.slice(index + 1);
      if (matches(user, USER) && matches(pass, PASSWORD)) return next();
    }
  }

  res.set('WWW-Authenticate', 'Basic realm="Exam Notice Radar", charset="UTF-8"');
  return res.status(401).type('text/plain').send('Authentication required.');
}

/** Warn loudly when a deployment is left open to the internet. */
export function warnIfOpen() {
  if (isEnabled()) {
    console.log('[auth] password protection is ON');
    return;
  }
  const deployed =
    process.env.RENDER ||
    process.env.FLY_APP_NAME ||
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.DYNO ||
    process.env.K_SERVICE;
  if (deployed) {
    console.warn(
      '[auth] WARNING: APP_PASSWORD is not set, so this deployment is open to ' +
        'anyone who finds the URL. Set APP_PASSWORD in the environment.'
    );
  } else {
    console.log('[auth] no APP_PASSWORD set (fine for localhost)');
  }
}

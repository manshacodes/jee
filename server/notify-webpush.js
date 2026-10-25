import webpush from 'web-push';

/**
 * Real browser push notifications -- the Google-Calendar-style popup -- sent
 * from a scheduled GitHub Actions run.
 *
 * Sending a push does not need a long-running server: it is one signed HTTPS
 * request per device to the browser vendor's push service. What normally needs
 * a server is *remembering which devices to notify*, and in a public repo that
 * list cannot be committed -- anyone could read it and push fake alerts to the
 * user's phone.
 *
 * So the devices live in the PUSH_SUBSCRIPTIONS Actions secret, which stays
 * private even on a public repo. The site's setup flow produces the value to
 * paste there.
 */

export const isConfigured = () =>
  Boolean(
    process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.PUSH_SUBSCRIPTIONS
  );

/**
 * The secret holds either one subscription object or an array of them, so a
 * second device can be added by pasting both.
 */
export function parseSubscriptions(raw) {
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('PUSH_SUBSCRIPTIONS is not valid JSON');
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const valid = list.filter((s) => s && typeof s.endpoint === 'string' && s.keys);
  if (valid.length !== list.length) {
    throw new Error('PUSH_SUBSCRIPTIONS contains an entry with no endpoint or keys');
  }
  return valid;
}

function buildPayload(notices, siteUrl) {
  const streams = [...new Set(notices.flatMap((n) => n.categories))].filter((c) => c !== 'other');
  const labels = { jee: 'JEE', neet: 'NEET UG', class10: 'Class 10', class12: 'Class 12' };
  const what = streams.map((c) => labels[c] || c).join(', ') || 'Exam';

  return JSON.stringify({
    title: notices.length === 1 ? `New ${what} notice` : `${notices.length} new ${what} notices`,
    body:
      notices.length === 1
        ? notices[0].title.slice(0, 240)
        : notices
            .slice(0, 4)
            .map((n) => n.title)
            .join('\n')
            .slice(0, 240),
    tag: 'exam-notice-radar',
    url: notices.length === 1 ? notices[0].url : siteUrl || '/',
    count: notices.length,
  });
}

/**
 * @param {object[]} notices newly discovered notices
 * @param {object}  [opts]
 * @param {string}  [opts.siteUrl]
 * @returns {Promise<{sent:number, failed:number, gone:string[], reason?:string}>}
 */
export async function notifyWebPush(notices, { siteUrl } = {}) {
  if (!notices.length) return { sent: 0, failed: 0, gone: [], reason: 'nothing new' };
  if (!isConfigured()) {
    return { sent: 0, failed: 0, gone: [], reason: 'VAPID keys or PUSH_SUBSCRIPTIONS not set' };
  }

  let subscriptions;
  try {
    subscriptions = parseSubscriptions(process.env.PUSH_SUBSCRIPTIONS);
  } catch (err) {
    return { sent: 0, failed: 0, gone: [], reason: err.message };
  }
  if (!subscriptions.length) {
    return { sent: 0, failed: 0, gone: [], reason: 'no devices registered' };
  }

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:noreply@example.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

  const payload = buildPayload(notices, siteUrl);
  const gone = [];
  let sent = 0;
  let failed = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          // The browser dropped this subscription; it will never work again.
          gone.push(sub.endpoint);
        } else {
          failed += 1;
          console.error(`[webpush] send failed (${err.statusCode || '?'}): ${err.message}`);
        }
      }
    })
  );

  return { sent, failed, gone };
}

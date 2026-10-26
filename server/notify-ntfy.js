/**
 * Push alerts via ntfy.sh.
 *
 * The Web Push sender in push.js needs a long-lived server holding each
 * device's subscription. A GitHub Actions run is neither long-lived nor a safe
 * place to keep those endpoints -- in a public repo anyone could read them and
 * push notifications to the user's phone. ntfy inverts that: the phone
 * subscribes to a topic, and the only secret is the topic name, which lives in
 * an Actions secret.
 *
 * Configure with NTFY_TOPIC (required) and optionally NTFY_SERVER for a
 * self-hosted instance. NTFY_TOKEN is sent as a bearer token for protected
 * topics.
 */

const DEFAULT_SERVER = 'https://ntfy.sh';

export const isConfigured = () => Boolean(process.env.NTFY_TOPIC);

/** ntfy headers must be Latin-1; notice titles routinely are not. */
function asciiHeader(text, max = 200) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * @param {object[]} notices newly discovered notices
 * @param {object}  [opts]
 * @param {string}  [opts.siteUrl] link the alert should open
 * @returns {Promise<{sent:boolean, reason?:string, status?:number}>}
 */
export async function notifyNtfy(notices, { siteUrl } = {}) {
  if (!notices.length) return { sent: false, reason: 'nothing new' };
  if (!isConfigured()) return { sent: false, reason: 'NTFY_TOPIC not set' };

  const server = (process.env.NTFY_SERVER || DEFAULT_SERVER).replace(/\/+$/, '');
  const topic = process.env.NTFY_TOPIC;

  const title =
    notices.length === 1
      ? `${notices[0].categories.filter((c) => c !== 'other').join('/') || 'Exam'} just dropped`
      : `${notices.length} new drops`;

  // Body carries the detail; keep it readable on a lock screen.
  const body = notices
    .slice(0, 8)
    .map((n) => `• ${n.title}`)
    .join('\n')
    .concat(notices.length > 8 ? `\n…and ${notices.length - 8} more` : '');

  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    Title: asciiHeader(title),
    Priority: 'default',
    Tags: 'mega',
  };
  // One link: the site for a batch, the document itself for a single notice.
  const click = notices.length === 1 ? notices[0].url : siteUrl;
  if (click) headers.Click = click;
  if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;

  try {
    const res = await fetch(`${server}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers,
      body,
    });
    if (!res.ok) {
      return { sent: false, reason: `ntfy responded ${res.status}`, status: res.status };
    }
    return { sent: true, status: res.status };
  } catch (err) {
    // A failed alert must never fail the scrape that produced it.
    return { sent: false, reason: err.message };
  }
}

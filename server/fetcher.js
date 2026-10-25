import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36 ExamNoticeRadar/1.0';

/**
 * Several Indian government education portals are flaky: they reset
 * connections under load and a couple of them serve an incomplete TLS chain
 * (nta.ac.in omits its intermediate certificate, which browsers paper over by
 * fetching it via AIA but Node does not). So: retry with backoff, and allow an
 * explicit per-host opt-out of chain verification via INSECURE_TLS_HOSTS.
 */
const insecureHosts = new Set(
  (process.env.INSECURE_TLS_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
);

function once(url, { timeout = 30000, redirectsLeft = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    if (!secure && target.protocol !== 'http:') {
      reject(new Error(`Unsupported protocol ${target.protocol} for ${url}`));
      return;
    }
    const request = secure ? httpsRequest : httpRequest;
    const req = request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (secure ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: 'GET',
        timeout,
        // Only meaningful over TLS; harmless on plain HTTP.
        rejectUnauthorized: !insecureHosts.has(target.hostname.toLowerCase()),
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-IN,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
      },
      (res) => {
        const { statusCode, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirectsLeft <= 0) return reject(new Error(`Too many redirects for ${url}`));
          const next = new URL(headers.location, url).toString();
          return once(next, { timeout, redirectsLeft: redirectsLeft - 1 }).then(resolve, reject);
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error(`Timed out after ${timeout}ms: ${url}`)));
    req.on('error', reject);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GET a page as text, retrying transient network failures. */
export async function fetchHtml(url, { attempts = 3, timeout = 30000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await once(url, { timeout });
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(1500 * 2 ** i);
    }
  }
  throw lastErr;
}

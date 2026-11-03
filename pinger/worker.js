/**
 * Keeps lurk :p on schedule.
 *
 * GitHub deprioritises the `schedule` event on free public repositories and
 * drops most firings -- measured on this repo at roughly 9% honoured, with
 * gaps of up to 10.7 hours against a cron asking for every 30 minutes. A
 * workflow started through the API is not subject to that, so this Worker
 * does the scheduling instead and asks GitHub to run the workflow.
 *
 * The Worker holds nothing but a token scoped to one repository's Actions.
 * Everything it can do, the scheduled workflow already does on its own.
 */

const API = 'https://api.github.com';

/** Ask GitHub to run the workflow now. 204 means accepted. */
async function dispatch(env) {
  const url = `${API}/repos/${env.REPO}/actions/workflows/${env.WORKFLOW}/dispatches`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub rejects API requests that do not identify themselves.
      'User-Agent': 'lurk-pinger',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: env.BRANCH }),
  });

  if (response.status === 204) return { ok: true, status: 204 };

  // Worth distinguishing: 401 is almost always an expired or revoked token,
  // which is the one failure that otherwise goes unnoticed for weeks.
  const detail = await response.text().catch(() => '');
  return {
    ok: false,
    status: response.status,
    reason:
      response.status === 401 || response.status === 403
        ? 'GitHub refused the token — it has probably expired or lost its Actions permission.'
        : detail.slice(0, 300) || response.statusText,
  };
}

export default {
  /** The cron trigger. This is the whole point of the Worker. */
  async scheduled(event, env, ctx) {
    const result = await dispatch(env);
    if (result.ok) {
      console.log(`[pinger] asked GitHub to lurk (cron ${event.cron})`);
    } else {
      // Surfaces in `wrangler tail` and in the Worker's logs.
      console.error(`[pinger] dispatch failed: ${result.status} ${result.reason}`);
    }
  },

  /**
   * Visiting the Worker is a manual "lurk now" button that works from a phone
   * without opening GitHub. It needs the key, so a stray crawler cannot spin
   * the workflow up.
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const key = url.searchParams.get('key');

    if (!key) {
      return new Response(
        'lurk pinger\n\n' +
          'This asks GitHub to run the scrape workflow, on a schedule and on demand.\n' +
          'To trigger one now, add ?key=<your PING_KEY>.\n',
        { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
      );
    }

    if (!env.PING_KEY || key !== env.PING_KEY) {
      return new Response('Wrong key.\n', { status: 403 });
    }

    const result = await dispatch(env);
    return new Response(
      result.ok
        ? 'Lurking now. Give it about a minute, then reload the site.\n'
        : `Could not start it: ${result.status} ${result.reason}\n`,
      {
        status: result.ok ? 200 : 502,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      }
    );
  },
};

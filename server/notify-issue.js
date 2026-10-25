/**
 * Alerts by GitHub issue.
 *
 * The point is reaching the user with no app to install and no credentials to
 * set up: the scheduled run opens an issue on the repo, and GitHub emails the
 * owner about it, because you automatically watch repositories you own. The
 * token is the one Actions already provides.
 *
 * Each batch of new notices becomes one issue, which doubles as a read queue:
 * open issues are batches you have not dealt with yet.
 */

const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

export const isConfigured = () =>
  Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPOSITORY);

const CATEGORY_LABELS = {
  jee: 'JEE',
  neet: 'NEET UG',
  class10: 'Class 10',
  class12: 'Class 12',
  other: 'Other',
};

function summarise(notices) {
  const streams = [...new Set(notices.flatMap((n) => n.categories))]
    .filter((c) => c !== 'other')
    .map((c) => CATEGORY_LABELS[c] || c);
  const what = streams.length ? streams.join(', ') : 'exam';
  return notices.length === 1
    ? `New ${what} notice: ${notices[0].title}`
    : `${notices.length} new ${what} notices`;
}

function body(notices, { siteUrl } = {}) {
  const lines = notices.map((n) => {
    const tags = n.categories
      .filter((c) => c !== 'other')
      .map((c) => `\`${CATEGORY_LABELS[c] || c}\``)
      .join(' ');
    const when = n.publishedAt ? ` — ${n.dateInferred ? 'around ' : ''}${n.publishedAt}` : '';
    // Titles are scraped; keep them out of Markdown's way.
    const safeTitle = String(n.title).replace(/([\[\]])/g, '\\$1');
    // An uncategorised notice has no tags, so do not leave a double space.
    const prefix = tags ? `${tags} ` : '';
    return `- ${prefix}[${safeTitle}](${n.url})\n  <sub>${n.sourceLabel}${when}</sub>`;
  });

  const head =
    notices.length === 1
      ? 'One new notice was published:'
      : `${notices.length} new notices were published:`;

  // Blank lines are load-bearing: a `---` directly under text is a Markdown
  // setext heading, which would turn the last notice into an <h2>.
  const footer = [
    siteUrl ? `[Open the full feed](${siteUrl})` : null,
    '<sub>Posted automatically by the scheduled scrape. Close this issue once you have read it.</sub>',
  ].filter((line) => line !== null);

  return [head, '', ...lines, '', '---', '', ...footer].join('\n');
}

/**
 * @param {object[]} notices newly discovered notices
 * @param {object}  [opts]
 * @param {string}  [opts.siteUrl]
 * @returns {Promise<{sent:boolean, reason?:string, url?:string}>}
 */
export async function notifyIssue(notices, { siteUrl } = {}) {
  if (!notices.length) return { sent: false, reason: 'nothing new' };
  if (!isConfigured()) {
    return { sent: false, reason: 'GITHUB_TOKEN/GITHUB_REPOSITORY not set' };
  }

  const repo = process.env.GITHUB_REPOSITORY;
  try {
    const res = await fetch(`${API}/repos/${repo}/issues`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: summarise(notices).slice(0, 250),
        body: body(notices, { siteUrl }),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { sent: false, reason: `GitHub responded ${res.status} ${detail.slice(0, 120)}` };
    }
    const created = await res.json();
    return { sent: true, url: created.html_url, number: created.number };
  } catch (err) {
    // An alert that fails must never fail the scrape that produced it.
    return { sent: false, reason: err.message };
  }
}

export const __test = { summarise, body };

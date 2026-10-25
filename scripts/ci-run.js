#!/usr/bin/env node
/**
 * One scrape, as run by GitHub Actions.
 *
 * Differs from the long-running server in three ways: it keeps its state in a
 * committed file rather than a disk the next run would not see, it sends
 * alerts to channels that need no server to hold subscriptions (a GitHub
 * issue, browser push from secrets, ntfy), and it never exits non-zero for a
 * single dead source -- a failing notice board must not turn the repo's CI
 * red every half hour.
 *
 * With TEST_ALERT=true it sends a sample alert and does no scraping, so a
 * user can confirm their setup instead of waiting for the boards to publish.
 */
import { appendFile } from 'node:fs/promises';

import { runIngest } from '../server/ingest.js';
import { getNotices } from '../server/store.js';
import { isConfigured as ntfyConfigured, notifyNtfy } from '../server/notify-ntfy.js';
import { isConfigured as issueConfigured, notifyIssue } from '../server/notify-issue.js';
import { isConfigured as webPushConfigured, notifyWebPush } from '../server/notify-webpush.js';

const SITE_URL = process.env.SITE_URL || '';

/**
 * A test alert, so the user can confirm their setup works without waiting for
 * the boards to publish something. Without this there is no feedback at all
 * between finishing setup and the next real notice, which could be days.
 */
if (process.env.TEST_ALERT === 'true') {
  const sample = [
    {
      title: 'Test alert — your notifications are working',
      url: SITE_URL || 'https://github.com',
      sourceLabel: 'Exam Notice Radar',
      categories: ['other'],
      publishedAt: null,
      dateInferred: false,
    },
  ];

  console.log('Sending a test alert to every configured channel.\n');
  let any = false;

  if (webPushConfigured()) {
    const push = await notifyWebPush(sample, { siteUrl: SITE_URL });
    any = true;
    if (push.reason) {
      console.log(`popups: NOT sent — ${push.reason}`);
    } else {
      console.log(
        `popups: sent to ${push.sent} device(s)` +
          (push.failed ? `, ${push.failed} failed` : '') +
          (push.gone.length ? `, ${push.gone.length} expired (re-run setup on that device)` : '')
      );
    }
  } else {
    console.log(
      'popups: not configured. Add VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and ' +
        'PUSH_SUBSCRIPTIONS as repository secrets using the values the site gave you.'
    );
  }

  if (process.env.NOTIFY_ISSUE !== 'false') {
    const issue = await notifyIssue(sample, { siteUrl: SITE_URL });
    any = true;
    console.log(issue.sent ? `email: issue opened — ${issue.url}` : `email: NOT sent — ${issue.reason}`);
  }

  if (ntfyConfigured()) {
    const ntfy = await notifyNtfy(sample, { siteUrl: SITE_URL });
    any = true;
    console.log(ntfy.sent ? 'ntfy: sent' : `ntfy: NOT sent — ${ntfy.reason}`);
  }

  if (!any) console.log('No alert channel is configured, so nothing was sent.');
  console.log('\nNo scraping was done for a test run.');
  process.exit(0);
}

const result = await runIngest({ trigger: 'scheduled' });

for (const s of result.sources) {
  const status = s.ok ? 'ok ' : 'ERR';
  console.log(`  ${status} ${s.label.padEnd(28)} ${String(s.count).padStart(4)} notices  ${s.ms}ms`);
  s.errors.forEach((e) => console.log(`      - ${e}`));
}

const total = (await getNotices()).length;
console.log(`\nnew: ${result.added}, stored: ${total}`);

// Two independent channels, both optional, neither allowed to fail the run.
//   - a GitHub issue, which GitHub then emails to the repo owner. No app and
//     no credentials: it uses the token Actions already provides.
//   - ntfy, for anyone who prefers a push app.
if (result.addedNotices.length) {
  const wanted = process.env.NOTIFY_ISSUE !== 'false';
  if (wanted) {
    const issue = await notifyIssue(result.addedNotices, { siteUrl: SITE_URL });
    console.log(
      issue.sent
        ? `alert: opened issue #${issue.number} (${issue.url})`
        : `alert: no issue opened (${issue.reason})`
    );
  }

  if (webPushConfigured()) {
    const push = await notifyWebPush(result.addedNotices, { siteUrl: SITE_URL });
    if (push.reason) {
      console.log(`alert: no popups sent (${push.reason})`);
    } else {
      console.log(
        `alert: popups sent to ${push.sent} device(s)` +
          (push.failed ? `, ${push.failed} failed` : '') +
          (push.gone.length ? `, ${push.gone.length} expired` : '')
      );
      if (push.gone.length) {
        console.log(
          '      a device is no longer reachable; re-run the setup on it and update ' +
            'the PUSH_SUBSCRIPTIONS secret'
        );
      }
    }
  }

  if (ntfyConfigured()) {
    const ntfy = await notifyNtfy(result.addedNotices, { siteUrl: SITE_URL });
    console.log(ntfy.sent ? 'alert: sent to ntfy' : `alert: ntfy not sent (${ntfy.reason})`);
  }

  if (!wanted && !ntfyConfigured() && !webPushConfigured()) {
    console.log('alert: no channel enabled, so nothing was sent');
  }
} else if (!issueConfigured() && !ntfyConfigured() && !webPushConfigured()) {
  console.log('alert: no channel configured, so no alerts will be sent');
}

// Surface the outcome in the workflow summary and to later steps.
const failed = result.sources.filter((s) => !s.ok);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `added=${result.added}\ntotal=${total}\nfailed=${failed.length}\n`
  );
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = result.sources
    .map((s) => `| ${s.label} | ${s.ok ? '✅' : '⚠️'} | ${s.count} | ${s.errors[0] || ''} |`)
    .join('\n');
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `### Scrape: ${result.added} new, ${total} stored\n\n` +
      `| Source | OK | Notices | Error |\n| --- | --- | --- | --- |\n${rows}\n`
  );
}

// Every source failing means the run genuinely achieved nothing: worth a red
// build. One or two failing is normal for these sites and must not be.
if (failed.length === result.sources.length) {
  console.error('\nEvery source failed; failing the run so it is visible.');
  process.exit(1);
}

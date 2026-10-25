#!/usr/bin/env node
/**
 * One scrape, as run by GitHub Actions.
 *
 * Differs from the long-running server in three ways: it keeps its state in a
 * committed file rather than a disk the next run would not see, it sends
 * alerts through ntfy rather than Web Push, and it never exits non-zero for a
 * single dead source -- a failing notice board must not turn the repo's CI
 * red every half hour.
 */
import { appendFile } from 'node:fs/promises';

import { runIngest } from '../server/ingest.js';
import { getNotices } from '../server/store.js';
import { isConfigured as ntfyConfigured, notifyNtfy } from '../server/notify-ntfy.js';
import { isConfigured as issueConfigured, notifyIssue } from '../server/notify-issue.js';

const SITE_URL = process.env.SITE_URL || '';

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

  if (ntfyConfigured()) {
    const ntfy = await notifyNtfy(result.addedNotices, { siteUrl: SITE_URL });
    console.log(ntfy.sent ? 'alert: sent to ntfy' : `alert: ntfy not sent (${ntfy.reason})`);
  }

  if (!wanted && !ntfyConfigured()) {
    console.log('alert: no channel enabled, so nothing was sent');
  }
} else if (!issueConfigured() && !ntfyConfigured()) {
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

import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'ci-run.js');

const VALID_PUBLIC =
  'BCn9KB1hNd1dOnFRCGeek5bDXg0OzffKSSixgKj3_kvtwU_kL2Elp1E9bHfh3bqGZR3JvJssZiqTpX0tADkr5_c';
const VALID_PRIVATE = 'WI1mKcpqTBLcF63fjCp0RhuPIBNpWWr_Kcn5kL5MDQ0';

/**
 * The test-alert path exists so somebody who has just pasted three secrets can
 * find out whether they got it right, instead of waiting days for the boards
 * to publish something. It must never scrape, and it must say plainly which
 * channel worked and which did not.
 */
async function testAlert(env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'ci-run-'));
  try {
    const { stdout } = await run('node', [SCRIPT], {
      env: {
        ...process.env,
        DATA_DIR: dir,
        TEST_ALERT: 'true',
        NOTIFY_ISSUE: 'false',
        GITHUB_TOKEN: '',
        GITHUB_REPOSITORY: '',
        NTFY_TOPIC: '',
        VAPID_PUBLIC_KEY: '',
        VAPID_PRIVATE_KEY: '',
        PUSH_SUBSCRIPTIONS: '',
        ...env,
      },
    });
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('a test run never scrapes the notice boards', async () => {
  const out = await testAlert();
  assert.match(out, /No scraping was done/);
  // The scrape would print a per-source table; none of it should appear.
  assert.ok(!out.includes('NTA — JEE (Main)'), 'a test run hit the live sites');
  assert.ok(!/stored:/.test(out), 'a test run touched the feed');
});

test('an unconfigured setup is told exactly which secrets to add', async () => {
  const out = await testAlert();
  assert.match(out, /popups: not configured/);
  assert.match(out, /VAPID_PUBLIC_KEY/);
  assert.match(out, /VAPID_PRIVATE_KEY/);
  assert.match(out, /PUSH_SUBSCRIPTIONS/);
});

test('a bad paste is named as such rather than failing silently', async () => {
  const out = await testAlert({
    VAPID_PUBLIC_KEY: VALID_PUBLIC,
    VAPID_PRIVATE_KEY: VALID_PRIVATE,
    PUSH_SUBSCRIPTIONS: '[{"endpoint":"https://fcm',
  });
  assert.match(out, /popups: NOT sent/);
  assert.match(out, /not valid JSON/);
});

test('a subscription missing its keys is reported', async () => {
  const out = await testAlert({
    VAPID_PUBLIC_KEY: VALID_PUBLIC,
    VAPID_PRIVATE_KEY: VALID_PRIVATE,
    PUSH_SUBSCRIPTIONS: '[{"endpoint":"https://fcm.googleapis.com/fcm/send/x"}]',
  });
  assert.match(out, /popups: NOT sent/);
  assert.match(out, /no endpoint or keys/);
});

test('a test run exits successfully so the workflow stays green', async () => {
  // execFile rejects on a non-zero exit, so reaching here is the assertion.
  await testAlert();
});

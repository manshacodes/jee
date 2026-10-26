import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';

/**
 * These cover the decision logic around pushing -- whether to send, to whom,
 * and what the alert says -- with the actual network send stubbed out.
 */
let dir;
let push;
let store;
let webpush;
let realSend;
/** Calls captured from the stubbed web-push send. */
let sends;

/**
 * Replace the network send with a stub. Done by hand rather than with
 * node:test's mock helpers so the capture is explicit and easy to assert on.
 */
function stubSend(impl) {
  webpush.sendNotification = async (sub, payload) => {
    sends.push({ sub, payload });
    return impl ? impl(sub, payload) : { statusCode: 201 };
  };
}

/**
 * The modules are imported exactly once, after DATA_DIR is set: store.js reads
 * it at import time, and push.js imports store.js itself, so re-importing one
 * under a cache-busting query would leave the two halves pointing at different
 * directories. Per-test isolation therefore resets the stored state instead.
 */
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notice-push-'));
  process.env.DATA_DIR = dir;
  store = await import('../server/store.js');
  push = await import('../server/push.js');
  webpush = (await import('web-push')).default;
  realSend = webpush.sendNotification;
  await push.initPush();
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  sends = [];
  await store.saveSettings({ ...store.DEFAULT_SETTINGS });
  const existing = await store.getSubscriptions();
  await store.removeSubscriptions(existing.map((sub) => sub.endpoint));
  await store.addSubscription({ endpoint: 'https://push.example/a', keys: {} });
  await store.addSubscription({ endpoint: 'https://push.example/b', keys: {} });
});

afterEach(() => {
  webpush.sendNotification = realSend;
});

const notice = (over = {}) => ({
  id: 'abc',
  title: 'JEE Main 2027 session 1 application form is live',
  url: 'https://jeemain.nta.nic.in/a.pdf',
  sourceLabel: 'NTA — JEE (Main)',
  categories: ['jee'],
  ...over,
});

test('sends one alert per registered device', async () => {
  stubSend();
  const result = await push.broadcastNewNotices([notice()]);
  assert.equal(result.sent, 2);
  assert.equal(sends.length, 2);
});

test('a single notice is announced by its own title', async () => {
  stubSend();
  await push.broadcastNewNotices([notice()]);
  const payload = JSON.parse(sends[0].payload);
  assert.match(payload.body, /JEE Main 2027 session 1/);
  assert.equal(payload.url, 'https://jeemain.nta.nic.in/a.pdf', 'tapping the alert should open the notice');
});

test('a burst is summarised into a single count', async () => {
  stubSend();
  await push.broadcastNewNotices([notice(), notice({ id: 'b' }), notice({ id: 'c' })]);
  const payload = JSON.parse(sends[0].payload);
  assert.match(payload.body, /\b3\b/);
  assert.equal(payload.count, 3);
  assert.equal(payload.url, '/', 'a burst should open the app, not one arbitrary notice');
});

test('nothing is sent when push is switched off', async () => {
  await store.saveSettings({ pushEnabled: false });
  stubSend();
  const result = await push.broadcastNewNotices([notice()]);
  assert.equal(result.sent, 0);
  assert.equal(sends.length, 0);
});

test('category filters limit which notices raise an alert', async () => {
  await store.saveSettings({ pushCategories: ['neet'] });
  stubSend();

  const ignored = await push.broadcastNewNotices([notice({ categories: ['jee'] })]);
  assert.equal(ignored.sent, 0, 'a JEE notice must not alert a NEET-only subscriber');

  const wanted = await push.broadcastNewNotices([notice({ categories: ['neet'] })]);
  assert.equal(wanted.sent, 2);
  assert.equal(sends.length, 2);
});

test('an empty category filter means every category', async () => {
  await store.saveSettings({ pushCategories: [] });
  stubSend();
  const result = await push.broadcastNewNotices([notice({ categories: ['other'] })]);
  assert.equal(result.sent, 2);
});

test('devices the push service reports as gone are pruned', async () => {
  stubSend((sub) => {
    if (sub.endpoint.endsWith('/a')) {
      const err = new Error('Gone');
      err.statusCode = 410;
      throw err;
    }
    return { statusCode: 201 };
  });
  const result = await push.broadcastNewNotices([notice()]);
  assert.equal(result.sent, 1);
  assert.equal(result.pruned, 1);
  assert.deepEqual(
    (await store.getSubscriptions()).map((s) => s.endpoint),
    ['https://push.example/b']
  );
});

test('a transient send failure leaves the subscription in place', async () => {
  stubSend(() => {
    const err = new Error('Service Unavailable');
    err.statusCode = 503;
    throw err;
  });
  const result = await push.broadcastNewNotices([notice()]);
  assert.equal(result.sent, 0);
  assert.equal(result.pruned, 0);
  assert.equal((await store.getSubscriptions()).length, 2, 'a 503 is not a dead device');
});

test('an empty batch does nothing', async () => {
  stubSend();
  const result = await push.broadcastNewNotices([]);
  assert.equal(result.sent, 0);
  assert.equal(sends.length, 0);
});

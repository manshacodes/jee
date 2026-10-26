import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

process.env.NODE_ENV = 'test';

let dir;
let server;
let origin;
let store;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notice-api-'));
  process.env.DATA_DIR = dir;

  store = await import('../server/store.js');
  const { initPush } = await import('../server/push.js');
  await initPush();
  const { app } = await import('../server/index.js');

  // Seed two runs so the store holds both read history and an unread notice.
  const base = {
    url: 'https://jeemain.nta.nic.in/a.pdf',
    sourceId: 'nta-jee',
    sourceLabel: 'NTA — JEE (Main)',
  };
  await store.mergeNotices([
    { ...base, title: 'JEE Main 2027 application form', categories: ['jee'], publishedAt: '2026-10-24' },
    {
      ...base,
      url: 'https://cbse/x.pdf',
      sourceId: 'cbse',
      sourceLabel: 'CBSE',
      title: 'Date Sheet for Class X & XII Board Examinations',
      categories: ['class10', 'class12'],
      publishedAt: '2026-10-05',
    },
  ]);
  await store.mergeNotices([
    {
      ...base,
      url: 'https://neet/n.pdf',
      sourceId: 'nta-neet',
      sourceLabel: 'NTA — NEET (UG)',
      title: 'NEET UG 2027 information bulletin',
      categories: ['neet'],
      publishedAt: '2026-10-20',
    },
  ]);

  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

const get = async (path) => {
  const res = await fetch(`${origin}${path}`);
  return { status: res.status, body: await res.json() };
};
const send = async (path, method, body) => {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

test('GET /api/meta describes the categories, sources and push key', async () => {
  const { status, body } = await get('/api/meta');
  assert.equal(status, 200);
  assert.deepEqual(
    body.categories.map((c) => c.id),
    ['jee', 'neet', 'class10', 'class12', 'other']
  );
  assert.ok(body.sources.length >= 4);
  assert.ok(body.intervalChoices.includes(30));
  assert.ok(body.vapidPublicKey, 'a push key should be generated on boot');
});

test('GET /api/notifications returns everything newest-first with counts', async () => {
  const { body } = await get('/api/notifications');
  assert.equal(body.total, 3);
  assert.equal(body.notifications[0].title, 'NEET UG 2027 information bulletin', 'the newly found notice should lead');
  assert.equal(body.counts.all, 3);
  assert.equal(body.counts.new, 1);
  assert.equal(body.counts.jee, 1);
  assert.equal(body.counts.class10, 1);
  assert.equal(body.counts.class12, 1);
});

test('a notice in two categories appears under both', async () => {
  const ten = await get('/api/notifications?category=class10');
  const twelve = await get('/api/notifications?category=class12');
  assert.equal(ten.body.total, 1);
  assert.equal(twelve.body.total, 1);
  assert.equal(ten.body.notifications[0].id, twelve.body.notifications[0].id);
});

test('filters by category, source, search text and unread', async () => {
  assert.equal((await get('/api/notifications?category=jee')).body.total, 1);
  assert.equal((await get('/api/notifications?source=cbse')).body.total, 1);
  assert.equal((await get('/api/notifications?q=date%20sheet')).body.total, 1);
  assert.equal((await get('/api/notifications?q=DATE%20SHEET')).body.total, 1, 'search should ignore case');
  assert.equal((await get('/api/notifications?onlyNew=true')).body.total, 1);
  assert.equal((await get('/api/notifications?category=jee&source=cbse')).body.total, 0);
});

test('paginates with limit and offset', async () => {
  const page1 = await get('/api/notifications?limit=2&offset=0');
  const page2 = await get('/api/notifications?limit=2&offset=2');
  assert.equal(page1.body.notifications.length, 2);
  assert.equal(page2.body.notifications.length, 1);
  assert.equal(page1.body.total, 3, 'total should describe the whole filtered set, not the page');
});

test('an unknown category is rejected', async () => {
  const { status, body } = await get('/api/notifications?category=bogus');
  assert.equal(status, 400);
  assert.match(body.error, /Unknown category/);
});

test('PUT /api/settings validates the fetch interval', async () => {
  assert.equal((await send('/api/settings', 'PUT', { intervalMinutes: 0 })).status, 400);
  assert.equal((await send('/api/settings', 'PUT', { intervalMinutes: 1441 })).status, 400);
  assert.equal((await send('/api/settings', 'PUT', { intervalMinutes: 'soon' })).status, 400);
  const ok = await send('/api/settings', 'PUT', { intervalMinutes: 15 });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.intervalMinutes, 15);
});

test('PUT /api/settings validates theme and push categories', async () => {
  assert.equal((await send('/api/settings', 'PUT', { theme: 'neon' })).status, 400);
  assert.equal((await send('/api/settings', 'PUT', { pushCategories: 'jee' })).status, 400);
  assert.equal((await send('/api/settings', 'PUT', { pushCategories: ['nope'] })).status, 400);
  const ok = await send('/api/settings', 'PUT', { theme: 'dark', pushCategories: ['jee', 'neet'] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.pushCategories, ['jee', 'neet']);
});

test('turning auto-fetch off clears the next scheduled run', async () => {
  const off = await send('/api/settings', 'PUT', { autoFetch: false });
  assert.equal(off.body.autoFetch, false);
  assert.equal(off.body.nextRunAt, null);
  const on = await send('/api/settings', 'PUT', { autoFetch: true, intervalMinutes: 60 });
  assert.ok(on.body.nextRunAt, 'turning it back on should arm the timer');
  // Leave the scheduler idle so the test process can exit.
  await send('/api/settings', 'PUT', { autoFetch: false });
});

test('GET /api/status reports settings, counts and push availability', async () => {
  const { body } = await get('/api/status');
  assert.equal(body.running, false);
  assert.equal(body.pushSupported, true);
  assert.equal(body.counts.all, 3);
  assert.equal(typeof body.settings.intervalMinutes, 'number');
});

test('marking read clears the unread count', async () => {
  const { body } = await send('/api/notifications/read', 'POST', { ids: [] });
  assert.equal(body.counts.new, 0);
  assert.equal((await get('/api/notifications?onlyNew=true')).body.total, 0);
});

test('push subscribe and unsubscribe round-trip', async () => {
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'x', auth: 'y' } };
  const added = await send('/api/push/subscribe', 'POST', { subscription: sub });
  assert.equal(added.status, 200);
  assert.equal(added.body.devices, 1);

  const bad = await send('/api/push/subscribe', 'POST', { subscription: {} });
  assert.equal(bad.status, 400);

  const removed = await send('/api/push/unsubscribe', 'POST', { endpoint: sub.endpoint });
  assert.equal(removed.body.devices, 0);
  assert.equal((await send('/api/push/unsubscribe', 'POST', {})).status, 400);
});

test('the SSE stream opens and stays open', async () => {
  const controller = new AbortController();
  const res = await fetch(`${origin}/api/stream`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const chunk = await res.body.getReader().read();
  assert.match(new TextDecoder().decode(chunk.value), /retry:/);
  controller.abort();
});

test('the single-page app is served at the root', async () => {
  const res = await fetch(`${origin}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /lurk :p/);
  assert.match(html, /id="categoryNav"/);
});

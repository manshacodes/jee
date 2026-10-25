import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

/**
 * The password gate is what stands between a public deployment and anyone who
 * finds the URL, so it gets its own server instance with APP_PASSWORD set.
 */
process.env.NODE_ENV = 'test';
process.env.APP_USER = 'mansha';
process.env.APP_PASSWORD = 'correct-horse-battery-staple';

let dir;
let server;
let origin;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notice-auth-'));
  process.env.DATA_DIR = dir;
  const { initPush } = await import('../server/push.js');
  await initPush();
  const { app } = await import('../server/index.js');
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
  delete process.env.APP_PASSWORD;
  delete process.env.APP_USER;
});

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
const good = basic('mansha', 'correct-horse-battery-staple');

test('the UI and the API are closed without credentials', async () => {
  for (const path of ['/', '/index.html', '/api/notifications', '/api/status', '/api/meta']) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 401, `${path} was served without credentials`);
  }
});

test('a 401 names the Basic scheme so the browser prompts', async () => {
  const res = await fetch(`${origin}/`);
  assert.match(res.headers.get('www-authenticate') || '', /^Basic realm=/);
});

test('writes are closed too', async () => {
  const post = async (path, body) =>
    (await fetch(`${origin}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })).status;
  assert.equal(await post('/api/fetch', {}), 401);
  assert.equal(await post('/api/notifications/read', { ids: [] }), 401);
  assert.equal(await post('/api/push/subscribe', { subscription: { endpoint: 'x' } }), 401);

  const put = await fetch(`${origin}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ intervalMinutes: 1 }),
  });
  assert.equal(put.status, 401, 'a stranger could change the fetch interval');
});

test('the right credentials get through', async () => {
  const res = await fetch(`${origin}/api/status`, { headers: { Authorization: good } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.settings.intervalMinutes, 'number');

  const page = await fetch(`${origin}/`, { headers: { Authorization: good } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Exam Notice Radar/);
});

test('a wrong password, user or malformed header is rejected', async () => {
  const attempts = [
    basic('mansha', 'wrong'),
    basic('admin', 'correct-horse-battery-staple'),
    basic('mansha', ''),
    basic('mansha', 'correct-horse-battery-stapl'), // one char short
    basic('mansha', 'correct-horse-battery-staplex'), // one char long
    'Basic not-valid-base64!!',
    'Bearer correct-horse-battery-staple',
    'Basic ',
    '',
  ];
  for (const header of attempts) {
    const res = await fetch(`${origin}/api/status`, {
      headers: header ? { Authorization: header } : {},
    });
    assert.equal(res.status, 401, `accepted: ${JSON.stringify(header)}`);
  }
});

test('a password containing a colon still works', async () => {
  // The header splits on the FIRST colon, so the password may contain more.
  const res = await fetch(`${origin}/api/status`, {
    headers: { Authorization: basic('mansha', 'correct-horse-battery-staple') },
  });
  assert.equal(res.status, 200);
  // And a password that is only a prefix of the real one must fail.
  const prefix = await fetch(`${origin}/api/status`, {
    headers: { Authorization: basic('mansha', 'correct') },
  });
  assert.equal(prefix.status, 401);
});

test('the health check stays open so platforms can probe it', async () => {
  const res = await fetch(`${origin}/api/health`);
  assert.equal(res.status, 200, 'a gated health check breaks deploy probes');
  assert.equal((await res.json()).ok, true);
});

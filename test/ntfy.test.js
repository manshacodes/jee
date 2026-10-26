import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';

/**
 * Exercised against a local stand-in for ntfy.sh, so the tests assert the
 * exact request the real service would receive without sending anything.
 */
let server;
let received;
let origin;
let notifyNtfy;
let isConfigured;

beforeEach(async () => {
  received = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ url: req.url, headers: req.headers, body });
      if (req.url.includes('boom')) {
        res.writeHead(500).end('nope');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  process.env.NTFY_SERVER = origin;
  ({ notifyNtfy, isConfigured } = await import(`../server/notify-ntfy.js?t=${Date.now()}`));
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.NTFY_TOPIC;
  delete process.env.NTFY_SERVER;
  delete process.env.NTFY_TOKEN;
});

const notice = (over = {}) => ({
  title: 'JEE (Main) 2027 Session 1 application form is live',
  url: 'https://jeemain.nta.nic.in/a.pdf',
  categories: ['jee'],
  ...over,
});

test('nothing is sent when no topic is configured', async () => {
  const result = await notifyNtfy([notice()]);
  assert.equal(result.sent, false);
  assert.match(result.reason, /NTFY_TOPIC/);
  assert.equal(received.length, 0);
  assert.equal(isConfigured(), false);
});

test('a single notice posts to the topic with its title and link', async () => {
  process.env.NTFY_TOPIC = 'my-secret-topic';
  const result = await notifyNtfy([notice()], { siteUrl: 'https://example.github.io/jee/' });
  assert.equal(result.sent, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/my-secret-topic');
  assert.match(received[0].body, /JEE \(Main\) 2027 Session 1/);
  // A lone notice should deep-link to the document itself.
  assert.equal(received[0].headers.click, 'https://jeemain.nta.nic.in/a.pdf');
  assert.match(received[0].headers.title, /jee/i);
});

test('a batch summarises and links to the site instead', async () => {
  process.env.NTFY_TOPIC = 't';
  await notifyNtfy([notice(), notice({ title: 'Second' }), notice({ title: 'Third' })], {
    siteUrl: 'https://example.github.io/jee/',
  });
  assert.match(received[0].headers.title, /\b3\b/);
  assert.equal(received[0].headers.click, 'https://example.github.io/jee/');
  assert.match(received[0].body, /Second/);
  assert.match(received[0].body, /Third/);
});

test('a long batch is truncated rather than sent whole', async () => {
  process.env.NTFY_TOPIC = 't';
  const many = Array.from({ length: 20 }, (_, i) => notice({ title: `Notice number ${i}` }));
  await notifyNtfy(many, {});
  assert.match(received[0].body, /and 12 more/);
  assert.ok(received[0].body.split('\n').length <= 10);
});

test('non-ASCII titles do not break the header', async () => {
  process.env.NTFY_TOPIC = 't';
  // ntfy headers are Latin-1; these characters appear in real notice titles.
  const res = await notifyNtfy([notice({ title: 'Result – Class XII ‘special’ — reg.' })], {});
  assert.equal(res.sent, true);
  const title = received[0].headers.title;
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x20-\x7E]*$/.test(title), `non-ASCII survived into the header: ${title}`);
});

test('a bearer token is sent for protected topics', async () => {
  process.env.NTFY_TOPIC = 't';
  process.env.NTFY_TOKEN = 'tk_secret';
  await notifyNtfy([notice()], {});
  assert.equal(received[0].headers.authorization, 'Bearer tk_secret');
});

test('an empty batch sends nothing', async () => {
  process.env.NTFY_TOPIC = 't';
  const result = await notifyNtfy([], {});
  assert.equal(result.sent, false);
  assert.equal(received.length, 0);
});

test('a server error is reported, not thrown', async () => {
  process.env.NTFY_TOPIC = 'boom';
  const result = await notifyNtfy([notice()], {});
  assert.equal(result.sent, false);
  assert.equal(result.status, 500);
});

test('an unreachable server never throws', async () => {
  process.env.NTFY_TOPIC = 't';
  process.env.NTFY_SERVER = 'http://127.0.0.1:1';
  const fresh = await import(`../server/notify-ntfy.js?t=${Date.now()}x`);
  const result = await fresh.notifyNtfy([notice()], {});
  assert.equal(result.sent, false, 'a failed alert must not fail the scrape');
  assert.ok(result.reason);
});

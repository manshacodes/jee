import { strict as assert } from 'node:assert';
import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, test } from 'node:test';

/**
 * Covers the decision logic and the subscription parsing. The network send is
 * stubbed, so nothing is dispatched to a real push service.
 */
let notifyWebPush;
let parseSubscriptions;
let isConfigured;
let webpush;
let realSend;
let sends;

/** A subscription shaped the way a browser actually produces one. */
function fakeSubscription(id) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
}

const notice = (over = {}) => ({
  title: 'JEE (Main) 2027 Session 1 application form',
  url: 'https://jeemain.nta.nic.in/a.pdf',
  categories: ['jee'],
  ...over,
});

beforeEach(async () => {
  sends = [];
  // A real pair, so setVapidDetails does not reject it.
  process.env.VAPID_PUBLIC_KEY =
    'BCn9KB1hNd1dOnFRCGeek5bDXg0OzffKSSixgKj3_kvtwU_kL2Elp1E9bHfh3bqGZR3JvJssZiqTpX0tADkr5_c';
  process.env.VAPID_PRIVATE_KEY = 'WI1mKcpqTBLcF63fjCp0RhuPIBNpWWr_Kcn5kL5MDQ0';
  process.env.VAPID_SUBJECT = 'mailto:test@example.com';

  const mod = await import(`../server/notify-webpush.js?t=${Date.now()}${Math.random()}`);
  ({ notifyWebPush, parseSubscriptions, isConfigured } = mod);
  webpush = (await import('web-push')).default;
  if (!realSend) realSend = webpush.sendNotification;
  webpush.sendNotification = async (sub, payload) => {
    sends.push({ sub, payload });
    return { statusCode: 201 };
  };
});

afterEach(() => {
  webpush.sendNotification = realSend;
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  delete process.env.PUSH_SUBSCRIPTIONS;
});

test('the keys a browser generates are accepted by the sender', async () => {
  // These are the exact lengths Web Crypto produces for a P-256 pair, and the
  // whole design depends on web-push accepting them.
  assert.equal(process.env.VAPID_PUBLIC_KEY.length, 87);
  assert.equal(process.env.VAPID_PRIVATE_KEY.length, 43);
  process.env.PUSH_SUBSCRIPTIONS = JSON.stringify([fakeSubscription('a')]);
  const result = await notifyWebPush([notice()], {});
  assert.equal(result.sent, 1);
});

test('one subscription object is accepted as well as an array', () => {
  const one = fakeSubscription('a');
  assert.equal(parseSubscriptions(JSON.stringify(one)).length, 1);
  assert.equal(parseSubscriptions(JSON.stringify([one, fakeSubscription('b')])).length, 2);
  assert.deepEqual(parseSubscriptions(''), []);
  assert.deepEqual(parseSubscriptions(undefined), []);
});

test('a malformed secret is reported clearly, not crashed on', async () => {
  assert.throws(() => parseSubscriptions('{not json'), /not valid JSON/);
  assert.throws(() => parseSubscriptions('[{"endpoint":"x"}]'), /no endpoint or keys/);

  process.env.PUSH_SUBSCRIPTIONS = '{not json';
  const result = await notifyWebPush([notice()], {});
  assert.equal(result.sent, 0);
  assert.match(result.reason, /not valid JSON/);
});

test('every registered device is notified', async () => {
  process.env.PUSH_SUBSCRIPTIONS = JSON.stringify([
    fakeSubscription('laptop'),
    fakeSubscription('phone'),
  ]);
  const result = await notifyWebPush([notice()], {});
  assert.equal(result.sent, 2);
  assert.equal(sends.length, 2);
});

test('a single notice shows its own title and opens the document', async () => {
  process.env.PUSH_SUBSCRIPTIONS = JSON.stringify([fakeSubscription('a')]);
  await notifyWebPush([notice()], { siteUrl: 'https://me.github.io/jee/' });
  const payload = JSON.parse(sends[0].payload);
  assert.match(payload.title, /JEE/);
  assert.match(payload.body, /JEE \(Main\) 2027/);
  assert.equal(payload.url, 'https://jeemain.nta.nic.in/a.pdf');
});

test('a batch is summarised and opens the site', async () => {
  process.env.PUSH_SUBSCRIPTIONS = JSON.stringify([fakeSubscription('a')]);
  await notifyWebPush(
    [notice(), notice({ categories: ['class10', 'class12'] }), notice({ title: 'Third' })],
    { siteUrl: 'https://me.github.io/jee/' }
  );
  const payload = JSON.parse(sends[0].payload);
  assert.match(payload.title, /\b3\b/);
  for (const stream of ['JEE', 'Class 10', 'Class 12']) {
    assert.match(payload.title, new RegExp(stream));
  }
  assert.equal(payload.url, 'https://me.github.io/jee/');
  assert.equal(payload.count, 3);
});

test('a device the browser dropped is reported as expired, not as a failure', async () => {
  process.env.PUSH_SUBSCRIPTIONS = JSON.stringify([
    fakeSubscription('dead'),
    fakeSubscription('live'),
  ]);
  webpush.sendNotification = async (sub) => {
    if (sub.endpoint.endsWith('dead')) {
      const err = new Error('Gone');
      err.statusCode = 410;
      throw err;
    }
    return { statusCode: 201 };
  };
  const result = await notifyWebPush([notice()], {});
  assert.equal(result.sent, 1);
  assert.equal(result.gone.length, 1);
  assert.equal(result.failed, 0);
});

test('a transient failure is counted but not treated as expiry', async () => {
  process.env.PUSH_SUBSCRIPTIONS = JSON.stringify([fakeSubscription('a')]);
  webpush.sendNotification = async () => {
    const err = new Error('Service Unavailable');
    err.statusCode = 503;
    throw err;
  };
  const result = await notifyWebPush([notice()], {});
  assert.equal(result.failed, 1);
  assert.equal(result.gone.length, 0);
});

test('nothing is attempted when the secrets are missing', async () => {
  delete process.env.VAPID_PRIVATE_KEY;
  const fresh = await import(`../server/notify-webpush.js?t=${Date.now()}q`);
  assert.equal(fresh.isConfigured(), false);
  const result = await fresh.notifyWebPush([notice()], {});
  assert.equal(result.sent, 0);
  assert.match(result.reason, /not set/);
  assert.equal(sends.length, 0);
});

test('an empty batch sends nothing', async () => {
  process.env.PUSH_SUBSCRIPTIONS = JSON.stringify([fakeSubscription('a')]);
  const result = await notifyWebPush([], {});
  assert.equal(result.sent, 0);
  assert.equal(sends.length, 0);
});

test('isConfigured needs all three values', async () => {
  process.env.PUSH_SUBSCRIPTIONS = JSON.stringify([fakeSubscription('a')]);
  const withAll = await import(`../server/notify-webpush.js?t=${Date.now()}r`);
  assert.equal(withAll.isConfigured(), true);
});

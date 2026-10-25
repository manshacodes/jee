import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';

/**
 * push-setup.js runs in the browser, but the parts that matter -- merging a
 * second device into the existing list, and producing a key pair in exactly
 * the form the sender expects -- are plain functions, so they are tested here
 * against the real module.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const MODULE = join(HERE, '..', 'public', 'js', 'push-setup.js');

// The module only touches `window`/`navigator` inside functions we do not call.
globalThis.crypto ??= webcrypto;
globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64');
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary');

const { generateVapidKeys, mergeSubscriptions, urlBase64ToUint8Array } = await import(
  `file://${MODULE}`
);

const device = (id) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
  keys: { p256dh: `pub-${id}`, auth: `auth-${id}` },
});

test('a generated key pair has the shape the push sender needs', async () => {
  const keys = await generateVapidKeys();
  // 65 raw bytes (uncompressed P-256 point) and 32 bytes, base64url encoded.
  assert.equal(keys.publicKey.length, 87);
  assert.equal(keys.privateKey.length, 43);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(keys.publicKey), 'public key is not base64url');
  assert.ok(/^[A-Za-z0-9_-]+$/.test(keys.privateKey), 'private key is not base64url');
  // The first byte of an uncompressed point is 0x04.
  assert.equal(urlBase64ToUint8Array(keys.publicKey)[0], 0x04);
  assert.equal(urlBase64ToUint8Array(keys.publicKey).length, 65);
});

test('each run produces a different pair', async () => {
  const [a, b] = await Promise.all([generateVapidKeys(), generateVapidKeys()]);
  assert.notEqual(a.publicKey, b.publicKey);
});

test('the first device becomes a one-item list', () => {
  const merged = mergeSubscriptions(null, device('laptop'));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].endpoint, 'https://fcm.googleapis.com/fcm/send/laptop');
});

test('a second device is added, not substituted', () => {
  // This is the bug that would silently stop the laptop being notified.
  const first = JSON.stringify([device('laptop')]);
  const merged = mergeSubscriptions(first, device('phone'));
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((s) => s.endpoint).sort(), [
    'https://fcm.googleapis.com/fcm/send/laptop',
    'https://fcm.googleapis.com/fcm/send/phone',
  ]);
});

test('re-running setup on the same device does not duplicate it', () => {
  const existing = JSON.stringify([device('laptop'), device('phone')]);
  const merged = mergeSubscriptions(existing, device('phone'));
  assert.equal(merged.length, 2);
  assert.equal(merged.filter((s) => s.endpoint.endsWith('phone')).length, 1);
});

test('a stored single object is upgraded to a list', () => {
  const merged = mergeSubscriptions(JSON.stringify(device('laptop')), device('phone'));
  assert.equal(merged.length, 2);
});

test('corrupt stored state does not lose the device being added', () => {
  const merged = mergeSubscriptions('{{ not json', device('phone'));
  assert.equal(merged.length, 1);
  assert.equal(merged[0].endpoint, 'https://fcm.googleapis.com/fcm/send/phone');
});

test('the generated public key round-trips through the subscribe encoding', async () => {
  const keys = await generateVapidKeys();
  const bytes = urlBase64ToUint8Array(keys.publicKey);
  const back = Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(back, keys.publicKey);
});

test('the page offers the setup rather than silently doing nothing', async () => {
  // The dialog and its three steps have to exist for the flow to be reachable.
  const html = await readFile(join(HERE, '..', 'public', 'index.html'), 'utf8');
  for (const id of ['pushSetup', 'pushSubscribe', 'stepCopy', 'stepDone', 'secretList']) {
    assert.ok(html.includes(`id="${id}"`), `index.html is missing #${id}`);
  }
});

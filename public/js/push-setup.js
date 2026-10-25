/**
 * Setting up browser push on a site with no server.
 *
 * Normally a server holds the VAPID key pair and each device's subscription.
 * Here there is neither, so this does the whole dance in the browser and hands
 * the user three values to paste into their repository's Actions secrets,
 * which stay private even on a public repo.
 *
 * The VAPID key pair is generated with Web Crypto rather than a build step, so
 * nothing has to be installed locally. The first device generates the pair;
 * later devices reuse the published public key, because one private key has to
 * be able to sign for every device.
 */

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/** A VAPID key pair in the base64url form the web-push library expects. */
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64url(raw), privateKey: jwk.d };
}

/**
 * A VAPID public key is 65 raw bytes starting with 0x04 (an uncompressed P-256
 * point). Anything else -- a truncated paste, stale localStorage from an older
 * build -- would otherwise surface as a cryptic atob() failure deep inside
 * subscribe, so it is checked up front and treated as "no key".
 */
export function isValidVapidPublicKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key)) return false;
  try {
    const bytes = urlBase64ToUint8Array(key);
    return bytes.length === 65 && bytes[0] === 0x04;
  } catch {
    return false;
  }
}

export function pushSupported() {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  );
}

/** iOS only allows push once the site is installed to the home screen. */
export function iosNeedsInstall() {
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
  const installed =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  return isIos && !installed;
}

/**
 * Register the worker, ask permission, and subscribe.
 * @param {string} publicKey  VAPID public key, base64url
 * @returns {Promise<object>} the subscription, as the push sender needs it
 */
export async function subscribeDevice(publicKey) {
  const registration =
    (await navigator.serviceWorker.getRegistration()) ||
    (await navigator.serviceWorker.register('./sw.js'));
  await navigator.serviceWorker.ready;

  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    // A subscription made with a different key cannot be signed for, so start
    // again rather than hand back one that will never deliver.
    const current = existing.options?.applicationServerKey;
    const sameKey = current && b64url(current) === publicKey;
    if (sameKey) return existing.toJSON();
    await existing.unsubscribe();
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    const err = new Error('Notifications were not allowed for this site.');
    err.code = 'denied';
    throw err;
  }

  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  return subscription.toJSON();
}

/**
 * Merge a new device into whatever the user already has in the secret, so
 * adding a second device does not silently replace the first.
 */
export function mergeSubscriptions(existingRaw, subscription) {
  let existing = [];
  if (existingRaw && existingRaw.trim()) {
    try {
      const parsed = JSON.parse(existingRaw);
      existing = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      existing = [];
    }
  }
  const deduped = existing.filter((s) => s?.endpoint && s.endpoint !== subscription.endpoint);
  return [...deduped, subscription];
}

import webpush from 'web-push';
import { addSubscription, getSettings, getSubscriptions, getVapid, removeSubscriptions, saveVapid } from './store.js';

/**
 * Web Push gives the user desktop and mobile alerts even when the tab is
 * closed. VAPID keys are generated once and persisted, so existing browser
 * subscriptions keep working across restarts.
 */

let publicKey = null;

export async function initPush() {
  let keys = await getVapid();
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
  } else if (!keys) {
    keys = webpush.generateVAPIDKeys();
    await saveVapid(keys);
    console.log('[push] generated new VAPID key pair -> data/vapid.json');
  }

  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey);
  publicKey = keys.publicKey;
  return publicKey;
}

export const getPublicKey = () => publicKey;

export async function subscribe(subscription) {
  if (!subscription || !subscription.endpoint) throw new Error('Invalid subscription');
  return addSubscription(subscription);
}

export async function unsubscribe(endpoint) {
  return removeSubscriptions([endpoint]);
}

/**
 * Notify every registered device about new notices.
 * Subscriptions the push service rejects as gone (404/410) are pruned.
 */
export async function broadcastNewNotices(notices) {
  if (!notices.length || !publicKey) return { sent: 0, pruned: 0 };

  const settings = await getSettings();
  if (!settings.pushEnabled) return { sent: 0, pruned: 0, skipped: 'push disabled' };

  const wanted = settings.pushCategories || [];
  const relevant = wanted.length
    ? notices.filter((n) => n.categories.some((c) => wanted.includes(c)))
    : notices;
  if (!relevant.length) return { sent: 0, pruned: 0, skipped: 'no matching categories' };

  const headline =
    relevant.length === 1
      ? relevant[0].title
      : `${relevant.length} new drops from CBSE / NTA`;

  const payload = JSON.stringify({
    title: relevant.length === 1 ? `${relevant[0].sourceLabel} just dropped` : 'lurk :p',
    body: headline.slice(0, 240),
    tag: 'lurk',
    url: relevant.length === 1 ? relevant[0].url : '/',
    count: relevant.length,
    categories: [...new Set(relevant.flatMap((n) => n.categories))],
  });

  const subscriptions = await getSubscriptions();
  const dead = [];
  let sent = 0;

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
        sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) dead.push(sub.endpoint);
        else console.error(`[push] send failed (${err.statusCode || '?'}): ${err.message}`);
      }
    })
  );

  if (dead.length) await removeSubscriptions(dead);
  return { sent, pruned: dead.length };
}

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || join(HERE, '..', 'data');

const NOTICES = () => join(DATA_DIR, 'notifications.json');
const SETTINGS = () => join(DATA_DIR, 'settings.json');
const SUBS = () => join(DATA_DIR, 'subscriptions.json');
const VAPID = () => join(DATA_DIR, 'vapid.json');

/** Hard cap so the JSON file cannot grow without bound. */
const MAX_NOTICES = 5000;

export const DEFAULT_SETTINGS = {
  autoFetch: true,
  intervalMinutes: 30,
  pushEnabled: true,
  // Only push for these categories; empty array means "all".
  pushCategories: [],
  theme: 'system', // 'system' | 'light' | 'dark'
};

/** Minutes the UI offers; the API accepts any integer in [1, 1440]. */
export const INTERVAL_CHOICES = [5, 10, 15, 30, 60, 120, 360, 720, 1440];

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // A truncated or hand-edited file should not take the server down.
    console.error(`[store] ${file} is unreadable (${err.message}); using defaults`);
    return fallback;
  }
}

/**
 * Write via a temp file + rename so a crash mid-write cannot leave a
 * half-written store behind.
 */
async function writeJson(file, value) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

// Serialise writes so concurrent manual + scheduled fetches cannot interleave
// read-modify-write cycles and lose notices.
let queue = Promise.resolve();
function exclusive(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Stable id: the same notice keeps its id across fetches and restarts. */
export function noticeId({ sourceId, url, title }) {
  return createHash('sha1').update(`${sourceId}|${url}|${title}`).digest('hex').slice(0, 16);
}

export async function getNotices() {
  const data = await readJson(NOTICES(), { notices: [] });
  return Array.isArray(data.notices) ? data.notices : [];
}

export async function getSettings() {
  const stored = await readJson(SETTINGS(), {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(patch) {
  return exclusive(async () => {
    const current = { ...DEFAULT_SETTINGS, ...(await readJson(SETTINGS(), {})) };
    const next = { ...current, ...patch };
    await writeJson(SETTINGS(), next);
    return next;
  });
}

/**
 * Merge freshly scraped notices into the store.
 *
 * Existing notices are never dropped -- the user asked to keep reading older
 * ones -- and we only report the genuinely new ones so pushes stay quiet after
 * the first run.
 *
 * @returns {Promise<{added:object[], total:number}>}
 */
export async function mergeNotices(scraped) {
  return exclusive(async () => {
    const existing = await getNotices();
    const byId = new Map(existing.map((n) => [n.id, n]));
    const firstRun = existing.length === 0;
    const added = [];
    const now = new Date().toISOString();

    for (const item of scraped) {
      const id = noticeId(item);
      const prior = byId.get(id);
      if (prior) {
        // Keep the earliest firstSeenAt, but let a later run fill in a date or
        // section we could not determine the first time. A real date always
        // wins over one we inferred from list position.
        if (!prior.publishedAt || (prior.dateInferred && item.publishedAt && !item.dateInferred)) {
          prior.publishedAt = item.publishedAt || prior.publishedAt || null;
          prior.dateInferred = Boolean(item.dateInferred);
        }
        prior.section = prior.section || item.section || null;
        prior.categories = item.categories;
        prior.lastSeenAt = now;
        continue;
      }
      const notice = {
        id,
        title: item.title,
        url: item.url,
        sourceId: item.sourceId,
        sourceLabel: item.sourceLabel,
        section: item.section || null,
        categories: item.categories,
        publishedAt: item.publishedAt || null,
        dateInferred: Boolean(item.dateInferred),
        firstSeenAt: now,
        lastSeenAt: now,
        // On a cold start everything is "new", which would mean a notification
        // storm, so the first ingest is marked as already-read history.
        isNew: !firstRun,
      };
      byId.set(id, notice);
      if (!firstRun) added.push(notice);
    }

    const all = sortNotices([...byId.values()]).slice(0, MAX_NOTICES);
    await writeJson(NOTICES(), { updatedAt: now, notices: all });
    return { added, total: all.length, firstRun };
  });
}

/**
 * Newest first.
 *
 * With `pinNew` (the default, used by the server) everything discovered on the
 * latest run sits above the back catalogue, so new notices are noticed.
 *
 * The static build passes `pinNew: false`. There, "unread" is per-device and
 * recomputed in the browser from a localStorage watermark, so a server-side
 * isNew flag means nothing to the reader -- but baking it into the order still
 * reordered the feed. When a long-failing source finally came back, five
 * notices from the 16th were marked new and pinned above the 24th's, which is
 * simply the wrong order for anyone reading it.
 *
 * Within a group we order by publication date (inferred from list position
 * when the board did not publish one), falling back to discovery time.
 */
export function sortNotices(list, { pinNew = true } = {}) {
  return list.sort((a, b) => {
    if (pinNew && a.isNew !== b.isNew) return a.isNew ? -1 : 1;
    const ak = a.publishedAt || a.firstSeenAt;
    const bk = b.publishedAt || b.firstSeenAt;
    if (ak !== bk) return ak < bk ? 1 : -1;
    // Same day: the more recently discovered notice is the more interesting.
    if (a.firstSeenAt !== b.firstSeenAt) return a.firstSeenAt < b.firstSeenAt ? 1 : -1;
    return a.title.localeCompare(b.title);
  });
}

/** Clear the "new" flag on some or all notices. */
export async function markRead(ids) {
  return exclusive(async () => {
    const all = await getNotices();
    const target = ids && ids.length ? new Set(ids) : null;
    let changed = 0;
    for (const n of all) {
      if (n.isNew && (!target || target.has(n.id))) {
        n.isNew = false;
        changed += 1;
      }
    }
    if (changed) await writeJson(NOTICES(), { updatedAt: new Date().toISOString(), notices: all });
    return changed;
  });
}

// --- push subscriptions ----------------------------------------------------

export async function getSubscriptions() {
  const data = await readJson(SUBS(), { subscriptions: [] });
  return Array.isArray(data.subscriptions) ? data.subscriptions : [];
}

export async function addSubscription(subscription) {
  return exclusive(async () => {
    const all = await getSubscriptions();
    if (!all.some((s) => s.endpoint === subscription.endpoint)) {
      all.push(subscription);
      await writeJson(SUBS(), { subscriptions: all });
    }
    return all.length;
  });
}

export async function removeSubscriptions(endpoints) {
  return exclusive(async () => {
    const drop = new Set(endpoints);
    const all = (await getSubscriptions()).filter((s) => !drop.has(s.endpoint));
    await writeJson(SUBS(), { subscriptions: all });
    return all.length;
  });
}

export async function getVapid() {
  return readJson(VAPID(), null);
}

export async function saveVapid(keys) {
  await writeJson(VAPID(), keys);
  return keys;
}

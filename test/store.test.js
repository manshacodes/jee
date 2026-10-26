import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

/**
 * The store reads DATA_DIR at import time, so each test file gets its own
 * temp directory and the module is imported fresh via a cache-busting query.
 */
let dir;
let store;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'notice-store-'));
  process.env.DATA_DIR = dir;
  store = await import(`../server/store.js?t=${Date.now()}${Math.random()}`);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const notice = (over = {}) => ({
  title: 'Public Notice for JEE (Main) 2027',
  url: 'https://jeemain.nta.nic.in/a.pdf',
  sourceId: 'nta-jee',
  sourceLabel: 'NTA — JEE (Main)',
  categories: ['jee'],
  publishedAt: '2026-10-24',
  ...over,
});

test('the first ingest is stored as history and reports nothing new', async () => {
  const { added, total, firstRun } = await store.mergeNotices([notice(), notice({ title: 'Second', url: 'https://x/b.pdf' })]);
  assert.equal(firstRun, true);
  assert.deepEqual(added, [], 'a cold start must not fire notifications for the whole back catalogue');
  assert.equal(total, 2);
  const all = await store.getNotices();
  assert.ok(all.every((n) => n.isNew === false));
});

test('a later ingest reports only the genuinely new notices', async () => {
  await store.mergeNotices([notice()]);
  const { added, total } = await store.mergeNotices([
    notice(),
    notice({ title: 'Brand new notice', url: 'https://x/new.pdf' }),
  ]);
  assert.equal(total, 2);
  assert.equal(added.length, 1);
  assert.equal(added[0].title, 'Brand new notice');
  assert.equal(added[0].isNew, true);
});

test('previously scraped notices are never dropped', async () => {
  await store.mergeNotices([notice(), notice({ title: 'Older', url: 'https://x/old.pdf' })]);
  // The board rotates the old notice off its listing page.
  await store.mergeNotices([notice()]);
  const titles = (await store.getNotices()).map((n) => n.title);
  assert.ok(titles.includes('Older'), 'a notice that fell off the source page was lost');
});

test('ids are stable across runs', async () => {
  await store.mergeNotices([notice()]);
  const first = (await store.getNotices())[0].id;
  await store.mergeNotices([notice()]);
  const all = await store.getNotices();
  assert.equal(all.length, 1);
  assert.equal(all[0].id, first);
});

test('a real date replaces one that was inferred from list position', async () => {
  await store.mergeNotices([notice({ publishedAt: '2026-10-01', dateInferred: true })]);
  await store.mergeNotices([notice({ publishedAt: '2026-10-24', dateInferred: false })]);
  const [only] = await store.getNotices();
  assert.equal(only.publishedAt, '2026-10-24');
  assert.equal(only.dateInferred, false);
});

test('an inferred date never overwrites a published one', async () => {
  await store.mergeNotices([notice({ publishedAt: '2026-10-24', dateInferred: false })]);
  await store.mergeNotices([notice({ publishedAt: '2026-01-01', dateInferred: true })]);
  const [only] = await store.getNotices();
  assert.equal(only.publishedAt, '2026-10-24');
});

test('newly discovered notices sort above the back catalogue', async () => {
  await store.mergeNotices([notice({ title: 'Recent', url: 'https://x/1.pdf', publishedAt: '2026-10-24' })]);
  await store.mergeNotices([
    notice({ title: 'Recent', url: 'https://x/1.pdf', publishedAt: '2026-10-24' }),
    notice({ title: 'Just found, but older', url: 'https://x/2.pdf', publishedAt: '2026-02-01' }),
  ]);
  const sorted = store.sortNotices(await store.getNotices());
  assert.equal(sorted[0].title, 'Just found, but older');
  assert.equal(sorted[1].title, 'Recent');
});

test('within a group, notices sort newest-published first', async () => {
  await store.mergeNotices([
    notice({ title: 'Oldest', url: 'https://x/1.pdf', publishedAt: '2026-01-01' }),
    notice({ title: 'Newest', url: 'https://x/2.pdf', publishedAt: '2026-10-24' }),
    notice({ title: 'Middle', url: 'https://x/3.pdf', publishedAt: '2026-06-01' }),
  ]);
  const sorted = store.sortNotices(await store.getNotices());
  assert.deepEqual(sorted.map((n) => n.title), ['Newest', 'Middle', 'Oldest']);
});

test('marking read clears the badges', async () => {
  await store.mergeNotices([notice()]);
  await store.mergeNotices([notice(), notice({ title: 'New one', url: 'https://x/n.pdf' })]);
  assert.equal((await store.getNotices()).filter((n) => n.isNew).length, 1);
  const changed = await store.markRead([]);
  assert.equal(changed, 1);
  assert.equal((await store.getNotices()).filter((n) => n.isNew).length, 0);
});

test('marking read accepts a subset of ids', async () => {
  await store.mergeNotices([notice()]);
  await store.mergeNotices([
    notice(),
    notice({ title: 'A', url: 'https://x/a.pdf' }),
    notice({ title: 'B', url: 'https://x/b.pdf' }),
  ]);
  const unread = (await store.getNotices()).filter((n) => n.isNew);
  assert.equal(unread.length, 2);
  await store.markRead([unread[0].id]);
  assert.equal((await store.getNotices()).filter((n) => n.isNew).length, 1);
});

test('settings round-trip and merge over the defaults', async () => {
  const defaults = await store.getSettings();
  assert.equal(defaults.intervalMinutes, store.DEFAULT_SETTINGS.intervalMinutes);
  await store.saveSettings({ intervalMinutes: 5, autoFetch: false });
  const saved = await store.getSettings();
  assert.equal(saved.intervalMinutes, 5);
  assert.equal(saved.autoFetch, false);
  // Untouched keys keep their defaults.
  assert.equal(saved.theme, store.DEFAULT_SETTINGS.theme);
});

test('concurrent merges do not lose notices', async () => {
  await store.mergeNotices([notice()]);
  await Promise.all([
    store.mergeNotices([notice({ title: 'P1', url: 'https://x/p1.pdf' })]),
    store.mergeNotices([notice({ title: 'P2', url: 'https://x/p2.pdf' })]),
    store.mergeNotices([notice({ title: 'P3', url: 'https://x/p3.pdf' })]),
  ]);
  const titles = (await store.getNotices()).map((n) => n.title);
  for (const t of ['P1', 'P2', 'P3']) assert.ok(titles.includes(t), `${t} was lost to a race`);
});

test('push subscriptions de-duplicate by endpoint', async () => {
  await store.addSubscription({ endpoint: 'https://push/1', keys: {} });
  await store.addSubscription({ endpoint: 'https://push/1', keys: {} });
  await store.addSubscription({ endpoint: 'https://push/2', keys: {} });
  assert.equal((await store.getSubscriptions()).length, 2);
  await store.removeSubscriptions(['https://push/1']);
  assert.deepEqual((await store.getSubscriptions()).map((s) => s.endpoint), ['https://push/2']);
});

test('a corrupt store file falls back to defaults instead of crashing', async () => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(dir, 'notifications.json'), '{ this is not json', 'utf8');
  assert.deepEqual(await store.getNotices(), []);
});

test('the static build orders purely by date, ignoring unread state', async () => {
  // The case this comes from: a long-failing source came back and its notices
  // were flagged new. Pinning them put notices from the 16th above the 24th's,
  // which is simply the wrong order for a reader.
  await store.mergeNotices([notice({ title: 'Recent', url: 'https://x/1.pdf', publishedAt: '2026-10-24' })]);
  await store.mergeNotices([
    notice({ title: 'Recent', url: 'https://x/1.pdf', publishedAt: '2026-10-24' }),
    notice({ title: 'Older but just discovered', url: 'https://x/2.pdf', publishedAt: '2026-10-16' }),
  ]);
  const all = await store.getNotices();

  const chronological = store.sortNotices([...all], { pinNew: false });
  assert.equal(chronological[0].title, 'Recent', 'an older notice was pinned above a newer one');

  // The server keeps pinning new ones, which is what makes them noticeable.
  const pinned = store.sortNotices([...all], { pinNew: true });
  assert.equal(pinned[0].title, 'Older but just discovered');
});

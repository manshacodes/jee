import express from 'express';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATEGORIES, CATEGORY_IDS } from './categorize.js';
import { SOURCES } from './sources/index.js';
import {
  DEFAULT_SETTINGS,
  INTERVAL_CHOICES,
  getNotices,
  getSettings,
  markRead,
  saveSettings,
  sortNotices,
} from './store.js';
import { getLastRun, isRunning, runIngest } from './ingest.js';
import { getPublicKey, initPush, subscribe, unsubscribe } from './push.js';
import { clampInterval, getNextRunAt, reschedule, setRunListener } from './scheduler.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(join(HERE, '..', 'public'), { extensions: ['html'] }));

// --- server-sent events: push fresh notices into open tabs -----------------

const clients = new Set();

function emit(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  clients.add(res);

  // Proxies drop idle connections; a comment frame every 25s keeps it warm.
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* cleaned up by the close handler */
    }
  }, 25000);
  keepAlive.unref?.();

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

setRunListener((result) => {
  emit('ingest', summariseRun(result));
  if (result?.addedNotices?.length) {
    emit('notices', { added: result.addedNotices });
  }
});

function summariseRun(result) {
  if (!result) return null;
  const { addedNotices, ...rest } = result;
  return rest;
}

// --- metadata --------------------------------------------------------------

app.get('/api/meta', async (_req, res) => {
  res.json({
    categories: CATEGORIES,
    sources: SOURCES.map((s) => ({ id: s.id, label: s.label, homepage: s.homepage })),
    intervalChoices: INTERVAL_CHOICES,
    defaults: DEFAULT_SETTINGS,
    vapidPublicKey: getPublicKey(),
  });
});

// --- notifications ---------------------------------------------------------

app.get('/api/notifications', async (req, res) => {
  const { category, source, q, since, onlyNew } = req.query;
  let list = sortNotices(await getNotices());

  if (category && category !== 'all') {
    if (!CATEGORY_IDS.includes(category)) {
      return res.status(400).json({ error: `Unknown category: ${category}` });
    }
    list = list.filter((n) => n.categories.includes(category));
  }
  if (source && source !== 'all') list = list.filter((n) => n.sourceId === source);
  if (onlyNew === 'true') list = list.filter((n) => n.isNew);
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((n) => n.title.toLowerCase().includes(needle));
  }
  if (since) {
    const cutoff = Date.parse(since);
    if (!Number.isNaN(cutoff)) {
      list = list.filter((n) => Date.parse(n.publishedAt || n.firstSeenAt) >= cutoff);
    }
  }

  const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  res.json({
    total: list.length,
    offset,
    limit,
    counts: await categoryCounts(),
    notifications: list.slice(offset, offset + limit),
  });
});

async function categoryCounts() {
  const all = await getNotices();
  const counts = { all: all.length, new: all.filter((n) => n.isNew).length };
  for (const id of CATEGORY_IDS) {
    const bucket = all.filter((n) => n.categories.includes(id));
    counts[id] = bucket.length;
    counts[`${id}:new`] = bucket.filter((n) => n.isNew).length;
  }
  return counts;
}

app.post('/api/notifications/read', async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const changed = await markRead(ids);
  emit('read', { ids, changed });
  res.json({ changed, counts: await categoryCounts() });
});

// --- fetching --------------------------------------------------------------

app.post('/api/fetch', async (req, res) => {
  const sourceIds = Array.isArray(req.body?.sourceIds) ? req.body.sourceIds : undefined;
  try {
    const result = await runIngest({ trigger: 'manual', sourceIds });
    emit('ingest', summariseRun(result));
    if (result.addedNotices.length) emit('notices', { added: result.addedNotices });
    res.json({ ...summariseRun(result), counts: await categoryCounts() });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/status', async (_req, res) => {
  res.json({
    running: isRunning(),
    lastRun: summariseRun(getLastRun()),
    nextRunAt: getNextRunAt(),
    settings: await getSettings(),
    counts: await categoryCounts(),
    pushSupported: Boolean(getPublicKey()),
  });
});

// --- settings --------------------------------------------------------------

app.get('/api/settings', async (_req, res) => {
  res.json(await getSettings());
});

app.put('/api/settings', async (req, res) => {
  const body = req.body || {};
  const patch = {};

  if ('autoFetch' in body) patch.autoFetch = Boolean(body.autoFetch);
  if ('pushEnabled' in body) patch.pushEnabled = Boolean(body.pushEnabled);
  if ('intervalMinutes' in body) {
    const n = Number(body.intervalMinutes);
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      return res.status(400).json({ error: 'intervalMinutes must be between 1 and 1440' });
    }
    patch.intervalMinutes = clampInterval(n);
  }
  if ('pushCategories' in body) {
    if (!Array.isArray(body.pushCategories)) {
      return res.status(400).json({ error: 'pushCategories must be an array' });
    }
    const unknown = body.pushCategories.filter((c) => !CATEGORY_IDS.includes(c));
    if (unknown.length) {
      return res.status(400).json({ error: `Unknown categories: ${unknown.join(', ')}` });
    }
    patch.pushCategories = body.pushCategories;
  }
  if ('theme' in body) {
    if (!['system', 'light', 'dark'].includes(body.theme)) {
      return res.status(400).json({ error: "theme must be 'system', 'light' or 'dark'" });
    }
    patch.theme = body.theme;
  }

  const settings = await saveSettings(patch);
  // Interval / auto-fetch changes must take effect without a restart.
  if ('autoFetch' in patch || 'intervalMinutes' in patch) await reschedule();
  emit('settings', settings);
  res.json({ ...settings, nextRunAt: getNextRunAt() });
});

// --- push subscriptions ----------------------------------------------------

app.post('/api/push/subscribe', async (req, res) => {
  try {
    const count = await subscribe(req.body?.subscription);
    res.json({ ok: true, devices: count });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/push/unsubscribe', async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint is required' });
  const count = await unsubscribe(endpoint);
  res.json({ ok: true, devices: count });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// --- boot ------------------------------------------------------------------

async function main() {
  await initPush();
  const server = app.listen(PORT, () => {
    console.log(`[server] Exam Notice Radar listening on http://localhost:${PORT}`);
  });

  // Seed the store on a cold start so the UI is never empty, then arm the timer.
  const { autoFetch } = await getSettings();
  const notices = await getNotices();
  if (notices.length === 0) {
    runIngest({ trigger: 'startup' })
      .then((result) => {
        emit('ingest', summariseRun(result));
        emit('notices', { added: result.addedNotices });
      })
      .catch((err) => console.error(`[server] startup fetch failed: ${err.message}`));
  }
  if (autoFetch) await reschedule();

  const shutdown = () => {
    console.log('\n[server] shutting down');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { app };

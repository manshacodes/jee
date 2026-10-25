/**
 * Exam Notice Radar -- front end.
 *
 * Keeps the feed in sync three ways: a full load on start / filter change, a
 * server-sent-events stream for notices discovered while the tab is open, and
 * a Web Push service worker for alerts when the tab is closed.
 */

import {
  generateVapidKeys,
  iosNeedsInstall,
  mergeSubscriptions,
  pushSupported,
  subscribeDevice,
} from './push-setup.js';

const $ = (sel) => document.querySelector(sel);

/**
 * Two deployment shapes share this file.
 *
 * Server mode talks to the Express API: it can scrape on demand, change the
 * schedule, and register Web Push.
 *
 * Static mode is what GitHub Pages serves. There is no backend, so the feed
 * comes from notices.json baked at build time by the scheduled scrape, and the
 * controls that need a server are disabled rather than hidden -- it should be
 * obvious why they are inert. Unread state is per-device, derived from a
 * high-water mark in localStorage instead of a server flag.
 */
const STATIC = Boolean(window.NOTICE_RADAR_STATIC);
const SEEN_KEY = 'lastSeenAt';

const state = {
  meta: null,
  settings: null,
  category: 'all',
  source: 'all',
  query: '',
  onlyNew: false,
  limit: 50,
  notices: [],
  total: 0,
  counts: {},
  pending: [], // arrived via SSE but held back until the user asks to see them
  pushSubscribed: false,
};

const PAGE = 50;

// ---------------------------------------------------------------- helpers

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body.error) message = body.error;
    } catch {
      /* keep the status line */
    }
    throw new Error(message);
  }
  return res.json();
}

/** All notices, loaded once in static mode and filtered client-side. */
let staticCache = null;

async function loadStaticFeed({ force = false } = {}) {
  if (staticCache && !force) return staticCache;
  const bust = force ? `?t=${Date.now()}` : '';
  const [notices, meta] = await Promise.all([
    fetch(`./notices.json${bust}`, { cache: force ? 'reload' : 'default' }).then((r) => {
      if (!r.ok) throw new Error(`Could not load the feed (${r.status})`);
      return r.json();
    }),
    fetch(`./meta.json${bust}`).then((r) => (r.ok ? r.json() : {})),
  ]);
  staticCache = { ...notices, meta };
  return staticCache;
}

/** A notice is "new" on this device if we had not seen the feed by then. */
function markUnread(notices) {
  let watermark = '';
  try {
    watermark = localStorage.getItem(SEEN_KEY) || '';
  } catch {
    /* private mode */
  }
  return notices.map((n) => ({
    ...n,
    isNew: Boolean(watermark) && (n.firstSeenAt || '') > watermark,
  }));
}

function rememberSeen(generatedAt) {
  try {
    const previous = localStorage.getItem(SEEN_KEY) || '';
    if (generatedAt > previous) localStorage.setItem(SEEN_KEY, generatedAt);
  } catch {
    /* private mode */
  }
}

function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`.trim();
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transition = 'opacity .2s';
    setTimeout(() => el.remove(), 220);
  }, 4200);
}

function relativeTime(iso) {
  if (!iso) return 'date not published';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 'date not published';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(then).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** "in 7 min" / "in 2 h" for a timestamp in the future. */
function untilTime(iso) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const secs = Math.round((then - Date.now()) / 1000);
  if (secs <= 0) return 'any moment now';
  if (secs < 60) return `in ${secs} s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}

function formatDate(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

const categoryLabel = (id) =>
  state.meta?.categories.find((c) => c.id === id)?.label || id;

// ---------------------------------------------------------------- theme

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // Mirrored to localStorage so the choice survives before settings load.
  try {
    localStorage.setItem('theme', theme);
  } catch {
    /* private mode */
  }
  $('#themeChoice')
    ?.querySelectorAll('button')
    .forEach((b) => b.setAttribute('aria-checked', String(b.dataset.theme === theme)));
}

function effectiveTheme() {
  const t = document.documentElement.dataset.theme;
  if (t !== 'system') return t;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// Restore before first paint-ish, so there is no light flash in dark mode.
try {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.dataset.theme = saved;
} catch {
  /* ignore */
}

// ---------------------------------------------------------------- rendering

function renderSidebar() {
  const counts = state.counts;

  const items = [
    { id: 'all', label: 'All notifications', icon: '∗', blurb: 'Every source' },
    ...state.meta.categories,
  ];

  $('#categoryNav').innerHTML = items
    .map((c) => {
      const total = counts[c.id] ?? 0;
      const unread = counts[`${c.id}:new`] ?? 0;
      const active = state.category === c.id;
      return `
        <li>
          <button class="nav-item" data-category="${c.id}" aria-current="${active}" title="${c.blurb}">
            <span class="tag" data-cat="${c.id}" aria-hidden="true">${c.icon}</span>
            <span class="label">${c.label}</span>
            ${unread ? `<span class="pip">${unread}</span>` : `<span class="count">${total}</span>`}
          </button>
        </li>`;
    })
    .join('');

  const sources = [{ id: 'all', label: 'All sources' }, ...state.meta.sources];
  $('#sourceNav').innerHTML = sources
    .map(
      (s) => `
        <li>
          <button class="nav-item" data-source="${s.id}" aria-current="${state.source === s.id}">
            <span class="label">${s.label}</span>
          </button>
        </li>`
    )
    .join('');
}

function noticeCard(n, justIn = false) {
  const chips = n.categories
    .map((c) => `<span class="chip" data-cat="${escapeHtml(c)}">${escapeHtml(categoryLabel(c))}</span>`)
    .join('');
  const published = formatDate(n.publishedAt);
  // The boards leave some rows undated; we place those by list position, so
  // say "around" rather than claiming a publication date they never gave.
  const dateText = published
    ? n.dateInferred
      ? `Around ${published}`
      : `Published ${published}`
    : `Seen ${relativeTime(n.firstSeenAt)}`;
  // Titles, URLs, sections and labels all come from scraped third-party pages,
  // so every one of them is escaped before it reaches the DOM.
  const meta = [n.sourceLabel, n.section, dateText]
    .filter(Boolean)
    .map(escapeHtml)
    .join('<span class="sep">·</span>');

  return `
    <li class="notice ${n.isNew ? 'is-new' : ''} ${justIn ? 'just-in' : ''}" data-id="${escapeHtml(n.id)}">
      <div class="notice-body">
        <h3 class="notice-title">
          <a href="${escapeHtml(safeUrl(n.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(n.title)}</a>
        </h3>
        <div class="notice-meta">
          ${chips}
          ${n.isNew ? '<span class="badge-new">New</span>' : ''}
          <span>${meta}</span>
        </div>
      </div>
      <div class="notice-side">
        <span class="count">${n.dateInferred ? '~' : ''}${relativeTime(n.publishedAt || n.firstSeenAt)}</span>
      </div>
    </li>`;
}

/**
 * Only ever emit an http(s) link. A scraped `javascript:` or `data:` URL would
 * otherwise run on click, and escaping alone does not stop that.
 */
function safeUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : '#';
  } catch {
    return '#';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function renderFeed() {
  const list = $('#noticeList');
  list.innerHTML = state.notices.map((n) => noticeCard(n)).join('');

  const empty = state.notices.length === 0;
  $('#emptyState').hidden = !empty;
  if (empty) {
    $('#emptyText').textContent = state.query
      ? `No notice title matches “${state.query}”.`
      : state.onlyNew
        ? 'No unread notices. New ones will appear here the moment they are published.'
        : 'Hit “Fetch now” to pull the latest notices from CBSE and NTA.';
  }

  $('#loadMore').hidden = state.notices.length >= state.total;

  const scope = state.category === 'all' ? 'All notifications' : categoryLabel(state.category);
  $('#feedTitle').textContent = scope;

  const bits = [`${state.total} notice${state.total === 1 ? '' : 's'}`];
  const unread = state.notices.filter((n) => n.isNew).length;
  if (unread) bits.push(`${unread} unread on this page`);
  if (state.source !== 'all') {
    bits.push(state.meta.sources.find((s) => s.id === state.source)?.label || state.source);
  }
  $('#feedSub').textContent = bits.join(' · ');
}

function renderPendingBanner() {
  const banner = $('#newBanner');
  if (!state.pending.length) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  $('#newBannerText').textContent =
    state.pending.length === 1
      ? '1 new notice just arrived'
      : `${state.pending.length} new notices just arrived`;
}

function renderStatus(status) {
  const pill = $('#statusPill');
  const text = $('#statusText');

  if (status.running) {
    pill.dataset.state = 'busy';
    text.textContent = 'Fetching…';
  } else {
    const failed = status.lastRun?.sources?.filter((s) => !s.ok) || [];
    pill.dataset.state = failed.length ? 'error' : 'live';
    text.textContent = failed.length
      ? `${failed.length} source${failed.length === 1 ? '' : 's'} failing`
      : status.settings.autoFetch
        ? 'Live'
        : 'Manual only';
  }

  $('#fetchNow').disabled = status.running;
  $('#fetchNow').classList.toggle('spinning', status.running);

  $('#lastRunText').textContent = status.lastRun
    ? `Last fetch ${relativeTime(status.lastRun.finishedAt)} · ${status.lastRun.added} new`
    : 'No fetch yet';

  $('#nextRunText').textContent = status.settings.autoFetch
    ? status.nextRunAt
      ? `Next automatic fetch ${untilTime(status.nextRunAt)}`
      : 'Scheduling…'
    : 'Automatic fetching is off';

  renderSourceHealth(status.lastRun);
  renderErrorBanner(status.lastRun);
}

function renderSourceHealth(lastRun) {
  const el = $('#sourceHealth');
  if (!lastRun?.sources) {
    el.innerHTML = '<li>No fetch yet.</li>';
    return;
  }
  el.innerHTML = lastRun.sources
    .map(
      (s) => `
      <li>
        <span class="state ${s.ok ? '' : 'bad'}" aria-hidden="true"></span>
        <span>${escapeHtml(s.label)}</span>
        <span class="n">${escapeHtml(String(s.count))}</span>
        ${s.errors.length ? `<p class="why">${escapeHtml(s.errors[0])}</p>` : ''}
      </li>`
    )
    .join('');
}

function renderErrorBanner(lastRun) {
  const banner = $('#errorBanner');
  const failed = lastRun?.sources?.filter((s) => !s.ok) || [];
  if (!failed.length) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.innerHTML =
    `<strong>${failed.length} source${failed.length === 1 ? '' : 's'} could not be read.</strong> ` +
    `Everything already collected is still shown below. ` +
    failed.map((s) => `<br><small>${escapeHtml(s.label)}: ${escapeHtml(s.errors[0] || 'unknown error')}</small>`).join('');
}

function renderSettings() {
  const s = state.settings;
  if (STATIC) return renderSettingsStatic();
  $('#autoFetch').checked = s.autoFetch;
  $('#pushEnabled').checked = s.pushEnabled;

  const select = $('#interval');
  const choices = state.meta.intervalChoices;
  const hasExact = choices.includes(s.intervalMinutes);
  select.innerHTML = [
    ...choices.map(
      (m) => `<option value="${m}" ${m === s.intervalMinutes ? 'selected' : ''}>${intervalText(m)}</option>`
    ),
    hasExact ? '' : `<option value="${s.intervalMinutes}" selected>${intervalText(s.intervalMinutes)}</option>`,
  ].join('');

  $('#intervalHint').textContent = s.autoFetch
    ? `The sites are checked ${intervalText(s.intervalMinutes).toLowerCase()}.`
    : 'Turn automatic fetching on to use this.';
  $('#interval').disabled = !s.autoFetch;
  $('#customInterval').disabled = !s.autoFetch;
  $('#customIntervalApply').disabled = !s.autoFetch;

  $('#pushCategories').innerHTML = state.meta.categories
    .map(
      (c) =>
        `<button class="chip-toggle" data-push-cat="${c.id}" aria-pressed="${s.pushCategories.includes(c.id)}">${c.label}</button>`
    )
    .join('');

  applyTheme(s.theme);
}

/**
 * Static builds keep the scheduling and alert controls visible but inert, with
 * a line saying where that job actually lives -- hiding them would just raise
 * the question of where the settings went.
 */
function renderSettingsStatic() {
  const s = state.settings;
  const workflow = staticCache?.meta?.workflowUrl;

  $('#autoFetch').checked = true;
  $('#autoFetch').disabled = true;
  $('#interval').disabled = true;
  $('#interval').innerHTML = '<option>Set in the GitHub Actions workflow</option>';
  $('#customInterval').disabled = true;
  $('#customIntervalApply').disabled = true;
  $('#intervalHint').innerHTML =
    'Scraping runs on a schedule in GitHub Actions, not in this page. ' +
    'Change the cron in <code>.github/workflows/scrape.yml</code>' +
    (workflow ? ` · <a href="${escapeHtml(workflow)}" target="_blank" rel="noopener">view runs</a>` : '') +
    '.';

  $('#pushEnabled').checked = false;
  $('#pushEnabled').disabled = true;
  $('#pushCategories').innerHTML =
    '<p class="hint">Alerts are sent by the scheduled job through ntfy. ' +
    'Subscribe to your topic in the ntfy app to receive them.</p>';

  applyTheme(s.theme);
}

function intervalText(m) {
  if (m < 60) return `Every ${m} minutes`;
  if (m === 60) return 'Every hour';
  if (m % 60 === 0) return `Every ${m / 60} hours`;
  return `Every ${m} minutes`;
}

// ---------------------------------------------------------------- data

async function loadNotices({ append = false, force = false } = {}) {
  if (STATIC) return loadNoticesStatic({ append, force });

  const params = new URLSearchParams({
    category: state.category,
    source: state.source,
    limit: String(append ? state.limit + PAGE : PAGE),
  });
  if (state.query) params.set('q', state.query);
  if (state.onlyNew) params.set('onlyNew', 'true');

  const data = await api(`/api/notifications?${params}`);
  state.limit = append ? state.limit + PAGE : PAGE;
  state.notices = data.notifications;
  state.total = data.total;
  state.counts = data.counts;
  renderFeed();
  renderSidebar();
}

/** The server-side filters, applied in the browser. */
async function loadNoticesStatic({ append = false, force = false } = {}) {
  const feed = await loadStaticFeed({ force });
  const all = markUnread(feed.notices);

  const filtered = all.filter((n) => {
    if (state.category !== 'all' && !n.categories.includes(state.category)) return false;
    if (state.source !== 'all' && n.sourceId !== state.source) return false;
    if (state.onlyNew && !n.isNew) return false;
    if (state.query && !n.title.toLowerCase().includes(state.query.toLowerCase())) return false;
    return true;
  });

  state.limit = append ? state.limit + PAGE : PAGE;
  state.notices = filtered.slice(0, state.limit);
  state.total = filtered.length;

  const counts = { all: all.length, new: all.filter((n) => n.isNew).length };
  for (const c of state.meta.categories) {
    const bucket = all.filter((n) => n.categories.includes(c.id));
    counts[c.id] = bucket.length;
    counts[`${c.id}:new`] = bucket.filter((n) => n.isNew).length;
  }
  state.counts = counts;

  renderFeed();
  renderSidebar();
}

async function refreshStatus() {
  if (STATIC) return refreshStatusStatic();
  const status = await api('/api/status');
  state.settings = status.settings;
  state.counts = status.counts;
  renderStatus(status);
  return status;
}

/** In static mode the "status" is just when the last scheduled scrape ran. */
async function refreshStatusStatic() {
  const feed = await loadStaticFeed();
  const generatedAt = feed.generatedAt;

  $('#statusPill').dataset.state = 'live';
  $('#statusText').textContent = `Updated ${relativeTime(generatedAt)}`;
  $('#fetchNow').disabled = false;
  $('#fetchNow').classList.remove('spinning');
  $('#fetchNow').querySelector('span:not(.btn-icon)').textContent = 'Reload';
  $('#fetchNow').title = 'Reload the feed. Scraping runs on a schedule in GitHub Actions.';

  $('#lastRunText').textContent = `Last scrape ${relativeTime(generatedAt)}`;
  $('#nextRunText').textContent = 'Scheduled by GitHub Actions';

  $('#errorBanner').hidden = true;
  const health = $('#sourceHealth');
  if (health) {
    health.innerHTML = (feed.meta?.sources || [])
      .map(
        (src) =>
          `<li><span class="state" aria-hidden="true"></span><span>${escapeHtml(src.label)}</span>` +
          `<span class="n">${feed.notices.filter((n) => n.sourceId === src.id).length}</span></li>`
      )
      .join('');
  }
  return { settings: state.settings };
}

// ---------------------------------------------------------------- actions

async function fetchNow() {
  if (STATIC) {
    const btn = $('#fetchNow');
    btn.classList.add('spinning');
    try {
      const before = staticCache?.generatedAt;
      await loadStaticFeed({ force: true });
      await loadNotices();
      await refreshStatus();
      toast(
        staticCache.generatedAt === before
          ? 'Already showing the latest scrape.'
          : 'Feed reloaded.',
        'good'
      );
    } catch (err) {
      toast(`Could not reload: ${err.message}`, 'bad');
    } finally {
      btn.classList.remove('spinning');
    }
    return;
  }

  const btn = $('#fetchNow');
  btn.disabled = true;
  btn.classList.add('spinning');
  $('#statusPill').dataset.state = 'busy';
  $('#statusText').textContent = 'Fetching…';
  try {
    const result = await api('/api/fetch', { method: 'POST' });
    // The SSE 'notices' event also fires; reloading here keeps the manual path
    // working even if the stream is not connected.
    state.pending = [];
    renderPendingBanner();
    await loadNotices();
    await refreshStatus();
    toast(
      result.added
        ? `${result.added} new notice${result.added === 1 ? '' : 's'} found.`
        : 'No new notices — everything is already up to date.',
      result.added ? 'good' : ''
    );
  } catch (err) {
    toast(`Fetch failed: ${err.message}`, 'bad');
    await refreshStatus().catch(() => {});
  }
}

async function saveSettings(patch) {
  if (STATIC) {
    // Theme is the only setting a static build can honour; it lives in
    // localStorage. The rest belong to the scraper, which runs in CI.
    state.settings = { ...state.settings, ...patch };
    if (patch.theme) applyTheme(patch.theme);
    renderSettings();
    return state.settings;
  }
  try {
    const next = await api('/api/settings', { method: 'PUT', body: patch });
    state.settings = next;
    renderSettings();
    await refreshStatus();
    return next;
  } catch (err) {
    toast(`Could not save: ${err.message}`, 'bad');
    renderSettings();
    return null;
  }
}

async function markAllRead() {
  if (STATIC) {
    rememberSeen(staticCache?.generatedAt || new Date().toISOString());
    await loadNotices();
    return;
  }
  try {
    const { counts } = await api('/api/notifications/read', { method: 'POST', body: { ids: [] } });
    state.counts = counts;
    state.notices.forEach((n) => {
      n.isNew = false;
    });
    renderFeed();
    renderSidebar();
  } catch (err) {
    toast(`Could not mark read: ${err.message}`, 'bad');
  }
}

// ---------------------------------------------------------------- push

function urlBase64ToUint8Array(base64) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('Service worker registration failed', err);
    return null;
  }
}

async function syncPushButton() {
  const btn = $('#enablePush');
  const label = $('#enablePushLabel');
  const hint = $('#pushHint');

  if (STATIC) {
    if (!pushSupported()) {
      btn.disabled = true;
      label.textContent = 'Popups not supported';
      hint.textContent =
        'This browser cannot show notifications. You still get an email for every new notice.';
      return;
    }
    btn.disabled = false;
    const on = Boolean(await currentSubscription());
    label.textContent = on ? 'Popup alerts are set up' : 'Turn on popup alerts';
    hint.innerHTML = on
      ? 'This device is registered. Open this again to re-copy the values for your repository.'
      : 'Get a popup on this device the moment a notice appears — like a calendar reminder. ' +
        'Free; one short setup.';
    return;
  }

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.disabled = true;
    label.textContent = 'Alerts not supported';
    hint.textContent =
      'This browser cannot do push notifications. The page still updates live while it is open.';
    return;
  }
  if (!state.meta.vapidPublicKey) {
    btn.disabled = true;
    label.textContent = 'Alerts unavailable';
    hint.textContent = 'The server has no push keys configured.';
    return;
  }

  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  state.pushSubscribed = Boolean(sub);

  if (Notification.permission === 'denied') {
    btn.disabled = true;
    label.textContent = 'Alerts blocked';
    hint.textContent =
      'Notifications are blocked for this site. Allow them in your browser’s site settings to get alerts.';
    return;
  }

  btn.disabled = false;
  label.textContent = sub ? 'Device alerts are on' : 'Enable device alerts';
  hint.textContent = sub
    ? 'This device will be alerted as soon as a new notice is found. Tap again to turn it off.'
    : 'Get a desktop or phone alert the moment a new notice is published.';
}

async function currentSubscription() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) || null;
  } catch {
    return null;
  }
}

async function togglePush() {
  if (STATIC) return openPushSetup();
  const reg = (await navigator.serviceWorker.getRegistration()) || (await registerServiceWorker());
  if (!reg) return toast('Could not start the notification worker.', 'bad');

  const existing = await reg.pushManager.getSubscription();
  if (existing) {
    try {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: existing.endpoint } });
      await existing.unsubscribe();
      toast('Device alerts turned off.');
    } catch (err) {
      toast(`Could not turn alerts off: ${err.message}`, 'bad');
    }
    return syncPushButton();
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    toast('Permission denied, so no alerts will be sent.', 'bad');
    return syncPushButton();
  }

  try {
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.meta.vapidPublicKey),
    });
    await api('/api/push/subscribe', { method: 'POST', body: { subscription } });
    toast('Device alerts are on.', 'good');
  } catch (err) {
    toast(`Could not enable alerts: ${err.message}`, 'bad');
  }
  return syncPushButton();
}

// ---------------------------------------------------------------- push setup

/** Remembered so a second device can be merged rather than overwrite the first. */
const SETUP_KEY = 'pushSetup';

function readSetup() {
  try {
    return JSON.parse(localStorage.getItem(SETUP_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeSetup(value) {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(value));
  } catch {
    /* private mode: the user just re-copies the values */
  }
}

function openPushSetup() {
  const dialog = $('#pushSetup');
  $('#stepCopy').hidden = true;
  $('#stepDone').hidden = true;
  $('#pushSubscribe').disabled = false;

  const repo = staticCache?.meta?.repo;
  $('#secretsLink').href = repo
    ? `https://github.com/${repo}/settings/secrets/actions`
    : 'https://docs.github.com/actions/security-guides/encrypted-secrets';

  $('#subscribeHint').innerHTML = iosNeedsInstall()
    ? '<strong>On iPhone and iPad</strong>, Apple only allows notifications once the site is ' +
      'on your home screen. Tap Share, then “Add to Home Screen”, open it from there, and come back.'
    : 'Your browser will ask for permission.';

  dialog.showModal();
}

function secretBlock(name, value, note) {
  const id = `secret-${name}`;
  return `
    <div class="secret">
      <div class="secret-head">
        <span class="secret-name">${escapeHtml(name)}</span>
        <button class="btn tiny" data-copy="${id}">Copy</button>
      </div>
      <pre class="secret-value" id="${id}">${escapeHtml(value)}</pre>
    </div>
    ${note ? `<p class="hint">${note}</p>` : ''}`;
}

async function runPushSetup() {
  const btn = $('#pushSubscribe');
  btn.disabled = true;
  btn.textContent = 'Waiting for permission…';

  try {
    const saved = readSetup();
    // The public key must be the same for every device, since one private key
    // signs for all of them: reuse the published one, or the one this device
    // generated earlier, before making a new pair.
    const published = staticCache?.meta?.vapidPublicKey || null;
    let keys =
      published && saved.privateKey && saved.publicKey === published
        ? { publicKey: saved.publicKey, privateKey: saved.privateKey }
        : null;
    if (!keys && published) keys = { publicKey: published, privateKey: null };
    if (!keys && saved.publicKey && saved.privateKey) keys = saved;
    if (!keys) keys = await generateVapidKeys();

    const subscription = await subscribeDevice(keys.publicKey);
    const merged = mergeSubscriptions(saved.subscriptions, subscription);

    writeSetup({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey || saved.privateKey || null,
      subscriptions: JSON.stringify(merged),
    });

    const privateKey = keys.privateKey || saved.privateKey;
    const blocks = [];

    if (!published) {
      blocks.push(
        secretBlock('VAPID_PUBLIC_KEY', keys.publicKey),
        privateKey
          ? secretBlock('VAPID_PRIVATE_KEY', privateKey)
          : `<p class="setup-note">This device could not recover the private key. Run the setup
             again on the device you first used, or delete the two VAPID secrets and start over
             here.</p>`
      );
    }

    blocks.push(
      secretBlock(
        'PUSH_SUBSCRIPTIONS',
        JSON.stringify(merged),
        merged.length > 1
          ? `Covers all ${merged.length} of your devices — replace the whole value.`
          : 'This is this device. Adding another later will update this value.'
      )
    );

    if (published) {
      blocks.push(
        `<p class="hint">Your repository already has the signing keys, so only the device list
         changes.</p>`
      );
    }

    $('#secretList').innerHTML = blocks.join('\n');
    $('#stepCopy').hidden = false;
    $('#stepDone').hidden = false;
    btn.textContent = 'Allowed ✓';
    $('#stepCopy').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Allow and continue';
    if (err.code === 'denied') {
      $('#subscribeHint').innerHTML =
        'Notifications are blocked for this site. Allow them in your browser’s site settings ' +
        '(the icon beside the address bar), then try again. Emails still arrive either way.';
    } else {
      toast(`Could not set up popups: ${err.message}`, 'bad');
    }
  }
}

async function copySecret(id) {
  const text = document.getElementById(id)?.textContent || '';
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.', 'good');
  } catch {
    // Clipboard access needs a secure context and permission; select instead.
    const range = document.createRange();
    range.selectNodeContents(document.getElementById(id));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Press Ctrl/Cmd+C to copy the selected text.');
  }
}

// ---------------------------------------------------------------- SSE

function connectStream() {
  const es = new EventSource('/api/stream');

  es.addEventListener('notices', (event) => {
    const { added } = JSON.parse(event.data);
    if (!added?.length) return;

    // Only count the ones the current filter would show.
    const relevant = added.filter(matchesFilter);
    if (!relevant.length) {
      loadNotices().catch(() => {});
      return;
    }

    // Prepend straight away when the user is at the top of an unfiltered feed,
    // otherwise hold them behind a "Show" banner so the list does not jump
    // under the reader.
    if (window.scrollY < 120 && !state.query) {
      state.notices = [...relevant, ...state.notices.filter((n) => !relevant.some((r) => r.id === n.id))];
      state.total += relevant.length;
      $('#noticeList').insertAdjacentHTML('afterbegin', relevant.map((n) => noticeCard(n, true)).join(''));
      renderFeed();
    } else {
      state.pending.push(...relevant);
      renderPendingBanner();
    }
  });

  es.addEventListener('ingest', () => {
    refreshStatus().catch(() => {});
    loadNotices().catch(() => {});
  });

  es.addEventListener('settings', (event) => {
    state.settings = JSON.parse(event.data);
    renderSettings();
  });

  es.onerror = () => {
    // EventSource reconnects on its own; just reflect it in the pill.
    if (es.readyState === EventSource.CONNECTING) {
      $('#statusPill').dataset.state = 'error';
      $('#statusText').textContent = 'Reconnecting…';
    }
  };

  es.addEventListener('open', () => refreshStatus().catch(() => {}));
  return es;
}

function matchesFilter(n) {
  if (state.category !== 'all' && !n.categories.includes(state.category)) return false;
  if (state.source !== 'all' && n.sourceId !== state.source) return false;
  if (state.onlyNew && !n.isNew) return false;
  if (state.query && !n.title.toLowerCase().includes(state.query.toLowerCase())) return false;
  return true;
}

// ---------------------------------------------------------------- wiring

function wireEvents() {
  $('#fetchNow').addEventListener('click', fetchNow);

  $('#themeToggle').addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    saveSettings({ theme: next });
  });

  $('#themeChoice').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-theme]');
    if (!btn) return;
    applyTheme(btn.dataset.theme);
    saveSettings({ theme: btn.dataset.theme });
  });

  $('#categoryNav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-category]');
    if (!btn) return;
    state.category = btn.dataset.category;
    state.pending = [];
    renderPendingBanner();
    closeSidebar();
    loadNotices().catch((err) => toast(err.message, 'bad'));
  });

  $('#sourceNav').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-source]');
    if (!btn) return;
    state.source = btn.dataset.source;
    closeSidebar();
    loadNotices().catch((err) => toast(err.message, 'bad'));
  });

  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const value = e.target.value.trim();
    searchTimer = setTimeout(() => {
      state.query = value;
      loadNotices().catch((err) => toast(err.message, 'bad'));
    }, 220);
  });

  $('#onlyNew').addEventListener('change', (e) => {
    state.onlyNew = e.target.checked;
    loadNotices().catch((err) => toast(err.message, 'bad'));
  });

  $('#markAllRead').addEventListener('click', markAllRead);
  $('#loadMore').addEventListener('click', () => loadNotices({ append: true }));

  $('#newBannerShow').addEventListener('click', () => {
    state.pending = [];
    renderPendingBanner();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    loadNotices().catch(() => {});
  });

  $('#enablePush').addEventListener('click', togglePush);

  $('#pushSubscribe')?.addEventListener('click', runPushSetup);
  $('#pushSetupClose')?.addEventListener('click', () => $('#pushSetup').close());
  $('#pushSetupFinish')?.addEventListener('click', () => $('#pushSetup').close());
  $('#pushSetup')?.addEventListener('close', () => syncPushButton().catch(() => {}));
  $('#secretList')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-copy]');
    if (btn) copySecret(btn.dataset.copy);
  });

  // settings drawer
  const openDrawer = () => {
    $('#settingsDrawer').classList.add('open');
    $('#settingsDrawer').setAttribute('aria-hidden', 'false');
    $('#settingsToggle').setAttribute('aria-expanded', 'true');
    $('#scrim').hidden = false;
  };
  const closeDrawer = () => {
    $('#settingsDrawer').classList.remove('open');
    $('#settingsDrawer').setAttribute('aria-hidden', 'true');
    $('#settingsToggle').setAttribute('aria-expanded', 'false');
    $('#scrim').hidden = true;
  };
  $('#settingsToggle').addEventListener('click', openDrawer);
  $('#settingsClose').addEventListener('click', closeDrawer);
  $('#scrim').addEventListener('click', () => {
    closeDrawer();
    closeSidebar();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDrawer();
      closeSidebar();
    }
  });

  // mobile sidebar
  $('#menuToggle').addEventListener('click', () => {
    const open = $('#sidebar').classList.toggle('open');
    $('#menuToggle').setAttribute('aria-expanded', String(open));
    $('#scrim').hidden = !open;
  });

  // settings controls
  $('#autoFetch').addEventListener('change', (e) => saveSettings({ autoFetch: e.target.checked }));
  $('#pushEnabled').addEventListener('change', (e) => saveSettings({ pushEnabled: e.target.checked }));
  $('#interval').addEventListener('change', (e) =>
    saveSettings({ intervalMinutes: Number(e.target.value) })
  );
  $('#customIntervalApply').addEventListener('click', () => {
    const value = Number($('#customInterval').value);
    if (!Number.isFinite(value) || value < 1 || value > 1440) {
      return toast('Enter a number of minutes between 1 and 1440.', 'bad');
    }
    $('#customInterval').value = '';
    return saveSettings({ intervalMinutes: value });
  });

  $('#pushCategories').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-push-cat]');
    if (!btn) return;
    const id = btn.dataset.pushCat;
    const current = new Set(state.settings.pushCategories);
    if (current.has(id)) current.delete(id);
    else current.add(id);
    saveSettings({ pushCategories: [...current] });
  });

  // Keep relative timestamps honest without a full re-render storm. In static
  // mode this also picks up a scrape that landed while the tab sat open.
  setInterval(() => {
    if (document.hidden) return;
    if (STATIC) {
      loadStaticFeed({ force: true })
        .then(() => loadNotices())
        .then(() => refreshStatus())
        .catch(() => {});
      return;
    }
    refreshStatus().catch(() => {});
  }, 60000);
}

function closeSidebar() {
  if (window.innerWidth > 900) return;
  $('#sidebar').classList.remove('open');
  $('#menuToggle').setAttribute('aria-expanded', 'false');
  $('#scrim').hidden = true;
}

// ---------------------------------------------------------------- boot

async function main() {
  wireEvents();

  try {
    if (STATIC) {
      const feed = await loadStaticFeed();
      state.meta = {
        categories: feed.meta.categories,
        sources: feed.meta.sources,
        intervalChoices: [],
        defaults: {},
        vapidPublicKey: null,
      };
      state.settings = { theme: readStoredTheme(), pushCategories: [] };
    } else {
      state.meta = await api('/api/meta');
    }
  } catch (err) {
    $('#statusPill').dataset.state = 'error';
    $('#statusText').textContent = STATIC ? 'Feed unavailable' : 'Server unreachable';
    toast(
      STATIC ? `Could not load the feed: ${err.message}` : `Cannot reach the server: ${err.message}`,
      'bad'
    );
    return;
  }

  await refreshStatus();
  renderSidebar();
  renderSettings();
  await loadNotices();
  await syncPushButton();

  if (STATIC) {
    // Mark everything read once the user has actually seen this build, so the
    // next scheduled scrape is what lights up the badges.
    window.addEventListener('beforeunload', () => rememberSeen(staticCache?.generatedAt || ''));
    return;
  }

  await registerServiceWorker();
  connectStream();

  // Clicking a notification opens the link; the worker asks us to refresh too.
  navigator.serviceWorker?.addEventListener('message', (event) => {
    if (event.data?.type === 'refresh') {
      loadNotices().catch(() => {});
      refreshStatus().catch(() => {});
    }
  });
}

function readStoredTheme() {
  try {
    return localStorage.getItem('theme') || 'system';
  } catch {
    return 'system';
  }
}

main();

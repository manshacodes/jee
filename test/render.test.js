import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * Notice titles, URLs and section names are scraped from pages we do not
 * control, so the card template must escape every one of them. These tests
 * exercise the real `noticeCard`/`escapeHtml`/`safeUrl` source from app.js
 * rather than a copy, so they fail if the template stops escaping a field.
 */
const HERE = dirname(fileURLToPath(import.meta.url));

async function loadRenderer() {
  const src = await readFile(join(HERE, '..', 'public', 'js', 'app.js'), 'utf8');

  const slice = (startMarker) => {
    const from = src.indexOf(startMarker);
    assert.notEqual(from, -1, `could not find ${startMarker} in app.js`);
    // Functions in app.js are top-level, so the next line starting with "}"
    // closes them.
    const end = src.indexOf('\n}', from);
    return src.slice(from, end + 2);
  };

  const body = [
    slice('function noticeCard('),
    slice('function escapeHtml('),
    slice('function safeUrl('),
    slice('function primaryCategory('),
    slice('function formatDate('),
    slice('function relativeTime('),
    'const categoryLabel = (id) => id;',
    'return { noticeCard, escapeHtml, safeUrl, primaryCategory };',
  ].join('\n\n');

  // `safeUrl` resolves relative URLs against the page origin.
  const window = { location: { origin: 'https://app.example' } };
  // eslint-disable-next-line no-new-func
  return new Function('window', 'URL', body)(window, URL);
}

const notice = (over = {}) => ({
  id: 'abc123',
  title: 'Public Notice for JEE (Main) 2027',
  url: 'https://jeemain.nta.nic.in/a.pdf',
  sourceLabel: 'NTA — JEE (Main)',
  section: 'Public Notices',
  categories: ['jee'],
  publishedAt: '2026-10-24',
  dateInferred: false,
  firstSeenAt: '2026-10-24T00:00:00.000Z',
  isNew: false,
  ...over,
});

test('a scraped title cannot inject markup', async () => {
  const { noticeCard } = await loadRenderer();
  const html = noticeCard(notice({ title: '<img src=x onerror=alert(1)>Result out' }));
  assert.ok(!html.includes('<img src=x'), 'the title was not escaped');
  assert.ok(html.includes('&lt;img src=x'));
});

test('a scraped URL cannot break out of the href attribute', async () => {
  const { noticeCard } = await loadRenderer();
  const html = noticeCard(
    notice({ url: 'https://evil.example/a.pdf" onmouseover="alert(document.cookie)' })
  );
  // The quote is percent-encoded by URL parsing and escaped on the way out, so
  // the payload stays inside the href value instead of becoming an attribute.
  const href = /href="([^"]*)"/.exec(html);
  assert.ok(href, 'no href was rendered');
  assert.ok(!href[1].includes('"'), 'a raw quote survived into the href');
  assert.ok(
    !/<a[^>]*\sonmouseover\s*=/.test(html),
    'the URL became an event-handler attribute'
  );
});

test('a scraped section name cannot inject markup', async () => {
  const { noticeCard } = await loadRenderer();
  const html = noticeCard(notice({ section: '<script>alert(1)</script>' }));
  assert.ok(!html.includes('<script>'), 'the section name was not escaped');
});

test('a javascript: URL is replaced rather than linked', async () => {
  const { noticeCard, safeUrl } = await loadRenderer();
  assert.equal(safeUrl('javascript:alert(1)'), '#');
  assert.equal(safeUrl('data:text/html,<script>alert(1)</script>'), '#');
  assert.equal(safeUrl('vbscript:msgbox(1)'), '#');
  // A bare string is not dangerous: it resolves against our own origin.
  assert.equal(safeUrl('not a url at all'), 'https://app.example/not%20a%20url%20at%20all');
  const html = noticeCard(notice({ url: 'javascript:alert(1)' }));
  assert.ok(!html.includes('javascript:'), 'a javascript: URL was rendered as a link');
  assert.ok(html.includes('href="#"'));
});

test('ordinary http(s) links are left intact', async () => {
  const { safeUrl } = await loadRenderer();
  assert.equal(
    safeUrl('https://cdnbbsr.s3waas.gov.in/s3a/uploads/2026/10/x.pdf'),
    'https://cdnbbsr.s3waas.gov.in/s3a/uploads/2026/10/x.pdf'
  );
  assert.equal(safeUrl('http://cbse.gov.in/a.pdf'), 'http://cbse.gov.in/a.pdf');
});

test('a normal notice still renders its title, link and metadata', async () => {
  const { noticeCard } = await loadRenderer();
  const html = noticeCard(notice());
  assert.ok(html.includes('Public Notice for JEE (Main) 2027'));
  assert.ok(html.includes('href="https://jeemain.nta.nic.in/a.pdf"'));
  assert.ok(html.includes('NTA — JEE (Main)'));
  assert.ok(html.includes('Published'));
});

test('an inferred date is labelled as approximate', async () => {
  const { noticeCard } = await loadRenderer();
  assert.ok(noticeCard(notice({ dateInferred: true })).includes('Around'));
  assert.ok(noticeCard(notice({ dateInferred: false })).includes('Published'));
});

test('the feed is grouped by how recent a notice is', async () => {
  const { noticeCard } = await loadRenderer();
  // The card itself carries the category stripe colour; the grouping label is
  // asserted separately below since it is a feed-level concern.
  assert.match(noticeCard(notice({ categories: ['class10', 'class12'] })), /data-cat="class10"/);
  assert.match(noticeCard(notice({ categories: ['other'] })), /data-cat="other"/);
  // "other" never wins over a real stream.
  assert.match(noticeCard(notice({ categories: ['other', 'neet'] })), /data-cat="neet"/);
});

test('date group labels are relative near today and absolute further back', async () => {
  const src = await readFile(join(HERE, '..', 'public', 'js', 'app.js'), 'utf8');
  const from = src.indexOf('function dateGroupLabel(');
  const fn = new Function(`${src.slice(from, src.indexOf('\n}', from) + 2)}; return dateGroupLabel;`)();

  const day = 86400000;
  const iso = (offset) => new Date(Date.now() - offset).toISOString();

  assert.equal(fn(iso(0)), 'Today');
  assert.equal(fn(iso(day)), 'Yesterday');
  assert.equal(fn(iso(3 * day)), 'This week');
  assert.equal(fn(iso(10 * day)), 'Last week');
  assert.equal(fn(iso(20 * day)), 'This month');
  // Older than a month falls back to a month and year, not "N days ago".
  assert.match(fn(iso(200 * day)), /^[A-Z][a-z]+ \d{4}$/);
  assert.equal(fn(null), 'Undated');
  assert.equal(fn('not a date'), 'Undated');
});

test('a card offers a star, reflecting its saved state', async () => {
  const { noticeCard } = await loadRenderer();
  const off = noticeCard(notice({ starred: false }));
  assert.match(off, /data-star="abc123"/);
  assert.match(off, /aria-pressed="false"/);
  assert.match(off, /aria-label="Save this notice"/);

  const on = noticeCard(notice({ starred: true }));
  assert.match(on, /aria-pressed="true"/);
  assert.match(on, /class="star on"/);
  assert.match(on, /aria-label="Remove from saved"/);
});

test('the star carries the notice id, escaped', async () => {
  const { noticeCard } = await loadRenderer();
  // Ids are generated hashes, but the attribute is escaped regardless.
  const html = noticeCard(notice({ id: 'a"b<c' }));
  assert.ok(!html.includes('data-star="a"b'), 'the id broke out of its attribute');
  assert.match(html, /data-star="a&quot;b&lt;c"/);
});

test('the tab title shows an unread count only when there is one', async () => {
  const src = await readFile(join(HERE, '..', 'public', 'js', 'app.js'), 'utf8');
  const from = src.indexOf('function updateTabTitle(');
  const fn = new Function(
    'document',
    `${src.slice(from, src.indexOf('\n}', from) + 2)}; return updateTabTitle;`
  );
  const doc = { title: '' };
  const updateTabTitle = fn(doc);

  updateTabTitle(3);
  assert.equal(doc.title, '(3) Exam Notice Radar');
  updateTabTitle(0);
  assert.equal(doc.title, 'Exam Notice Radar');
});

test('the "since your last visit" label stays readable at any age', async () => {
  const src = await readFile(join(HERE, '..', 'public', 'js', 'app.js'), 'utf8');
  const from = src.indexOf('function shortWhen(');
  const shortWhen = new Function(`${src.slice(from, src.indexOf('\n}', from) + 2)}; return shortWhen;`)();

  const day = 86400000;
  const ago = (ms) => new Date(Date.now() - ms).toISOString();
  assert.equal(shortWhen(ago(3600000)), 'earlier today');
  assert.equal(shortWhen(ago(1.2 * day)), 'yesterday');
  assert.match(shortWhen(ago(3 * day)), /^[A-Z][a-z]+day$/);
  assert.match(shortWhen(ago(30 * day)), /\d/);
  assert.equal(shortWhen('nonsense'), 'your last visit');
});

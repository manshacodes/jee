import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * GitHub Pages cannot run the server, so the build has to bake the feed into
 * JSON and rewrite the absolute paths the Express app relies on. A mistake
 * there produces a site that 404s its own stylesheet, which is exactly the
 * kind of thing that should fail CI rather than ship.
 */
let dataDir;
let out;
let html;
let notices;
let meta;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'static-data-'));
  out = await mkdtemp(join(tmpdir(), 'static-out-'));

  await mkdir(dataDir, { recursive: true });
  await writeFile(
    join(dataDir, 'notifications.json'),
    JSON.stringify({
      notices: [
        {
          id: 'a',
          title: 'JEE Main 2027 application form',
          url: 'https://jeemain.nta.nic.in/a.pdf',
          sourceId: 'nta-jee',
          sourceLabel: 'NTA — JEE (Main)',
          categories: ['jee'],
          publishedAt: '2026-10-24',
          firstSeenAt: '2026-10-24T00:00:00.000Z',
          isNew: false,
        },
        {
          id: 'b',
          title: 'Date Sheet for Class X & XII',
          url: 'https://cbse.gov.in/b.pdf',
          sourceId: 'cbse',
          sourceLabel: 'CBSE',
          categories: ['class10', 'class12'],
          publishedAt: '2026-10-05',
          firstSeenAt: '2026-10-05T00:00:00.000Z',
          isNew: false,
        },
      ],
    }),
    'utf8'
  );

  await run('node', [join(ROOT, 'scripts', 'build-static.js')], {
    env: { ...process.env, DATA_DIR: dataDir, STATIC_OUT: out, GITHUB_REPOSITORY: 'me/jee' },
  });

  html = await readFile(join(out, 'index.html'), 'utf8');
  notices = JSON.parse(await readFile(join(out, 'notices.json'), 'utf8'));
  meta = JSON.parse(await readFile(join(out, 'meta.json'), 'utf8'));
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(out, { recursive: true, force: true });
});

test('the feed is baked into notices.json, newest first', async () => {
  assert.equal(notices.notices.length, 2);
  assert.equal(notices.notices[0].title, 'JEE Main 2027 application form');
  assert.ok(notices.generatedAt);
  assert.equal(notices.counts.all, 2);
  assert.equal(notices.counts.jee, 1);
  assert.equal(notices.counts.class10, 1);
  assert.equal(notices.counts.class12, 1);
});

test('meta.json carries the categories, sources and a link to the runs', () => {
  assert.equal(meta.static, true);
  assert.deepEqual(meta.categories.map((c) => c.id), ['jee', 'neet', 'class10', 'class12', 'other']);
  assert.ok(meta.sources.length >= 4);
  assert.equal(meta.workflowUrl, 'https://github.com/me/jee/actions');
});

test('the page is flipped into static mode', () => {
  assert.match(html, /window\.NOTICE_RADAR_STATIC = \{/);
});

test('absolute paths are rewritten, since Pages serves from a subpath', () => {
  // A leftover "/css/app.css" would 404 at https://user.github.io/jee/.
  assert.ok(!/(href|src)="\/(?!\/)/.test(html), 'an absolute path survived the rewrite');
  assert.match(html, /href="\.\/css\/app\.css"/);
  assert.match(html, /src="\.\/js\/app\.js\?v=\d+"/);
});

test('the manifest is rewritten for the subpath too', async () => {
  const manifest = JSON.parse(await readFile(join(out, 'manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.start_url, '.');
  assert.equal(manifest.scope, '.');
  assert.ok(manifest.icons.every((i) => !i.src.startsWith('/')), 'an icon kept an absolute path');
});

test('the assets the page references are actually present', async () => {
  for (const file of [
    'css/app.css',
    'js/app.js',
    'icons/icon.svg',
    'icons/icon-192.png',
    'manifest.webmanifest',
    '.nojekyll', // without this, Pages' Jekyll pass drops files
  ]) {
    await readFile(join(out, file));
  }
});

test('every versioned asset is cache-busted, not just the script', () => {
  // A stylesheet-only change (a redesign) would otherwise reach people who
  // already have the page cached, as old CSS over new markup.
  const js = /src="\.\/js\/app\.js\?v=(\d+)"/.exec(html);
  const css = /href="\.\/css\/app\.css\?v=(\d+)"/.exec(html);
  assert.ok(js, 'no cache-busting stamp on the script');
  assert.ok(css, 'no cache-busting stamp on the stylesheet');
  assert.equal(js[1], css[1], 'the script and stylesheet carry different stamps');
  assert.ok(Number(js[1]) > 0);
  assert.ok(!/href="\.\/css\/app\.css"/.test(html), 'an unstamped stylesheet link survived');
});

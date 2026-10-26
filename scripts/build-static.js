#!/usr/bin/env node
/**
 * Render the static site that GitHub Pages serves.
 *
 * Pages cannot run the Express app, so the scraped feed is baked into JSON
 * files next to the same HTML/CSS/JS the server serves, and a flag in the HTML
 * tells the front end to read those files instead of calling /api.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CATEGORIES, CATEGORY_IDS } from '../server/categorize.js';
import { SOURCES } from '../server/sources/index.js';
import { getNotices, sortNotices } from '../server/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PUBLIC = join(ROOT, 'public');
const OUT = process.env.STATIC_OUT || join(ROOT, 'dist');

// Chronological only: the browser decides what is unread for this device, so
// pinning the server's idea of "new" would just reorder the feed wrongly.
const notices = sortNotices(await getNotices(), { pinNew: false });

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

// The UI, verbatim -- one codebase for both modes.
await cp(PUBLIC, OUT, { recursive: true });

// The service worker's Web Push handler is dead weight on Pages (there is no
// server to subscribe to), but keeping the file avoids a 404 from any browser
// that still has it registered from a local run.

const counts = { all: notices.length, new: 0 };
for (const id of CATEGORY_IDS) {
  counts[id] = notices.filter((n) => n.categories.includes(id)).length;
  counts[`${id}:new`] = 0;
}

await writeFile(
  join(OUT, 'notices.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), counts, notices }),
  'utf8'
);

await writeFile(
  join(OUT, 'meta.json'),
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    categories: CATEGORIES,
    sources: SOURCES.map((s) => ({ id: s.id, label: s.label, homepage: s.homepage })),
    intervalChoices: [],
    static: true,
    // Safe to publish by design -- it is the key browsers check signatures
    // against. The private half stays in the Actions secret.
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null,
    repo: process.env.GITHUB_REPOSITORY || null,
    workflowUrl: process.env.GITHUB_REPOSITORY
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions`
      : null,
  }),
  'utf8'
);

// Flip the front end into static mode, and bust the cache per build.
//
// Every versioned asset needs the stamp, not just the script: GitHub Pages and
// Vercel both serve CSS with a cache lifetime, so a stylesheet-only change
// (a redesign, say) would otherwise reach people who already have the page
// cached as the old stylesheet over the new markup.
const stamp = Date.now();
const html = await readFile(join(PUBLIC, 'index.html'), 'utf8');
await writeFile(
  join(OUT, 'index.html'),
  html
    .replace(
      '<link rel="stylesheet" href="/css/app.css" />',
      `<link rel="stylesheet" href="./css/app.css?v=${stamp}" />`
    )
    .replace(
      '<script src="/js/app.js" type="module"></script>',
      `<script>window.NOTICE_RADAR_STATIC = ${JSON.stringify({ build: stamp })};</script>\n` +
        `    <script src="./js/app.js?v=${stamp}" type="module"></script>`
    )
    // Pages serves the site from /<repo>/, so absolute paths would 404.
    .replace(/(href|src)="\/(?!\/)/g, '$1="./')
    .replace('<link rel="manifest" href="./manifest.webmanifest" />', '<link rel="manifest" href="./manifest.webmanifest" />'),
  'utf8'
);

// Same for the manifest's absolute paths.
const manifest = JSON.parse(await readFile(join(PUBLIC, 'manifest.webmanifest'), 'utf8'));
manifest.start_url = '.';
manifest.scope = '.';
manifest.icons = manifest.icons.map((i) => ({ ...i, src: i.src.replace(/^\//, './') }));
await writeFile(join(OUT, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2), 'utf8');

// Stop Pages' Jekyll pass from eating files it thinks are templates.
await writeFile(join(OUT, '.nojekyll'), '', 'utf8');

console.log(`built ${OUT}: ${notices.length} notices`);

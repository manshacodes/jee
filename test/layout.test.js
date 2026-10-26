import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * A few CSS invariants that are easy to break silently and hard to notice
 * without scrolling the real page.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const css = await readFile(join(HERE, '..', 'public', 'css', 'app.css'), 'utf8');

test('the body is not height-capped, which would break sticky positioning', () => {
  // `height: 100%` on body caps it at the viewport, so a sticky child can only
  // stick within that box and scrolls away instead of pinning. This silently
  // unstuck the toolbar.
  assert.ok(!/\bhtml,\s*body\s*\{\s*height:\s*100%/.test(css), 'body is height-capped again');
  assert.match(css, /html,\s*body\s*\{\s*min-height:\s*100%/);
});

test('the toolbar and the date headers both pin', () => {
  assert.match(css, /\.topbar\s*\{[^}]*position:\s*sticky/s);
  assert.match(css, /\.date-label\s*\{[^}]*position:\s*sticky/s);
  // Headers pin below the toolbar, not over it.
  assert.match(css, /\.date-label\s*\{[^}]*top:\s*var\(--topbar-h\)/s);
});

test('a pinned date header is opaque, so cards do not show through it', () => {
  assert.match(css, /\.date-label\s*\{[^}]*background:\s*var\(--bg\)/s);
});

test('the moving parts animate transform or opacity only', () => {
  // Animating anything else forces layout or paint every frame.
  for (const [name, block] of [
    ['scroll progress', /\.scroll-progress\s*\{([^}]*)\}/s],
    ['cursor glow', /\.glow\s*\{([^}]*)\}/s],
  ]) {
    const body = block.exec(css)?.[1] || '';
    assert.ok(/transform/.test(body), `${name} does not use a transform`);
    assert.ok(!/\banimation:[^;]*(width|height|top|left|background-position)/.test(body),
      `${name} animates a property that forces layout`);
  }
});

test('reduced motion disables the decorative movement', () => {
  const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.notice\s*\{\s*animation:\s*none/);
  assert.match(reduced, /\.glow\s*\{\s*display:\s*none/);
});

test('the scrim sits below the panels it dims', () => {
  // Putting the scrim above the sidebar made the mobile menu open behind a
  // blurred overlay: you saw the blur, could not see or tap the menu.
  const num = (name) => {
    const m = new RegExp(`${name}:\\s*(\\d+)`).exec(css);
    assert.ok(m, `${name} is not defined`);
    return Number(m[1]);
  };
  const scrim = num('--z-scrim');
  assert.ok(scrim > num('--z-grain'), 'the scrim is under the grain overlay');
  assert.ok(scrim < num('--z-sidebar'), 'the scrim covers the sidebar');
  assert.ok(scrim < num('--z-drawer'), 'the scrim covers the settings drawer');
  assert.ok(num('--z-toast') > num('--z-drawer'), 'toasts can be hidden by the drawer');
});

test('layering goes through the scale, not scattered magic numbers', () => {
  // Any stray `z-index: <number>` outside the token block is how the scrim
  // bug got in: a blanket rule silently outranked a component.
  const body = css.slice(css.indexOf('/* ========================================================== base */'));
  const strays = [...body.matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
  // Only the two tiny in-card values are allowed to be literal.
  assert.deepEqual(strays.sort((a, b) => a - b), [1, 2], `unexpected literal z-index values: ${strays}`);
});

test('the overview only claims a stream has a notice when one is loaded', async () => {
  const src = await readFile(join(HERE, '..', 'public', 'js', 'app.js'), 'utf8');
  const from = src.indexOf('function renderDashboard(');
  const body = src.slice(from, src.indexOf('\n}', from));
  // A stream with nothing in the loaded page must say so rather than show a
  // stale or unrelated notice.
  assert.match(body, /Nothing recent/);
  // And it must only render on the unfiltered view.
  assert.match(body, /state\.category === 'all' && state\.source === 'all' && !state\.query && !state\.onlyNew/);
});

test('the overview grid collapses rather than overflowing on a phone', () => {
  const small = css.slice(css.indexOf('@media (max-width: 540px)'));
  assert.match(small, /\.dash-cards\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  const mid = css.slice(css.indexOf('@media (max-width: 920px)'));
  assert.match(mid, /\.dash-stats\s*\{\s*grid-template-columns:\s*repeat\(2/);
});

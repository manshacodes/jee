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

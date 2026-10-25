import * as cheerio from 'cheerio';
import { fetchHtml } from '../fetcher.js';
import { inferMissingDates } from '../infer-dates.js';
import { parseLooseDate } from './nta.js';

/**
 * cbse.gov.in publishes everything in a single "Latest @ CBSE" list:
 *
 *   <ul class="list">
 *     <li class="list-new">
 *       <a href="documents/21_Circular_2026_07102026.pdf">Rerun of ...(1.2 MB)</a>
 *       07/10/2026 <img src="img//new.gif">
 *     </li>
 *
 * Two quirks the parser has to handle:
 *  1. A large share of the list items are HTML-commented out (the board leaves
 *     expired notices in the markup). cheerio exposes comments as nodes, so
 *     they are naturally skipped -- but we also must not regex over raw HTML.
 *  2. One <li> can hold several anchors (e.g. a circular plus its corrigendum),
 *     each a separate notice sharing the trailing date.
 */

const BASE = 'https://www.cbse.gov.in/cbsenew/';
const SIZE_SUFFIX = /\s*\(\s*(?:\d+(?:\.\d+)?)\s*(?:kb|mb|gb)\s*\)\s*$/i;
// cbse.gov.in often puts the publication date inside the anchor text as well
// as after it ("Latest Recruitment Updates - Click Here 24/09/2026").
const TRAILING_DATE = /[\s\u2013\u2014-]*\b\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}\b\s*$/;

function clean(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function stripNoise(title) {
  let out = clean(title);
  // Order matters: the size suffix sits after the date on some rows.
  for (let i = 0; i < 3; i += 1) {
    const before = out;
    out = out.replace(SIZE_SUFFIX, '').replace(TRAILING_DATE, '').replace(/\s*[|\u2013\u2014-]\s*$/, '').trim();
    if (out === before) break;
  }
  return out;
}

export async function scrapeCbse(source) {
  const errors = [];
  const items = [];
  const seen = new Set();

  for (const page of source.pages) {
    let html;
    try {
      html = await fetchHtml(page.url);
    } catch (err) {
      errors.push(`${page.url}: ${err.message}`);
      continue;
    }

    const $ = cheerio.load(html);
    const before = items.length;

    $('ul.list li, li.list-new').each((_, li) => {
      const row = $(li);
      // The date is the loose text of the <li>, outside the anchors.
      const ownText = clean(row.clone().find('a').remove().end().text());
      const publishedAt = parseLooseDate(ownText);

      const anchors = row.find('a[href]').toArray();
      if (anchors.length === 0) return;

      anchors.forEach((el) => {
        const a = $(el);
        const title = stripNoise(a.text());
        const raw = a.attr('href');
        if (!title || title.length < 6 || !raw) return;
        if (/^(click here|download|read more|more)$/i.test(title)) {
          // Bare "Click here" links are meaningless on their own; use the
          // surrounding list-item text as the headline instead.
          const fallback = stripNoise(row.text().replace(/\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/, ''));
          if (!fallback || fallback.length < 6) return;
          pushItem(fallback, raw, publishedAt);
          return;
        }
        pushItem(title, raw, publishedAt);
      });

      function pushItem(title, raw, date) {
        let url;
        try {
          url = new URL(raw, BASE).toString();
        } catch {
          return;
        }
        const key = `${title}|${url}`;
        if (seen.has(key)) return;
        seen.add(key);
        items.push({ title, url, publishedAt: date, hints: page.hints || [], section: page.section || null });
      }
    });

    // "Latest @ CBSE" is newest-first, so undated rows can inherit a date from
    // their neighbours rather than being treated as published today.
    inferMissingDates(items.slice(before));

    if (items.length === before) {
      errors.push(`${page.url}: parsed 0 notices (page layout may have changed)`);
    }
  }

  return { items, errors };
}

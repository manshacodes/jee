import * as cheerio from 'cheerio';
import { fetchHtml } from '../fetcher.js';
import { inferMissingDates } from '../infer-dates.js';

/**
 * jeemain.nta.nic.in, neet.nta.nic.in and nta.ac.in all run the S3WaaS
 * government WordPress template, so one parser covers all three. Three layouts
 * appear across their pages:
 *
 *  1. `.gen-list ul li a`            -- home page tab panels and the
 *                                       /public-notices/ listing pages.
 *  2. `.newsticker ul.slides li a`   -- the "LATEST NEWS" marquee.
 *  3. `table.doc-table` (a.k.a. `.data-table-1`) with Title | Date |
 *     View/Download -- the archive and /document-category/ listings, which is
 *     also what nta.ac.in/NoticeBoardArchive serves.
 *
 * The same `.gen-list` class is reused for navigation blocks ("Helpdesk",
 * "Additional Links"), so a bare `.gen-list li a` sweep drags in footer junk.
 * We therefore require a notice anchor to actually look like a notice: a
 * `download` attribute, a document URL, or a permalink under a notice path.
 */

const DATE_FROM_URL = /\/uploads\/(\d{4})\/(\d{2})\/(\d{4})(\d{2})(\d{2})\d*\.\w+$/i;
const DATE_FROM_PATH = /\/uploads\/(\d{4})\/(\d{2})\//;

const DOCUMENT_EXT = /\.(pdf|docx?|xlsx?|pptx?|zip|rtf)(?:[?#]|$)/i;
const NOTICE_PATH =
  /\/(public-notice|notice|news|press-release|document|archive|circular|advisory|result|answer-key|information-bulletin|syllabus)/i;

// Headings whose `.gen-list` is site navigation, not notices.
const NAV_HEADINGS =
  /^(helpdesk|additional links|important links|quick links|useful links|related links|other links|contact|follow us|social|website policies|about)/i;

const BOILERPLATE_TITLES =
  /^(view all|read more|click here|download|more|next|previous|home|contact us|sitemap|feedback|help|login|register|screen reader access|skip to main content|a-|a\+|english|हिंदी)$/i;

export function dateFromDocumentUrl(url = '') {
  const exact = DATE_FROM_URL.exec(url);
  if (exact) {
    const [, , , y, m, d] = exact;
    const iso = `${y}-${m}-${d}`;
    const asDate = new Date(`${iso}T00:00:00Z`);
    // Guard against bogus components like month 19 / day 44 in file names.
    if (
      !Number.isNaN(asDate.getTime()) &&
      asDate.getUTCMonth() + 1 === Number(m) &&
      asDate.getUTCDate() === Number(d)
    ) {
      return iso;
    }
  }
  // Fall back to the year/month upload folder, pinned to the 1st, so ordering
  // still roughly works for documents with non-standard file names.
  const loose = DATE_FROM_PATH.exec(url);
  if (loose) return `${loose[1]}-${loose[2]}-01`;
  return null;
}

export function parseLooseDate(text) {
  if (!text) return null;
  const dmy = /(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/.exec(text);
  if (dmy) {
    let [, d, mo, y] = dmy;
    if (y.length === 2) y = `20${y}`;
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  // "24 October 2026" / "24th Oct, 2026"
  const named =
    /(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*,?\s+(\d{4})/i.exec(
      text
    );
  if (named) {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const mo = months.indexOf(named[2].toLowerCase()) + 1;
    const iso = `${named[3]}-${String(mo).padStart(2, '0')}-${String(named[1]).padStart(2, '0')}`;
    return Number.isNaN(Date.parse(iso)) ? null : iso;
  }
  return null;
}

const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();

function looksLikeNotice(href, hasDownloadAttr) {
  if (hasDownloadAttr) return true;
  if (DOCUMENT_EXT.test(href)) return true;
  if (NOTICE_PATH.test(href)) return true;
  return false;
}

function absolutise(href, pageUrl) {
  try {
    return new URL(href, pageUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Collect notices from one loaded page.
 * @returns {number} how many notices this page yielded (before dedup)
 */
function parsePage($, pageUrl, collect) {
  let parsed = 0;

  // --- 1. gen-list blocks -------------------------------------------------
  $('.gen-list').each((_, block) => {
    const $block = $(block);
    if ($block.closest('footer, .footer-top, .footer-bottom, .copyRights').length) return;

    const heading = clean($block.find('h2, h3, h4').first().text());
    if (heading && NAV_HEADINGS.test(heading)) return;

    $block.find('li a[href]').each((__, el) => {
      const a = $(el);
      const href = a.attr('href');
      const title = clean(a.text());
      if (!href || !title || title.length < 10) return;
      if (BOILERPLATE_TITLES.test(title)) return;
      if (!looksLikeNotice(href, a.is('[download]'))) return;

      const url = absolutise(href, pageUrl);
      if (!url) return;
      parsed += 1;
      collect({ title, url, publishedAt: dateFromDocumentUrl(url) });
    });
  });

  // --- 2. latest-news ticker (curated, so accept non-document links) ------
  $('.newsticker ul.slides li a[href], .news-ticker-horizontal ul li a[href]').each((_, el) => {
    const a = $(el);
    const href = a.attr('href');
    const title = clean(a.text());
    if (!href || !title || title.length < 10) return;
    if (BOILERPLATE_TITLES.test(title)) return;
    const url = absolutise(href, pageUrl);
    if (!url) return;
    parsed += 1;
    collect({ title, url, publishedAt: dateFromDocumentUrl(url) });
  });

  // --- 3. document tables (archive / document-category listings) ----------
  $('table').each((_, table) => {
    const $table = $(table);
    if ($table.closest('footer, .footer-top, .footer-bottom').length) return;

    $table.find('tbody tr, tr').each((__, tr) => {
      const $tr = $(tr);
      const cells = $tr.find('td');
      if (cells.length === 0) return;

      const link = $tr
        .find('a[href]')
        .toArray()
        .map((el) => $(el))
        .find((a) => looksLikeNotice(a.attr('href') || '', a.is('[download]')));
      if (!link) return;

      const href = link.attr('href');
      // Prefer the anchor text; the aria-label/title often carries "PDF 311 KB
      // - opens in a new window" noise, and the first cell is the title column.
      const title =
        clean(link.text()).length >= 10 ? clean(link.text()) : clean(cells.eq(0).text());
      if (!title || title.length < 10) return;
      if (BOILERPLATE_TITLES.test(title)) return;

      const url = absolutise(href, pageUrl);
      if (!url) return;

      const dateText = cells
        .toArray()
        .map((td) => clean($(td).text()))
        .map(parseLooseDate)
        .find(Boolean);

      parsed += 1;
      collect({ title, url, publishedAt: dateText || dateFromDocumentUrl(url) });
    });
  });

  return parsed;
}

/**
 * @param {object} source entry from sources/index.js
 * @returns {Promise<{items:Array, errors:string[]}>}
 */
export async function scrapeNta(source) {
  const seen = new Set();
  const items = [];
  const errors = [];

  for (const page of source.pages) {
    let html;
    try {
      html = await fetchHtml(page.url);
    } catch (err) {
      errors.push(`${page.url}: ${err.message}`);
      continue;
    }

    const $ = cheerio.load(html);
    const pageStart = items.length;
    const parsed = parsePage($, page.url, (item) => {
      // Dedup across pages -- the same notice appears on the home page ticker
      // and on its listing page.
      const key = `${item.title.toLowerCase()}|${item.url}`;
      if (seen.has(key)) return;
      seen.add(key);
      items.push({ ...item, hints: page.hints || [], section: page.section || null });
    });

    // The listings are newest-first, so undated rows can inherit a date from
    // their neighbours rather than being treated as published today.
    inferMissingDates(items.slice(pageStart));

    // Only a genuinely empty parse signals a layout change; a page whose every
    // notice we already saw elsewhere is normal and must not raise an error.
    if (parsed === 0) {
      errors.push(`${page.url}: parsed 0 notices (page layout may have changed)`);
    }
  }

  return { items, errors };
}

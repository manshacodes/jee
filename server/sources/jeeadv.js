import * as cheerio from 'cheerio';
import { fetchHtml } from '../fetcher.js';
import { inferMissingDates } from '../infer-dates.js';
import { parseLooseDate } from './nta.js';

/**
 * jeeadv.ac.in — JEE (Advanced), run by the IITs rather than by NTA, so it
 * shares nothing with the S3WaaS template the other sources use and needs its
 * own parser.
 *
 * Announcements sit on the home page as:
 *
 *   <div class="ann-card">
 *     <h4 class="announcement__head">Examination Date</h4>
 *     <div class="announcement__text">
 *       <h5>JEE (Advanced) 2027 will be held on May 23, 2027 (Sunday).</h5>
 *     </div>
 *     <span class="ann-date">Posted on November 13, 2027, 17:00 IST</span>
 *   </div>
 *
 * There is no archive page: the site is rebuilt each cycle and carries only
 * the current year's announcements, so the home page is the whole feed. Our
 * own store keeps them after they are taken down.
 */

const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();

export async function scrapeJeeAdv(source) {
  const items = [];
  const errors = [];
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

    $('.ann-card').each((_, el) => {
      const card = $(el);
      const heading = clean(card.find('.announcement__head').first().text());
      const body = clean(card.find('.announcement__text').first().text());

      // The body is the informative sentence; the heading is a label like
      // "Examination Date", which belongs in the section slot the other
      // sources already use. Fall back to the heading if a card has no body.
      const title = body || heading;
      if (!title || title.length < 8) return;

      // Most announcements carry no document of their own; the ones that do
      // link to a page on the same site. An unusable link (a javascript:
      // handler, say) must not cost us the announcement itself -- the text is
      // still the notice -- so fall back to the section it lives in.
      const fallback = new URL('#announcements', page.url).toString();
      const href = card.find('.announcement__text a[href]').first().attr('href');
      let url = fallback;
      if (href) {
        try {
          const resolved = new URL(href, page.url);
          if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
            url = resolved.toString();
          }
        } catch {
          /* keep the fallback */
        }
      }

      const key = `${title.toLowerCase()}|${url}`;
      if (seen.has(key)) return;
      seen.add(key);

      items.push({
        title,
        url,
        publishedAt: parseLooseDate(card.find('.ann-date').first().text()),
        section: heading || page.section || null,
        hints: page.hints || [],
      });
    });

    inferMissingDates(items.slice(before));

    if (items.length === before) {
      errors.push(`${page.url}: parsed 0 notices (page layout may have changed)`);
    }
  }

  return { items, errors };
}

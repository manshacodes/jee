import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import * as cheerio from 'cheerio';

/**
 * Parser tests run against fixtures copied from the live pages, so a layout
 * change on the boards' side shows up as a failing test rather than a silently
 * empty feed.
 */
import { scrapeCbse } from '../server/sources/cbse.js';
import { scrapeNta } from '../server/sources/nta.js';
import { fixtureServer } from './helpers/fixture-server.js';

const NTA_PAGE = `
<html><body>
  <div class="news-ticker-horizontal"><div class="newsticker"><ul class="slides">
    <li><a class="with-urlchange" href="https://jeemain.nta.nic.in/online-application-form/">Online Application Form for JEE (Main) 2027 – Session 1</a></li>
  </ul></div></div>

  <div class="vc_tta-panel-body">
    <div class="gen-list default-list">
      <ul>
        <li><a download href="https://cdnbbsr.s3waas.gov.in/s3a/uploads/2026/10/20261024390682350.pdf" title="download">Inviting Online Application form for the Joint Entrance Examination (JEE)-2027 (Session 1) &#8211; Reg.</a></li>
        <li><a download href="https://cdnbbsr.s3waas.gov.in/s3a/uploads/2026/05/20260505152853066.pdf" title="download">Declaration of Final NTA Scores for JEE (Main) &#8211; 2026</a></li>
      </ul>
      <a href="/public-notices/" class="btn">View All</a>
    </div>
  </div>

  <!-- navigation blocks reuse the same class and must be ignored -->
  <div class="gen-list default-list">
    <h2>Helpdesk</h2>
    <ul><li><a href="/contact-us/" title="Contact Us"><div class="list-text">Contact US</div></a></li></ul>
  </div>
  <div class="gen-list default-list">
    <h2>Additional Links</h2>
    <ul><li><a href="https://www.education.gov.in/en"><div class="list-text">Ministry Of Education</div></a></li></ul>
  </div>

  <table class="data-table-1 doc-table">
    <caption>NEET(UG)-2025 Public Notices</caption>
    <thead><tr><th>Title</th><th>Date</th><th>View / Download</th></tr></thead>
    <tbody>
      <tr>
        <td><a target="_blank" href="https://cdnbbsr.s3waas.gov.in/s3b/uploads/2025/07/2025071435.pdf" aria-label="noise PDF 311 KB - opens in a new window">Declaration of Result of concerned Candidates</a></td>
        <td>14/07/2025</td>
        <td><a href="#">Accessible Version</a></td>
      </tr>
    </tbody>
  </table>

  <footer class="footer-top">
    <div class="gen-list"><ul><li><a href="/sitemap/">Sitemap of the whole website</a></li></ul></div>
  </footer>
</body></html>`;

const CBSE_PAGE = `
<html><body>
  <h2>Latest @ CBSE</h2>
  <ul class="list">
    <li class="list-new"><a href="documents/21_Circular_2026_07102026.pdf" target="_blank"><i class="fa fa-file-pdf-o"></i>Rerun of Second Cycle of NISHTHA Courses (1.2 MB)</a> 07/10/2026 <img src="img//new.gif" /></li>
    <li class="list-new"><a href="documents/datesheet_x_xii.pdf"><i></i>Date Sheet for Class X &amp; XII Board Examinations 2027 (323 KB)</a> 05/10/2026 </li>
    <!-- expired notices are left in the markup as comments and must be skipped -->
    <li class="list-new"><a href="documents/old_notice.pdf">This notice has expired (100 KB)</a> 01/01/2020 </li>
    <li class="list-new"><a href="recruitment.html" target="_blank"><i class="fa fa-link"></i>Latest Recruitment Updates – Click Here 24/09/2026</a> </li>
    <li class="list-new">
      <a href="documents/circular_main.pdf">Verification of Issues Observed and Re-evaluation (1.49 MB)</a> |
      <a href="documents/aadhaar.pdf">Aadhaar (289 KB)</a> 02/06/2026
    </li>
  </ul>
</body></html>`;

// The third <li> above is wrapped in a comment at serve time so the fixture
// reproduces how cbse.gov.in actually hides expired rows.
const CBSE_WITH_COMMENT = CBSE_PAGE.replace(
  /<li class="list-new"><a href="documents\/old_notice\.pdf">[\s\S]*?<\/li>/,
  (m) => `<!-- ${m} -->`
);

test('NTA parser reads notices and ignores navigation and footer blocks', async () => {
  const srv = await fixtureServer({ '/jee': NTA_PAGE });
  try {
    const { items, errors } = await scrapeNta({
      pages: [{ url: `${srv.origin}/jee`, section: 'Public Notices', hints: ['jee'] }],
    });
    assert.deepEqual(errors, []);
    const titles = items.map((i) => i.title);

    assert.ok(titles.some((t) => t.startsWith('Inviting Online Application form')));
    assert.ok(titles.includes('Online Application Form for JEE (Main) 2027 – Session 1'));
    assert.ok(titles.includes('Declaration of Result of concerned Candidates'));

    // Navigation and footer links must not reach the feed.
    assert.ok(!titles.includes('Contact US'), 'helpdesk link leaked in');
    assert.ok(!titles.includes('Ministry Of Education'), 'additional-links leaked in');
    assert.ok(!titles.some((t) => t.includes('Sitemap')), 'footer link leaked in');
    assert.ok(!titles.includes('View All'), '"View All" button leaked in');

    // HTML entities are decoded.
    assert.ok(titles.some((t) => t.includes('– Reg.')), 'entities were not decoded');

    // Dates come from the table cell and from the document URL.
    const byTitle = Object.fromEntries(items.map((i) => [i.title, i]));
    assert.equal(byTitle['Declaration of Result of concerned Candidates'].publishedAt, '2025-07-14');
    assert.equal(
      items.find((i) => i.title.startsWith('Inviting Online')).publishedAt,
      '2026-10-24'
    );
    // Source hints are attached for the categoriser.
    assert.deepEqual(items[0].hints, ['jee']);
  } finally {
    await srv.close();
  }
});

test('NTA parser reports a layout change instead of failing silently', async () => {
  const srv = await fixtureServer({ '/empty': '<html><body><p>Site under maintenance</p></body></html>' });
  try {
    const { items, errors } = await scrapeNta({ pages: [{ url: `${srv.origin}/empty` }] });
    assert.equal(items.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /parsed 0 notices/);
  } finally {
    await srv.close();
  }
});

test('NTA parser does not report an error when a page only repeats known notices', async () => {
  const srv = await fixtureServer({ '/a': NTA_PAGE, '/b': NTA_PAGE });
  try {
    const { items, errors } = await scrapeNta({
      pages: [{ url: `${srv.origin}/a` }, { url: `${srv.origin}/b` }],
    });
    assert.deepEqual(errors, [], 'a fully duplicated page must not look like a parse failure');
    const ids = items.map((i) => `${i.title}|${i.url}`);
    assert.equal(new Set(ids).size, ids.length, 'duplicates were not removed');
  } finally {
    await srv.close();
  }
});

test('CBSE parser reads the Latest @ CBSE list', async () => {
  const srv = await fixtureServer({ '/cbse': CBSE_WITH_COMMENT });
  try {
    const { items, errors } = await scrapeCbse({
      pages: [{ url: `${srv.origin}/cbse`, section: 'Latest @ CBSE' }],
    });
    assert.deepEqual(errors, []);
    const titles = items.map((i) => i.title);

    // Commented-out rows stay out of the feed.
    assert.ok(!titles.some((t) => t.includes('expired')), 'a commented-out notice leaked in');

    // The file-size suffix is stripped from titles.
    assert.ok(titles.includes('Rerun of Second Cycle of NISHTHA Courses'), titles.join(' / '));

    // A trailing date inside the anchor text is stripped too.
    assert.ok(
      titles.includes('Latest Recruitment Updates – Click Here'),
      `date leaked into title: ${titles.join(' / ')}`
    );

    // Both anchors in a multi-link row become separate notices sharing the date.
    const aadhaar = items.find((i) => i.title === 'Aadhaar');
    assert.ok(aadhaar, 'the second link in a row was dropped');
    assert.equal(aadhaar.publishedAt, '2026-06-02');

    // Relative hrefs are resolved against the CBSE base URL.
    assert.ok(
      items.every((i) => i.url.startsWith('http')),
      'a relative href was not made absolute'
    );

    const dateSheet = items.find((i) => i.title.includes('Date Sheet'));
    assert.equal(dateSheet.publishedAt, '2026-10-05');
  } finally {
    await srv.close();
  }
});

test('a dead source yields an error rather than throwing', async () => {
  const { items, errors } = await scrapeNta({
    pages: [{ url: 'http://127.0.0.1:1/never-listening' }],
  });
  assert.equal(items.length, 0);
  assert.equal(errors.length, 1);
});

test('cheerio skips HTML comments, which is what keeps expired rows out', () => {
  const $ = cheerio.load('<ul class="list"><li>live</li><!-- <li>dead</li> --></ul>');
  assert.equal($('ul.list li').length, 1);
});

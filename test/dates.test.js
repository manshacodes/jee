import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dateFromDocumentUrl, parseLooseDate } from '../server/sources/nta.js';
import { inferMissingDates } from '../server/infer-dates.js';

test('derives the publication date from an S3WaaS document URL', () => {
  assert.equal(
    dateFromDocumentUrl('https://cdnbbsr.s3waas.gov.in/s3abc/uploads/2026/10/20261024390682350.pdf'),
    '2026-10-24'
  );
  assert.equal(dateFromDocumentUrl('https://x/uploads/2025/01/2025012056.pdf'), '2025-01-20');
});

test('falls back to the upload folder when the file name is irregular', () => {
  assert.equal(dateFromDocumentUrl('https://x/uploads/2026/07/notice-final.pdf'), '2026-07-01');
});

test('rejects impossible dates encoded in file names', () => {
  // Month 19 / day 44 would otherwise produce a silently wrong date.
  assert.equal(dateFromDocumentUrl('https://x/uploads/2026/07/20261944000000001.pdf'), '2026-07-01');
});

test('returns null when a URL carries no date at all', () => {
  assert.equal(dateFromDocumentUrl('https://neet.nta.nic.in/public-notices/'), null);
  assert.equal(dateFromDocumentUrl(''), null);
});

test('parses the date formats the boards actually publish', () => {
  assert.equal(parseLooseDate('07/10/2026'), '2026-10-07');
  assert.equal(parseLooseDate('7-10-26'), '2026-10-07');
  assert.equal(parseLooseDate('24th October, 2026'), '2026-10-24');
  assert.equal(parseLooseDate('24 Oct 2026'), '2026-10-24');
  assert.equal(parseLooseDate('no date here'), null);
  assert.equal(parseLooseDate(''), null);
});

test('undated rows inherit the date of the notice above them', () => {
  const items = [
    { publishedAt: '2026-10-20' },
    { publishedAt: null },
    { publishedAt: null },
    { publishedAt: '2026-10-10' },
  ];
  inferMissingDates(items);
  assert.equal(items[1].publishedAt, '2026-10-20');
  assert.equal(items[1].dateInferred, true);
  assert.equal(items[2].publishedAt, '2026-10-20');
  // A real date is never overwritten, and never marked as inferred.
  assert.equal(items[0].dateInferred, false);
  assert.equal(items[3].publishedAt, '2026-10-10');
});

test('an undated row at the top of the list inherits from below', () => {
  const items = [{ publishedAt: null }, { publishedAt: '2026-09-01' }];
  inferMissingDates(items);
  assert.equal(items[0].publishedAt, '2026-09-01');
  assert.equal(items[0].dateInferred, true);
});

test('a list with no dates at all is left undated', () => {
  const items = [{ publishedAt: null }, { publishedAt: null }];
  inferMissingDates(items);
  assert.equal(items[0].publishedAt, null);
  assert.equal(items[0].dateInferred, false);
});

test('an empty list is handled', () => {
  assert.deepEqual(inferMissingDates([]), []);
});

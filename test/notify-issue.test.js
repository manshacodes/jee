import { strict as assert } from 'node:assert';
import { createServer } from 'node:http';
import { afterEach, beforeEach, test } from 'node:test';

/**
 * Run against a stand-in for the GitHub REST API, so the request that would
 * reach github.com is asserted without creating anything.
 */
let server;
let received;
let notifyIssue;
let isConfigured;
let helpers;

beforeEach(async () => {
  received = [];
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      received.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (req.url.includes('/denied/')) {
        res.writeHead(403).end('{"message":"Resource not accessible by integration"}');
        return;
      }
      res.writeHead(201, { 'Content-Type': 'application/json' }).end(
        JSON.stringify({ number: 7, html_url: 'https://github.com/me/jee/issues/7' })
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  process.env.GITHUB_API_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.GITHUB_TOKEN = 'ghs_faketoken';
  process.env.GITHUB_REPOSITORY = 'me/jee';
  const mod = await import(`../server/notify-issue.js?t=${Date.now()}${Math.random()}`);
  ({ notifyIssue, isConfigured } = mod);
  helpers = mod.__test;
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.GITHUB_API_URL;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
});

const notice = (over = {}) => ({
  title: 'JEE (Main) 2027 Session 1 application form',
  url: 'https://jeemain.nta.nic.in/a.pdf',
  sourceLabel: 'NTA — JEE (Main)',
  categories: ['jee'],
  publishedAt: '2026-10-24',
  dateInferred: false,
  ...over,
});

test('opens an issue on the repo with the token Actions provides', async () => {
  const result = await notifyIssue([notice()], { siteUrl: 'https://me.github.io/jee/' });
  assert.equal(result.sent, true);
  assert.equal(result.number, 7);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].url, '/repos/me/jee/issues');
  assert.equal(received[0].headers.authorization, 'Bearer ghs_faketoken');
});

test('a single notice names itself in the issue title', () => {
  assert.match(helpers.summarise([notice()]), /^New JEE notice: JEE \(Main\) 2027/);
});

test('a batch is summarised by stream', () => {
  const title = helpers.summarise([
    notice({ categories: ['jee'] }),
    notice({ categories: ['class10', 'class12'] }),
  ]);
  assert.match(title, /^2 new JEE, Class 10, Class 12 notices$/);
});

test('"other" is not treated as a stream name', () => {
  assert.match(helpers.summarise([notice({ categories: ['other'] })]), /^New exam notice/);
});

test('the body links every notice and the site', () => {
  const text = helpers.body([notice(), notice({ title: 'Second', url: 'https://x/b.pdf' })], {
    siteUrl: 'https://me.github.io/jee/',
  });
  assert.match(text, /\[JEE \(Main\) 2027 Session 1 application form\]\(https:\/\/jeemain\.nta\.nic\.in\/a\.pdf\)/);
  assert.match(text, /\[Second\]\(https:\/\/x\/b\.pdf\)/);
  assert.match(text, /\[Open the full feed\]\(https:\/\/me\.github\.io\/jee\/\)/);
  assert.match(text, /2026-10-24/);
});

test('an inferred date is labelled as approximate', () => {
  assert.match(helpers.body([notice({ dateInferred: true })], {}), /around 2026-10-24/);
});

test('brackets in a scraped title cannot break the markdown link', () => {
  const text = helpers.body([notice({ title: 'Result [Class XII] out' })], {});
  assert.match(text, /\\\[Class XII\\\]/, 'brackets were not escaped');
});

test('a very long title is truncated to fit an issue title', async () => {
  await notifyIssue([notice({ title: 'x'.repeat(500) })], {});
  const sent = JSON.parse(received[0].body);
  assert.ok(sent.title.length <= 250);
});

test('nothing is sent without a token', async () => {
  delete process.env.GITHUB_TOKEN;
  const fresh = await import(`../server/notify-issue.js?t=${Date.now()}y`);
  const result = await fresh.notifyIssue([notice()], {});
  assert.equal(result.sent, false);
  assert.match(result.reason, /GITHUB_TOKEN/);
  assert.equal(received.length, 0);
  assert.equal(fresh.isConfigured(), false);
});

test('an empty batch sends nothing', async () => {
  const result = await notifyIssue([], {});
  assert.equal(result.sent, false);
  assert.equal(received.length, 0);
});

test('a refused request is reported, not thrown', async () => {
  process.env.GITHUB_REPOSITORY = 'denied/repo';
  const fresh = await import(`../server/notify-issue.js?t=${Date.now()}z`);
  const result = await fresh.notifyIssue([notice()], {});
  assert.equal(result.sent, false, 'a failed alert must not fail the scrape');
  assert.match(result.reason, /403/);
});

test('an unreachable API never throws', async () => {
  process.env.GITHUB_API_URL = 'http://127.0.0.1:1';
  const fresh = await import(`../server/notify-issue.js?t=${Date.now()}w`);
  const result = await fresh.notifyIssue([notice()], {});
  assert.equal(result.sent, false);
  assert.ok(result.reason);
});

test('isConfigured reflects the Actions environment', () => {
  assert.equal(isConfigured(), true);
});

test('the horizontal rule is separated, so it is not read as a heading', () => {
  const lines = helpers.body([notice()], { siteUrl: 'https://x/' }).split('\n');
  const rule = lines.indexOf('---');
  assert.notEqual(rule, -1, 'no horizontal rule in the body');
  // "text\n---" is a setext H2 in Markdown, which would swallow the last notice.
  assert.equal(lines[rule - 1], '', 'the rule would turn the line above into a heading');
  assert.equal(lines[rule + 1], '', 'the footer would be glued to the rule');
});

test('the notice list is separated from the intro', () => {
  const lines = helpers.body([notice()], {}).split('\n');
  assert.equal(lines[1], '', 'the list needs a blank line above it to render');
});

test('an uncategorised notice does not leave a double space', () => {
  const text = helpers.body([notice({ categories: ['other'] })], {});
  assert.ok(!text.includes('-  ['), 'double space before the link');
  assert.match(text, /^- \[/m);
});

test('the body still works with no site URL', () => {
  const text = helpers.body([notice()], {});
  assert.ok(!text.includes('Open the full feed'));
  assert.ok(!text.includes('undefined'));
  assert.match(text, /Posted automatically/);
});

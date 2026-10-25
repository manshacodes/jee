import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { categorize } from '../server/categorize.js';

test('routes JEE notices to the jee stream', () => {
  for (const title of [
    'Inviting Online Application form for the Joint Entrance Examination (JEE)-2027 (Session 1) – Reg.',
    'Final Answer Keys for JEE(Main) – 2026 Paper-II [B.Arch / B.Planning]',
    'Display of Provisional Answer Keys for JEE (Main) 2026 Session 2',
  ]) {
    assert.deepEqual(categorize(title), ['jee'], title);
  }
});

test('routes NEET notices to the neet stream', () => {
  for (const title of [
    'Notice on Fake, Altered, or AI-Generated NEET (UG) 2026 Documents',
    'List of Toppers of NEET(UG) – 2026 (Held on 21st June, 2026)',
    'National Eligibility cum Entrance Test (UG) – 2026 result',
  ]) {
    assert.deepEqual(categorize(title), ['neet'], title);
  }
});

test('separates Class X from Class XII', () => {
  assert.deepEqual(categorize('Date Sheet for Class X Board Examination 2027', { sourceId: 'cbse' }), [
    'class10',
  ]);
  assert.deepEqual(
    categorize('Date Sheet for Class XII : Special Examinations', { sourceId: 'cbse' }),
    ['class12']
  );
  // "Class 12" must not also match the Class 10 rule via a bare "1".
  assert.deepEqual(categorize('Practical Examinations for Class 12', { sourceId: 'cbse' }), [
    'class12',
  ]);
});

test('a notice naming both classes lands in both streams', () => {
  assert.deepEqual(
    categorize('Conduct of Examinations for Class X & XII - reg.', { sourceId: 'cbse' }),
    ['class10', 'class12']
  );
  assert.deepEqual(
    categorize('Registration of Candidates for Class 10 and 12', { sourceId: 'cbse' }),
    ['class10', 'class12']
  );
});

test('generic CBSE board notices cover both board streams', () => {
  // No class named, but unmistakably about the board exams.
  assert.deepEqual(categorize('Submission of LOC - Reg.', { sourceId: 'cbse' }), [
    'class10',
    'class12',
  ]);
  assert.deepEqual(categorize('Click here to download Admit Card', { sourceId: 'cbse' }), [
    'class10',
    'class12',
  ]);
});

test('the both-boards fallback does not apply to NTA sources', () => {
  // NTA does not run board exams, so a "syllabus" notice there is not a board notice.
  assert.deepEqual(categorize('Syllabus for the examination', { sourceId: 'nta-archive' }), ['other']);
});

test('source hints classify notices whose titles omit the exam name', () => {
  assert.deepEqual(categorize('Public Notice regarding city intimation slip', { hints: ['jee'] }), [
    'jee',
  ]);
});

test('unrelated notices fall back to other rather than being dropped', () => {
  for (const title of [
    'Message from Hon’ble President of India on the occasion of Teachers’ Day 2026',
    'Promotion of Digital Payments in schools -reg.',
    'Public Notice : Beware of Unscrupulous Callers',
  ]) {
    assert.deepEqual(categorize(title, { sourceId: 'cbse' }), ['other'], title);
  }
});

test('categories come back in a stable display order', () => {
  const result = categorize('JEE and NEET combined advisory for Class 12 students');
  assert.deepEqual(result, ['jee', 'neet', 'class12']);
});

test('never returns an empty list', () => {
  for (const input of ['', '   ', 'x']) {
    assert.ok(categorize(input).length > 0, JSON.stringify(input));
  }
});

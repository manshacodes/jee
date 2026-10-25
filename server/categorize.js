/**
 * Rule-based categorisation of a notification into exam streams.
 *
 * A notice may legitimately belong to more than one stream (a CBSE date-sheet
 * circular usually covers Class X and XII together), so this returns an array.
 * When nothing matches we fall back to ['other'] rather than dropping the
 * notice -- the user still wants to see it in the "All" feed.
 */

export const CATEGORIES = [
  { id: 'jee', label: 'JEE', icon: 'J', blurb: 'JEE Main / Advanced, NTA' },
  { id: 'neet', label: 'NEET UG', icon: 'N', blurb: 'NEET (UG), NTA' },
  { id: 'class10', label: 'Class 10', icon: 'X', blurb: 'CBSE Secondary' },
  { id: 'class12', label: 'Class 12', icon: 'XII', blurb: 'CBSE Senior Secondary' },
  { id: 'other', label: 'Other', icon: '*', blurb: 'Uncategorised notices' },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

// Each rule is tried against the lower-cased title (plus the source url, which
// often carries the stream, e.g. /document-category/neetug-2026-public-notices/).
const RULES = [
  {
    category: 'jee',
    patterns: [
      /\bjee\b/,
      /joint\s+entrance\s+examination/,
      /\bjee\s*\(?\s*main/,
      /\bb\.?\s?arch\b/,
      /\bb\.?\s?planning\b/,
      /\bjosaa\b/,
      /\bj\.?e\.?e\b/,
    ],
  },
  {
    category: 'neet',
    patterns: [
      /\bneet\b/,
      /neet\s*\(?\s*ug/,
      /national\s+eligibility\s+cum\s+entrance/,
      /\bmbbs\b/,
      /\bbds\b/,
      /\bmcc\b.*counsell/,
      /\bayush\b/,
    ],
  },
  {
    category: 'class10',
    patterns: [
      /class\s*(?:-|\s)?\s*(?:x|10)(?!\s*i)\b/,
      /\bsecondary\s+school\s+examination/,
      /\bsse\b/,
      /\bclass\s*10th\b/,
      /\b10th\s+board/,
      /\bx\s*(?:&|and|\/)\s*xii\b/,
      /\b10\s*(?:&|and|\/)\s*12\b/,
      /\bboth\s+the\s+classes\b/,
    ],
  },
  {
    category: 'class12',
    patterns: [
      /class\s*(?:-|\s)?\s?(?:xii|12)\b/,
      /\bsenior\s+school\s+(?:certificate\s+)?examination/,
      /\bssce\b/,
      /\bclass\s*12th\b/,
      /\b12th\s+board/,
      /\bx\s*(?:&|and|\/)\s*xii\b/,
      /\b10\s*(?:&|and|\/)\s*12\b/,
      /\bboth\s+the\s+classes\b/,
    ],
  },
];

// Notices that mention boards generically ("Board Examinations 2027") without
// naming a class apply to both Class X and XII.
const BOTH_BOARDS = [
  /\bboard\s+exam/,
  /\bdate\s*-?\s*sheet\b/,
  /\bpractical\s+exam/,
  /\bcompartment\s+exam/,
  /\bsupplementary\s+exam/,
  /\bresult.*board\b/,
  /\bregistration\s+of\s+candidates\b/,
  /\blist\s+of\s+candidates\b/,
  /\bloc\b/,                      // CBSE shorthand for List of Candidates
  /\badmit\s+card\b/,
  /\banswer\s+book/,
  /\bre-?evaluation\b/,
  /\bverification\s+of\s+marks\b/,
  /\bmigration\s+certificate\b/,
  /\bsyllabus\b/,
  /\bsample\s+question\s+paper/,
  /\bpractice\s+paper/,
];

/**
 * @param {string} title     notice headline
 * @param {object} [context] extra signals
 * @param {string} [context.url]         link target (document or landing page)
 * @param {string} [context.sourceId]    which scraper produced it
 * @param {string[]} [context.hints]     categories implied by the source section
 * @returns {string[]} one or more category ids, never empty
 */
export function categorize(title, context = {}) {
  const haystack = `${title || ''} ${context.url || ''}`.toLowerCase();
  const found = new Set(context.hints || []);

  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(haystack))) found.add(rule.category);
  }

  // A CBSE notice about "board examinations" with no explicit class belongs to
  // both board streams. Only applied for CBSE -- NTA never runs board exams.
  const isCbse = context.sourceId === 'cbse' || haystack.includes('cbse');
  if (isCbse && !found.has('class10') && !found.has('class12')) {
    if (BOTH_BOARDS.some((re) => re.test(haystack))) {
      found.add('class10');
      found.add('class12');
    }
  }

  found.delete('other');
  if (found.size === 0) return ['other'];

  // Keep a stable, display-friendly order.
  return CATEGORY_IDS.filter((id) => found.has(id));
}

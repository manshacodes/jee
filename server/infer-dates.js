/**
 * Fill in missing publication dates from list position.
 *
 * Both CBSE and the NTA portals list notices newest-first, but a minority of
 * rows carry no date at all (no date cell, and a document URL that does not
 * follow the /uploads/YYYY/MM/ convention). Treating those as "published now"
 * sorts stale notices above genuinely recent ones, and treating them as
 * undated buries newly published ones.
 *
 * Since the page order is itself chronological, an undated notice can inherit
 * the date of the nearest dated notice around it. We prefer the one above it
 * (the next-newer notice) and fall back to the one below, which places it in
 * the right neighbourhood without ever claiming a date the board did not
 * publish -- `dateInferred` records that, and the UI labels it accordingly.
 *
 * @param {Array<{publishedAt: string|null}>} items in document order
 */
export function inferMissingDates(items, { today = new Date() } = {}) {
  const n = items.length;
  if (n === 0) return items;

  // A publication date in the future cannot be right. jeeadv.ac.in stamps its
  // announcements with the exam-cycle year rather than the year they were
  // posted ("Posted on November 13, 2027" on a page read in 2026), and taking
  // that at face value pins those notices above everything else forever.
  // Treat such a date as unknown and let the inference below place it.
  const cutoff = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
  for (const item of items) {
    if (item.publishedAt && item.publishedAt > cutoff) item.publishedAt = null;
  }

  const above = new Array(n).fill(null);
  let carry = null;
  for (let i = 0; i < n; i += 1) {
    if (items[i].publishedAt) carry = items[i].publishedAt;
    above[i] = carry;
  }

  const below = new Array(n).fill(null);
  carry = null;
  for (let i = n - 1; i >= 0; i -= 1) {
    if (items[i].publishedAt) carry = items[i].publishedAt;
    below[i] = carry;
  }

  for (let i = 0; i < n; i += 1) {
    if (items[i].publishedAt) {
      items[i].dateInferred = false;
      continue;
    }
    const inherited = above[i] || below[i];
    if (inherited) {
      items[i].publishedAt = inherited;
      items[i].dateInferred = true;
    } else {
      items[i].dateInferred = false;
    }
  }

  return items;
}

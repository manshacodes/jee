import { categorize } from './categorize.js';
import { SOURCES, getSource } from './sources/index.js';
import { mergeNotices } from './store.js';
import { broadcastNewNotices } from './push.js';

/** Result of the most recent run, surfaced in the UI status bar. */
let lastRun = null;
let running = null;

export const getLastRun = () => lastRun;
export const isRunning = () => running !== null;

/**
 * Scrape every (or one) source, categorise, persist, and push what is new.
 *
 * Concurrent calls share a single run: the UI's "Fetch now" button pressed
 * while the scheduler is mid-fetch should not double-scrape the sites.
 *
 * @param {object}   [opts]
 * @param {string}   [opts.trigger]   'manual' | 'scheduled' | 'startup'
 * @param {string[]} [opts.sourceIds] limit to these sources
 */
export async function runIngest({ trigger = 'manual', sourceIds } = {}) {
  if (running) return running;
  running = doIngest({ trigger, sourceIds }).finally(() => {
    running = null;
  });
  return running;
}

async function doIngest({ trigger, sourceIds }) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const targets = sourceIds?.length ? sourceIds.map(getSource).filter(Boolean) : SOURCES;

  const scraped = [];
  const sourceReports = [];

  for (const source of targets) {
    const begun = Date.now();
    try {
      const { items, errors } = await source.scraper(source);
      for (const item of items) {
        scraped.push({
          ...item,
          sourceId: source.id,
          sourceLabel: source.label,
          categories: categorize(item.title, {
            url: item.url,
            sourceId: source.id,
            hints: item.hints,
          }),
        });
      }
      sourceReports.push({
        sourceId: source.id,
        label: source.label,
        ok: errors.length === 0,
        count: items.length,
        errors,
        ms: Date.now() - begun,
      });
    } catch (err) {
      // One dead site must not abort the whole run.
      sourceReports.push({
        sourceId: source.id,
        label: source.label,
        ok: false,
        count: 0,
        errors: [err.message],
        ms: Date.now() - begun,
      });
    }
  }

  const { added, total, firstRun } = await mergeNotices(scraped);

  let push = { sent: 0, pruned: 0 };
  if (added.length) {
    try {
      push = await broadcastNewNotices(added);
    } catch (err) {
      console.error(`[ingest] push broadcast failed: ${err.message}`);
    }
  }

  lastRun = {
    trigger,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    scraped: scraped.length,
    added: added.length,
    total,
    firstRun,
    push,
    sources: sourceReports,
  };

  console.log(
    `[ingest] ${trigger}: scraped ${scraped.length}, new ${added.length}, stored ${total} ` +
      `(${lastRun.durationMs}ms)` +
      (firstRun ? ' [first run - seeded as history, no push]' : '')
  );

  return { ...lastRun, addedNotices: added };
}

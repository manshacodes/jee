import { getSettings } from './store.js';
import { runIngest } from './ingest.js';

/**
 * Re-arming timer driven by the user's stored settings. Changing the interval
 * or flipping auto-fetch off takes effect immediately -- `reschedule()` is
 * called from the settings endpoint.
 */

let timer = null;
let nextRunAt = null;
let onRunComplete = () => {};

export const setRunListener = (fn) => {
  onRunComplete = fn;
};

export const getNextRunAt = () => nextRunAt;

function clear() {
  if (timer) clearTimeout(timer);
  timer = null;
  nextRunAt = null;
}

export async function reschedule() {
  clear();
  const { autoFetch, intervalMinutes } = await getSettings();
  if (!autoFetch) {
    console.log('[scheduler] auto-fetch is off; no run scheduled');
    return null;
  }

  const minutes = clampInterval(intervalMinutes);
  const delay = minutes * 60 * 1000;
  nextRunAt = new Date(Date.now() + delay).toISOString();

  // setTimeout (re-armed after each run) rather than setInterval, so a slow
  // scrape cannot stack overlapping runs.
  timer = setTimeout(async () => {
    try {
      const result = await runIngest({ trigger: 'scheduled' });
      onRunComplete(result);
    } catch (err) {
      console.error(`[scheduler] run failed: ${err.message}`);
    } finally {
      reschedule();
    }
  }, delay);
  timer.unref?.();

  console.log(`[scheduler] next automatic fetch in ${minutes} min (${nextRunAt})`);
  return nextRunAt;
}

export function clampInterval(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 30;
  return Math.min(1440, Math.max(1, Math.round(n)));
}

export function stopScheduler() {
  clear();
}

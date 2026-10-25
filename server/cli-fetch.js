#!/usr/bin/env node
/** One-shot scrape, for cron jobs or for checking the parsers by hand. */
import { initPush } from './push.js';
import { runIngest } from './ingest.js';

await initPush();
const result = await runIngest({ trigger: 'manual' });
for (const s of result.sources) {
  const status = s.ok ? 'ok ' : 'ERR';
  console.log(`  ${status} ${s.label.padEnd(28)} ${String(s.count).padStart(4)} notices  ${s.ms}ms`);
  s.errors.forEach((e) => console.log(`      - ${e}`));
}
console.log(`\nnew: ${result.added}, stored: ${result.total}`);

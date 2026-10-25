import { scrapeNta } from './nta.js';
import { scrapeCbse } from './cbse.js';

/**
 * Source registry. Pages are scraped in order and de-duplicated per source.
 *
 * `hints` pre-seed the categoriser for sections whose stream is implied by the
 * page rather than the notice title: a notice on jeemain.nta.nic.in concerns
 * JEE even when the headline never spells it out. The NTA archive deliberately
 * carries no hints -- it mixes every exam NTA runs, so the title must decide.
 */
export const SOURCES = [
  {
    id: 'nta-jee',
    label: 'NTA — JEE (Main)',
    homepage: 'https://jeemain.nta.nic.in/',
    scraper: scrapeNta,
    pages: [
      { url: 'https://jeemain.nta.nic.in/', section: 'Latest News', hints: ['jee'] },
      { url: 'https://jeemain.nta.nic.in/public-notices/', section: 'Public Notices', hints: ['jee'] },
      {
        url: 'https://jeemain.nta.nic.in/document-category/2026-public-notices/',
        section: 'Public Notices 2026',
        hints: ['jee'],
      },
    ],
  },
  {
    id: 'nta-neet',
    label: 'NTA — NEET (UG)',
    homepage: 'https://neet.nta.nic.in/',
    scraper: scrapeNta,
    pages: [
      { url: 'https://neet.nta.nic.in/', section: 'Latest News', hints: ['neet'] },
      { url: 'https://neet.nta.nic.in/public-notices/', section: 'Public Notices', hints: ['neet'] },
      {
        url: 'https://neet.nta.nic.in/document-category/neetug-2025-public-notices/',
        section: 'Public Notices archive',
        hints: ['neet'],
      },
    ],
  },
  {
    id: 'nta-archive',
    label: 'NTA — Notice Board Archive',
    homepage: 'https://nta.ac.in/NoticeBoardArchive',
    scraper: scrapeNta,
    pages: [
      { url: 'https://nta.ac.in/NoticeBoardArchive', section: 'Notice Board Archive', hints: [] },
    ],
  },
  {
    id: 'cbse',
    label: 'CBSE',
    homepage: 'https://www.cbse.gov.in/cbsenew/cbse.html',
    scraper: scrapeCbse,
    pages: [
      { url: 'https://www.cbse.gov.in/cbsenew/cbse.html', section: 'Latest @ CBSE', hints: [] },
    ],
  },
];

export const SOURCE_IDS = SOURCES.map((s) => s.id);
export const getSource = (id) => SOURCES.find((s) => s.id === id);

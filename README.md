# Exam Notice Radar

A self-hosted web app that watches the CBSE and NTA notice boards and shows
their notifications in one feed, auto-sorted into **JEE**, **NEET UG**,
**Class 10** and **Class 12**.

- Scrapes on a schedule you control, plus a manual **Fetch now** button.
- Auto-categorises each notice from its title, with a sidebar for focusing on
  one stream.
- Alerts your laptop or phone via Web Push the moment something new appears.
- Keeps every notice it has ever seen; new ones are pinned to the top.
- Light and dark themes.

## Quick start

```bash
npm install
npm start           # http://localhost:3000
```

The first run seeds the feed from all four sources (a few hundred notices) and
marks them as already-read history, so you don't get a notification storm on
day one. From then on, only genuinely new notices are flagged and pushed.

```bash
npm test            # 62 unit/integration tests
npm run fetch:once  # one-shot scrape, useful from cron or to check the parsers
```

## Sources

| Source | Pages scraped |
| --- | --- |
| NTA — JEE (Main) | `jeemain.nta.nic.in` home ticker, `/public-notices/`, 2026 notices category |
| NTA — NEET (UG) | `neet.nta.nic.in` home ticker, `/public-notices/`, notices archive |
| NTA — Notice Board Archive | `nta.ac.in/NoticeBoardArchive` |
| CBSE | `cbse.gov.in/cbsenew/cbse.html` — the "Latest @ CBSE" list |

All four are defined in [`server/sources/index.js`](server/sources/index.js);
add a page by appending to a source's `pages` array.

The NTA portals all run the same S3WaaS government WordPress template, so one
parser handles the three of them across its three layouts (`.gen-list`
listings, the `.newsticker` marquee, and `table.doc-table` archives). CBSE has
its own parser for its single hand-maintained list.

### On the NTA archive

`nta.ac.in` was **not reachable from the machine this was built on**, so its
parser is written against the same markup the other NTA pages serve (verified
against `neet.nta.nic.in/document-category/...`, which returns the identical
`table.doc-table` layout) but was never exercised against the live page. If it
comes back empty for you, the UI will say so in the source-health panel rather
than failing quietly.

That host has also historically served an **incomplete TLS chain**. If a fetch
fails with `unable to get local issuer certificate`, set:

```bash
INSECURE_TLS_HOSTS=nta.ac.in npm start
```

which disables chain verification for that host only. Everything else keeps
full verification.

## Categorisation

Each notice gets one or more of `jee`, `neet`, `class10`, `class12`, `other`,
decided in [`server/categorize.js`](server/categorize.js) from the title, the
document URL, and a hint from the page it came from (anything on
`jeemain.nta.nic.in` is about JEE even when the headline never says so).

A notice can land in several streams at once — a CBSE date sheet "for Class X &
XII" shows up under both — and a CBSE notice that is plainly about the boards
without naming a class (LOC submission, admit cards, re-evaluation) covers
both. Anything genuinely unrelated (teacher training, recruitment, public
advisories) goes to **Other** rather than being dropped, so the "All" feed
stays complete.

To tune it, edit the `RULES` and `BOTH_BOARDS` pattern lists and run
`npm test` — `test/categorize.test.js` pins the current behaviour.

## Dates

The boards are inconsistent about publication dates: CBSE prints one after each
link, the NTA pages usually encode it in the document URL
(`/uploads/2026/10/20261024...pdf` → 24 Oct 2026), and a minority of rows carry
no date at all.

Treating an undated row as "published today" would park stale notices
permanently at the top of the feed, so undated rows instead inherit the date of
the nearest dated notice around them — the listings are chronological, so list
position is a good proxy. Those are marked `dateInferred` and the UI labels
them "Around 5 Oct 2026" rather than claiming a date the board never published.

## Settings

All of it lives in the settings drawer and persists to `data/settings.json`:

- **Fetch on a schedule** — on/off. With it off, notices are only pulled when
  you press *Fetch now*.
- **How often** — 5 minutes to 24 hours from the dropdown, or any value from 1
  to 1440 minutes in the custom box. Changes take effect immediately, no
  restart.
- **Send push notifications** — on/off, plus per-category filters so you can be
  alerted about JEE only and still browse the rest.
- **Appearance** — light, dark, or follow the system.

Please be a considerate scraper: these are public services under real exam-season
load. A 15–30 minute interval is plenty for notice boards that change a few
times a day.

## Device alerts

Press **Enable device alerts** in the sidebar and allow notifications. A
service worker then delivers alerts even with the tab closed, including on
Android. A burst of notices collapses into one alert rather than stacking.

- Served over **HTTPS or `localhost`** — browsers refuse push on plain HTTP.
- On **iOS** the site must be added to the home screen first (Safari only
  permits push for installed web apps).
- VAPID keys are generated once into `data/vapid.json`. Set
  `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` instead if you run more than one
  instance or redeploy over `DATA_DIR`.

While the tab is open, the feed also updates live over server-sent events, with
no push permission needed.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/notifications` | Feed. Filters: `category`, `source`, `q`, `since`, `onlyNew`, `limit`, `offset` |
| `POST` | `/api/notifications/read` | Clear unread badges (`{ids: []}` clears all) |
| `POST` | `/api/fetch` | Scrape now; optional `{sourceIds: [...]}` |
| `GET` | `/api/status` | Run state, last run per source, next run, counts |
| `GET`/`PUT` | `/api/settings` | Read / update settings |
| `GET` | `/api/meta` | Categories, sources, interval choices, push key |
| `GET` | `/api/stream` | Server-sent events: `notices`, `ingest`, `settings`, `read` |
| `POST` | `/api/push/subscribe` · `/unsubscribe` | Manage a device |

## Layout

```
server/
  index.js          Express app, REST API, SSE stream
  ingest.js         scrape -> categorise -> store -> push, one source failing is survivable
  scheduler.js      re-arming timer driven by the user's interval setting
  store.js          JSON store: atomic writes, serialised, stable notice ids
  categorize.js     title/URL -> exam streams
  infer-dates.js    fills undated rows from list position
  fetcher.js        HTTP with retry/backoff and per-host TLS opt-out
  push.js           Web Push: VAPID, category filters, prunes dead devices
  sources/          source registry + the two parsers
public/             single-page UI, service worker, manifest, icons
test/               62 tests, parsers included (served from HTTP fixtures)
```

State is a handful of JSON files under `data/`, capped at 5000 notices. There
is no database to set up; `data/` is gitignored because it holds your settings,
your push subscriptions and the VAPID private key.

## Notes and limits

- **Scrapers break when sites change.** Each parser reports "parsed 0 notices"
  rather than silently emptying the feed, and the source-health panel in
  settings shows which source failed and why. `test/parsers.test.js` runs the
  parsers against fixtures of the real markup, so a layout change you patch for
  stays patched.
- **No authentication.** Anyone who can reach the port can change the fetch
  interval. Put it behind a reverse proxy or keep it on your own machine.
- **Always confirm against the official site** before acting on anything here.
  This is a convenience reader over four public notice boards, not an official
  channel; titles are reproduced as published and every notice links back to
  the board's own document.

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
npm test            # 143 unit/integration tests
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

`nta.ac.in` refuses connections from some networks, and was unreachable from
the machine this was built on. It **does** work from GitHub Actions, where the
scheduled run reads it normally — so if it comes back empty locally, that is
your network rather than the parser. The source-health panel in settings says
which sources failed and why, rather than failing quietly.

That host has also historically served an **incomplete TLS chain**. If a fetch
fails with `unable to get local issuer certificate`, set:

```bash
INSECURE_TLS_HOSTS=nta.ac.in npm start
```

which disables chain verification for that host only. Everything else keeps
full verification. In the workflow, set it as the repository variable
`INSECURE_TLS_HOSTS` instead.

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

## Deploying it

There are two shapes, and the free one is the default.

### Free: GitHub Actions + GitHub Pages (recommended)

No server, no card, nothing running at home. A scheduled workflow does the
scraping in GitHub's cloud, commits the feed, and publishes a static build of
the same UI to Pages. **Public repositories get unlimited Actions minutes and
free Pages hosting**, which is what makes this work.

1. **Settings → Pages → Source: GitHub Actions.**
2. **Actions → "Scrape notices and publish site" → Run workflow.** The first
   run seeds the feed and publishes the site.

Your site lands at `https://<user>.github.io/<repo>/`. That is the whole setup.

#### Hosting the page on Vercel instead (also free)

`vercel.json` is set up for this: import the repo and Vercel builds the same
static site and serves it at a nicer URL. Every time the scheduled run commits
new notices, Vercel redeploys automatically.

Note that Vercel serves the **built** site, not the Express app. Letting it run
the server looks like it works and does not: a serverless function is frozen
once it has replied, so the scheduler's timer never fires; its filesystem does
not survive a cold start, so the feed and any push subscriptions are lost; and
every cold start re-scrapes all four government sites from scratch. The
scraping belongs in the scheduled Actions run either way — Vercel just serves
the result.

You can run both Pages and Vercel from the same repo; they publish the same
build.

#### Alerts, with nothing to install

When a scrape finds something new it **opens an issue on this repo**, and
GitHub emails you about it, because you automatically watch repositories you
own. No app, no account anywhere else, no credentials — it uses the token
Actions already hands the workflow.

The issue lists each new notice with a direct link to the board's PDF, so the
email alone is usually enough. Open issues double as a read queue: close one
once you have dealt with it.

If the first email does not arrive, check
[notification settings](https://github.com/settings/notifications) — "Watching"
should have **Email** ticked. Set the repository variable `NOTIFY_ISSUE` to
`false` to turn the issues off.

#### Popup notifications, also free

For the Google-Calendar-style popup on your laptop or phone, open the site and
press **Turn on popup alerts** in the sidebar. It walks you through one short
setup and hands you two or three values to paste into the same Actions secrets
page. After that, popups arrive on their own.

Why the manual paste: sending a push does not need a server — it is one signed
request per device — but *remembering which devices to notify* normally does.
In a public repo that list cannot be committed, since anyone could read it and
push fake alerts to your phone. Actions secrets are private even on a public
repo, so that is where the list lives, and the only way to put something in a
secret is to paste it.

The VAPID key pair is generated in your browser with Web Crypto, so nothing has
to be installed. The first device generates it; later devices reuse the
published public key and only extend the device list.

**On iPhone and iPad**, Apple only allows web notifications once the site is on
your home screen: Share → *Add to Home Screen*, open it from there, then run the
setup. Android and desktop work directly.

**Once set up, the site does not need to be open** — not even the tab. The
browser keeps a small background listener that the push wakes. Your device does
need to be on and online, and on a Mac, Chrome has to be running rather than
fully quit.

**To check it worked**, there are two tests, because there are two things that
can be wrong. The setup dialog's **Send a test popup** button shows a
notification from the page itself, proving this device will display one at all
(permission, service worker, OS settings). That says nothing about whether the
secrets were pasted correctly — for that, go to Actions → *Scrape notices and
publish site* → **Run workflow**, tick **Send a test notification**, and run it. That sends a sample
alert to every channel you have configured and does no scraping. The run's log
names each channel and, if one is misconfigured, says why — a mistyped secret
shows up as "not valid JSON" rather than as silence. Without this there is no
feedback between finishing setup and the next real notice, which may be days.

#### More than one person, or a device on another computer

The setup remembers devices registered in *that browser*, so a second computer
or a second person would otherwise produce a value that silently replaces
everyone already registered. Open **Someone else's device is already
registered** in the dialog, paste the other device's value, and press Merge;
the output covers everything — what was pasted, every device registered in this
browser, and this one.

Note that **a GitHub secret cannot be read back** once saved, only replaced. So
the value to merge comes from the other person running the setup on their
device, not from the repository settings page. The usual shape is: they set up,
send you their value, you paste it into the merge box on your device, and you
replace the secret with the result.

**Forking does not give someone their own alerts.** Forks copy code, never
secrets, and a device registered on *your* site is locked to *your* signing
key — only your repository can push to it. On top of that, GitHub disables
scheduled workflows in forks by default, so a fork is not checking anything
until its owner enables Actions. Someone who wants their own copy has to
enable Actions and Pages on their fork and run the setup on *their* site,
which generates a fresh key pair. Otherwise, add their device to your
`PUSH_SUBSCRIPTIONS` and share the one deployment.

<details>
<summary>Optional: push alerts through ntfy instead</summary>

If you would rather have a phone push than an email, add a repository secret
`NTFY_TOPIC` set to a long, unguessable string (say `jee-notices-7f3a9c21`),
then install the [ntfy app](https://ntfy.sh) and subscribe to that topic.
Anyone who knows the topic can read your alerts and send you fake ones, so
treat it as a password rather than a name. Both channels can run at once.
</details>

The schedule is the `cron` in
[`.github/workflows/scrape.yml`](.github/workflows/scrape.yml) — `*/30 * * * *`
by default. GitHub queues scheduled jobs and runs them late under load, so
treat it as "about every half hour". Below ~15 minutes you are mostly
generating skipped runs.

**What the static build gives up.** With no server there is nothing to scrape
on demand or re-schedule from the page, so those controls are visible but
disabled and say where the job actually lives. *Reload* re-fetches the
published feed. Unread badges become per-device, derived from a high-water mark
in `localStorage` rather than shared state — which is arguably better, since
your phone and laptop each track what they have seen.

**Alerts in the static build** come from the scheduled run rather than from a
server holding subscriptions: a GitHub issue (which GitHub emails you), real
Web Push once you have pasted the setup values into Actions secrets, and
optionally ntfy. All three can run at once. Running the server locally instead
manages Web Push subscriptions itself, with no pasting.

### Paid: a real server

Only worth it if you want Web Push proper, on-demand scraping, or a private
feed. The scrapers run server-side (a browser cannot fetch these sites
cross-origin), and the scheduler and push sender need a process that stays up.
A `Dockerfile` is included, plus blueprints for two hosts.

**Set a password.** `APP_PASSWORD` turns on an HTTP Basic gate over the whole
app. Without it, anyone with the URL can read your feed and change your fetch
interval. It is optional on localhost and effectively required anywhere else —
the server warns on boot if it detects a hosting platform and no password.

**Generate VAPID keys and set them as environment variables:**

```bash
npx web-push generate-vapid-keys
```

Without them the app generates its own into `DATA_DIR` on first boot, which is
fine locally — but on a host without a persistent disk they are regenerated on
every deploy, silently breaking every phone and laptop subscription.

#### Host costs, as of early 2026

Neither has a usable free tier for this:

- **Render free sleeps a service after ~15 minutes without traffic.** A
  sleeping service runs no scheduled fetches and sends no notifications, which
  removes the point of it. Starter is $7/month.
- **Fly.io no longer has a free tier** (it ended for new organisations in
  October 2024). `shared-cpu-1x` with 512MB is roughly $3.19/month;
  `min_machines_running = 1` in the included `fly.toml` keeps it awake.

Check both pricing pages before relying on these numbers.

### Fly.io

```bash
fly launch --no-deploy --copy-config
fly secrets set APP_PASSWORD='pick-something-long'
fly secrets set VAPID_PUBLIC_KEY='...' VAPID_PRIVATE_KEY='...' VAPID_SUBJECT='mailto:you@example.com'
fly volumes create data --size 1
fly deploy
```

### Render

New → Blueprint → point it at this repo; [`render.yaml`](render.yaml) does the
rest. Render generates `APP_PASSWORD` for you — read it from the dashboard
under Environment. Paste the VAPID keys there too.

### Any Docker host

```bash
docker build -t exam-notice-radar .
docker run -d -p 3000:3000 \
  -v exam-notice-data:/app/data \
  -e APP_PASSWORD='pick-something-long' \
  -e VAPID_PUBLIC_KEY='...' -e VAPID_PRIVATE_KEY='...' \
  -e VAPID_SUBJECT='mailto:you@example.com' \
  exam-notice-radar
```

Serve it over **HTTPS**. Browsers refuse Web Push on plain HTTP (localhost is
the only exception), so phone alerts will not work without a certificate — all
three options above give you one automatically.

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
.github/workflows/  scheduled scrape + Pages publish (the free deployment)
scripts/
  ci-run.js         one scrape for Actions: commits state, alerts via ntfy
  build-static.js   bakes the feed into a static site for Pages
vercel.json         builds and serves the static site on Vercel
Dockerfile          production image; render.yaml / fly.toml are host blueprints
server/
  index.js          Express app, REST API, SSE stream
  auth.js           optional HTTP Basic gate for public deployments
  ingest.js         scrape -> categorise -> store -> push, one source failing is survivable
  scheduler.js      re-arming timer driven by the user's interval setting
  store.js          JSON store: atomic writes, serialised, stable notice ids
  categorize.js     title/URL -> exam streams
  infer-dates.js    fills undated rows from list position
  fetcher.js        HTTP with retry/backoff and per-host TLS opt-out
  push.js           Web Push: VAPID, category filters, prunes dead devices
  notify-issue.js   opens a GitHub issue per batch; GitHub emails you about it
  notify-webpush.js browser popups from CI, using devices held in a secret
  notify-ntfy.js    optional ntfy push, for anyone who prefers an app
  sources/          source registry + the two parsers
public/             single-page UI, service worker, manifest, icons
  js/push-setup.js  browser-side VAPID generation and device subscription
test/               143 tests, parsers included (served from HTTP fixtures)
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
- **Scraped content is treated as untrusted.** Notice titles, URLs and section
  names come from pages nobody here controls, so links are restricted to
  `http(s)` at parse time (a `javascript:` href never reaches the store) and
  every scraped value is HTML-escaped before it is rendered.
  `test/render.test.js` runs the real card template against injection payloads.
- **Always confirm against the official site** before acting on anything here.
  This is a convenience reader over four public notice boards, not an official
  channel; titles are reproduced as published and every notice links back to
  the board's own document.

# lurk pinger

A Cloudflare Worker that asks GitHub to run the scrape workflow every 30
minutes.

## Why this exists

GitHub deprioritises the `schedule` event on free public repositories and
drops most firings. Measured on this repo over 80 hours: **14 scheduled runs
delivered against 161 requested — about 9% — with gaps up to 10.7 hours**,
against a cron asking for every 30 minutes. Every run that started succeeded;
the rest never started.

Workflows started through the API are not throttled that way. Two dispatches
on this repo both began in the same second they were queued. So the schedule
moves to Cloudflare, and GitHub just gets told to run.

## Setting it up

### 1. Make a GitHub token

Go to **[Fine-grained tokens](https://github.com/settings/personal-access-tokens/new)**:

| Field | Value |
| --- | --- |
| Token name | `lurk pinger` |
| Expiration | **No expiration** |
| Repository access | **Only select repositories** → `jee` |
| Permissions → Repository → **Actions** | **Read and write** |

Leave every other permission alone. Scoped like this the token can start this
one repository's workflows and nothing else — it cannot read your other
secrets, change code, or touch another repo.

Generate it and copy it. You only see it once.

### 2. Deploy the Worker

```bash
cd pinger
npx wrangler login      # opens a browser, free account is fine
npx wrangler deploy
```

### 3. Give it the secrets

```bash
npx wrangler secret put GITHUB_TOKEN   # paste the token from step 1
npx wrangler secret put PING_KEY       # any long random string you invent
```

That is it. The cron starts on its own.

### 4. Optional: a lurk-now button for your phone

The Worker's own URL triggers a scrape on demand:

```
https://lurk-pinger.<your-subdomain>.workers.dev/?key=<your PING_KEY>
```

`wrangler deploy` prints the URL. Bookmark it with the key — one tap gets a
fresh check in about 40 seconds, without opening GitHub. The key stops a
passing crawler from spinning up the workflow.

## Checking it works

```bash
npx wrangler tail        # live logs; you should see a line every 30 minutes
```

Or just watch the site: **Last lurk** in the overview should never be more
than about half an hour old.

## When it breaks

The failure worth knowing about is a dead token, which otherwise goes
unnoticed for weeks. The Worker logs `GitHub refused the token` on a 401 or
403, and the site's **Last lurk** starts climbing — that is your monitor,
and it is the thing that surfaced this problem in the first place.

The GitHub schedule stays in the workflow as a backstop, so even with the
Worker switched off you are back to the old few-hours-at-best cadence rather
than nothing.

## Costs

Nothing. Cloudflare's free plan includes cron triggers and 100,000 requests a
day; this uses 48.

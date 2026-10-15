# Job Autopilot

Applies to jobs for you. A Chrome extension works through LinkedIn job search, applies with **Easy Apply**, and fills in the form when a job sends you to the **company's website** (Greenhouse, Lever, Workday, Ashby, or any other form). Answers come from your resume. When a site shows a **CAPTCHA or other bot check**, the bot stops and alerts you on the **dashboard** and with a desktop notification. Once you complete the check in that tab, it carries on by itself.

The dashboard (deployed on **Railway**, data in **Supabase**) shows how many applications went out, where, how, and with what result.

## How it works

```
 Your Chrome (logged in to LinkedIn)                Railway                       Supabase
┌──────────────────────────────────────┐   HTTPS   ┌─────────────────────────┐   ┌──────────────────────┐
│ extension/                           │ ───────▶ │ server/ (Node + Express) │──▶│ Postgres + Storage   │
│  linkedin.js  search → Easy Apply    │          │  /api/answers  rules →   │   │  profiles, resumes   │
│  ats.js       company-site forms     │          │     saved → LLM (batched)│   │  applications        │
│  captcha.js   detect → pause → alert │          │  /api/applications       │   │  verification_alerts │
│  filler.js    find fields, fill them │          │  /api/alerts, /api/stats │   │  question_answers    │
└──────────────────────────────────────┘          │  dashboard (public/)     │◀──│  Realtime → dashboard│
                                                   └─────────────────────────┘   └──────────────────────┘
```

**Why an extension and not a headless bot on Railway?** A server-side browser logging into LinkedIn from a datacenter IP gets flagged almost immediately. It would also need your LinkedIn password, and you could not solve a CAPTCHA on it without streaming the remote screen. The extension runs in your real browser with your existing session, so verification is just "switch to the tab and click". Railway hosts the brain (answers, analytics), not the browser.

### How a form gets answered

1. The extension collects every empty field on the page (label, type, options).
2. The server answers in tiers, cheapest first:
   - **Your corrected answers** from the dashboard.
   - **Rules** over your profile: name, email, phone, links, city, years of experience, work authorization, sponsorship, notice period, salary, EEO questions, consent boxes, and so on. Instant and free.
   - **Saved AI answers** from earlier applications.
   - **One batched AI call** for whatever is left.
3. Salary, date of birth, address and EEO answers are **never guessed by the AI**. If you have not filled them in, the field is left for you and the dashboard shows why.
4. Answers are matched to the site's exact options ("5+ years", "India (+91)", "I am not a protected veteran"…).

Most applications need zero or one AI call, and repeat questions are free.

## Which AI model, and what it costs

All three options below work. Switch by setting a different key; no code changes.

| Option | Model (default) | Cost | Notes |
|---|---|---|---|
| **Google Gemini** (free tier) | `gemini-flash-lite-latest` | $0 | Get a key at [AI Studio](https://aistudio.google.com/apikey). Free-tier limits are per project and change often; check your AI Studio console. Google's terms allow it to use free-tier prompts to improve its products, and your resume is personal data. |
| **Groq** (free tier) | `openai/gpt-oss-120b` | $0 | Get a key at [console.groq.com](https://console.groq.com/keys). Rate limited per model. |
| **Anthropic Claude** (paid) | `claude-haiku-5-5` | $0.10 / $0.50 per million input / output tokens | The most accurate at following the "pick exactly one option" rules. Uses structured outputs, so replies always match the schema. |

**Rough Claude Haiku 5.5 cost:** one answer call is about 3,000 input + 200 output tokens, roughly $0.0004. A resume parse is about $0.002. 1,000 applications where about 40% need the AI comes to about **$0.20**. The dashboard's *AI usage* card shows real token counts and an estimate.

**Recommendation:** start free with Gemini. If you see wrong answers in *Saved answers*, set `ANTHROPIC_API_KEY` instead; the cost stays well under a dollar a month. Any OpenAI-compatible endpoint also works (OpenRouter, DeepSeek, a local Ollama) via `LLM_PROVIDER=openai_compatible`.

Hosting: Supabase's free plan covers this app. Railway bills by usage on a small monthly plan; check [railway.com/pricing](https://railway.com/pricing).

## Setup

### 1. Supabase

1. Create a project at [supabase.com](https://supabase.com).
2. **Project Settings → API Keys**: copy the project URL, the publishable key (`sb_publishable_…` or the legacy `anon` key) and the secret key (`sb_secret_…` or the legacy `service_role` key). Keep the secret key secret; it only goes into Railway.
3. **Connect → Connection string → Session pooler**: copy the URL (port 5432) and your database password. Railway uses them to create the tables for you on every deploy (see below). The direct `db.<ref>.supabase.co` address needs IPv6, which Railway doesn't have, so use the session pooler.

### 2. Railway

1. **New Project → Deploy from GitHub repo** and pick this repo. In the service's **Settings**, set:
   - **Build → Dockerfile path:** `Dockerfile` (the app lives in `server/`, so Railway's auto-detect builder can't find it)
   - **Deploy → Pre-deploy command:** `node src/migrate.js` (sets up the database, see below)
   - **Deploy → Healthcheck path:** `/api/health`

   Railway no longer reads `railway.json` for new services, so these live in the service settings.
2. Under **Variables**, add the values from [`server/.env.example`](server/.env.example): `SUPABASE_URL`, `SUPABASE_ANON_KEY` (publishable key), `SUPABASE_SERVICE_ROLE_KEY` (secret key), `DATABASE_URL` + `DATABASE_PASSWORD`, plus one AI key (`GEMINI_API_KEY`, `GROQ_API_KEY` or `ANTHROPIC_API_KEY`).
   - **The database sets itself up.** Before each deploy Railway runs `node src/migrate.js` (the pre-deploy command). It applies every file in [`supabase/migrations/`](supabase/migrations) that hasn't run yet: tables, row-level security, Realtime and the private `resumes` storage bucket. It records what ran in `app_private.schema_migrations`. If a migration fails, the deploy stops and the previous version keeps running; the error is in the deploy logs.
   - Without `DATABASE_URL` the step is skipped. Then run [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql) once in Supabase's **SQL Editor** instead. It is safe to run both ways.
3. **Settings → Networking → Generate Domain**.
4. Back in Supabase, set **Authentication → URL Configuration → Site URL** to that domain so email confirmation links come back to your dashboard.

### 3. Dashboard

1. Open your Railway URL and create an account.
2. **Profile & resume**: upload your resume PDF. Review what the AI extracted, then fill in **Application answers** (work authorization, notice period, salary, EEO choices). Save.
3. **Bot settings**: search keywords and location, daily limit, title filters, and whether to submit automatically or stop for your review.
4. **Bot settings → Create extension token** and copy it.

### 4. Chrome extension

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick the [`extension/`](extension) folder.
2. In the options page that opens, paste your Railway URL and the token, then click **Save & test**.
3. Log in to LinkedIn in the same browser.

### 5. Use it

- **Start auto-apply on LinkedIn** (toolbar popup): opens your search and goes job by job. External "Apply" jobs open in a new tab, are filled in, and are submitted if you allowed it. Otherwise the bot waits for you to review and submit.
- **Autofill this page** (toolbar popup): on any job site (Naukri, Indeed, a company careers page), open the application form and click it. The bot fills the form and you submit.
- **Stop** any time from the popup or the on-page panel.

## When a site asks "are you human?"

`extension/content/captcha.js` recognises reCAPTCHA, hCaptcha, Cloudflare Turnstile and interstitials, Arkose (LinkedIn's puzzle), LinkedIn security checkpoints, and sign-in walls. When one appears:

1. The bot waits a few seconds, because managed challenges often clear on their own.
2. If it is still there, the bot **pauses** and raises an alert. A desktop notification appears (click it to jump to the tab), the extension badge shows **!**, and the dashboard shows a banner in real time (Supabase Realtime, with polling as a fallback). The application is marked *Needs verification*.
3. You solve it in that tab. The bot notices it is gone, resolves the alert and continues filling fields.

The extension never tries to solve or bypass a challenge.

## Dashboard

- **Overview**: applications submitted (per day, by method: LinkedIn Easy Apply, company site, assisted), success rate, verifications waiting on you, outcomes, hiring platforms, top companies, and AI usage and cost. Every chart has a table view.
- **Applications**: every job the bot touched, with status, failure reason, platform and link. Filter by status or method, and search.
- **Saved answers**: every screening question the AI answered. Fix any answer here and the bot uses your version from then on.

## Local development

```bash
cd server
cp .env.example .env      # fill in Supabase + one AI key
npm install
npm run migrate           # create/update the database tables (needs DATABASE_URL)
npm run dev               # http://localhost:3000
npm test                  # unit tests: answer engine, option matching, stats, LLM clients
```

End-to-end test of the extension (needs Chromium; uses mock pages for LinkedIn and a company form with a fake hCaptcha):

```bash
cd extension/test
npm install
npm test
```

## Limits and risks

- **LinkedIn's User Agreement prohibits bots and automated tools on its site.** Using this can get your account restricted. The defaults are conservative: it runs in your own browser, has a daily cap (40), and pauses randomly between actions. Keep the cap modest, and use it at your own risk.
- **Sites change their markup.** LinkedIn selectors live at the top of `extension/content/linkedin.js`. The end-to-end test runs against a LinkedIn test double, not the live site, so expect to adjust selectors when LinkedIn ships changes.
- **Account-based ATSs** (Workday, Taleo, SuccessFactors) need you to sign in or create an account; the bot pauses for that like a CAPTCHA.
- **Check what it says on your behalf.** Review *Saved answers* early on. External-site auto-submit is off by default, so you review before anything is sent.
- **Quality beats volume.** Use the title include/exclude filters and company block list so it applies only to jobs you would actually take.

## Project layout

```
supabase/migrations/0001_init.sql   tables, RLS, realtime, storage bucket (applied by server/src/migrate.js)
server/
  src/index.js                      Express app (API + dashboard)
  src/answers.js                    rules → saved → batched LLM answer engine
  src/llm/                          Gemini / Groq / OpenAI-compatible + Anthropic clients
  src/resume.js                     PDF → text → structured profile
  src/stats.js                      dashboard aggregations
  src/routes/api.js                 REST endpoints
  public/                           dashboard (HTML + Chart.js + Supabase JS)
  test/                             node:test unit tests
extension/
  manifest.json, background.js      MV3 service worker: API, tab tracking, notifications
  content/dom.js, filler.js         field discovery and filling
  content/captcha.js                verification detection and pause
  content/linkedin.js               LinkedIn search + Easy Apply driver
  content/ats.js                    company-site form driver
  popup.*, options.*                toolbar popup and connection settings
  test/                             Playwright end-to-end test + fixtures
Dockerfile                          Railway deployment (see Setup → Railway for the service settings)
```

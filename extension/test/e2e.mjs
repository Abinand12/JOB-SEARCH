// End-to-end test: loads the real extension into Chromium and drives it against
// a mock API (using the real server answer engine with a fake LLM), a fake
// company application form with a fake hCaptcha, and a LinkedIn test double.
//
//   cd extension/test && npm install && npm test
//
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { answerFields } from '../../server/src/answers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionDir = path.resolve(here, '..');
const fixture = (name) => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
const TOKEN = 'jap_test_token';

const profile = {
  personal: { first_name: 'Asha', last_name: 'Menon', email: 'asha@example.com', phone: '+91 98765 43210', city: 'Kochi', country: 'India', linkedin_url: 'https://linkedin.com/in/asha' },
  total_years_experience: 5,
  skills: [{ name: 'Python', years: 4 }],
  preferences: { requires_sponsorship: false, gender: 'Prefer not to say' },
};
const settings = {
  daily_limit: 10, search_keywords: 'engineer', search_location: '', easy_apply_only: false, apply_external: true,
  auto_submit_easy_apply: true, auto_submit_external: true, auto_accept_consent: true,
  title_include: [], title_exclude: ['intern'], company_blacklist: [], min_delay_sec: 0.2, max_delay_sec: 0.4,
};
const fakeLlm = {
  async generateJson({ user }) {
    const questions = JSON.parse(user.slice(user.indexOf('['), user.lastIndexOf(']') + 1));
    return {
      data: { answers: questions.map((q) => ({ id: q.id, answer: /how many years/i.test(q.question) ? '0' : `Answer: ${q.question}`, confidence: 'medium' })) },
      usage: { inputTokens: 100, outputTokens: 20 },
    };
  },
};

// --- mock API + fixture server ----------------------------------------------
const log = { applications: [], patches: [], alerts: [], alertPatches: [], submitted: [], badAuth: 0 };
let nextId = 1;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw ? JSON.parse(raw) : null));
  });
  const json = (status, data) => {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(data));
  };

  if (url.pathname === '/apply') {
    let html = fixture('company-apply.html');
    if (url.searchParams.get('job')) html = html.replace(/<div id="captcha">[\s\S]*?<\/div>/, '');
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(html);
  }
  if (url.pathname.startsWith('/fake/hcaptcha.com/')) {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<p style="font:14px system-ui">☐ I am human</p>');
  }
  if (url.pathname === '/submitted') {
    log.submitted.push(body);
    return json(200, { ok: true });
  }
  if (!url.pathname.startsWith('/api/')) return json(404, {});
  if (req.headers['x-extension-token'] !== TOKEN) {
    log.badAuth += 1;
    return json(401, { error: 'bad token' });
  }

  const route = `${req.method} ${url.pathname.replace(/\/[^/]+-\d+$/, '/:id')}`;
  switch (route) {
    case 'GET /api/session':
      return json(200, { settings, submitted_today: 0, has_resume: true, name: 'Asha Menon' });
    case 'POST /api/answers': {
      const result = await answerFields({ fields: body.fields, job: body.job, profile, settings, llm: fakeLlm });
      return json(200, { answers: result.answers, missing: result.missing, llm_count: result.llmCount });
    }
    case 'POST /api/applications': {
      const application = { id: `app-${nextId++}`, ...body };
      log.applications.push(application);
      return json(201, { application, already_applied: false });
    }
    case 'PATCH /api/applications/:id':
      log.patches.push({ id: url.pathname.split('/').pop(), ...body });
      return json(200, { application: {} });
    case 'POST /api/alerts': {
      const alert = { id: `alert-${nextId++}`, ...body };
      log.alerts.push(alert);
      return json(201, { alert });
    }
    case 'PATCH /api/alerts/:id':
      log.alertPatches.push({ id: url.pathname.split('/').pop(), ...body });
      return json(200, { alert: {} });
    case 'GET /api/resume/file':
      res.writeHead(200, { 'content-type': 'application/pdf', 'x-filename': 'Asha_Menon_Resume.pdf' });
      return res.end(Buffer.from('%PDF-1.4\n% test resume\n%%EOF\n'));
    default:
      return json(404, { error: `no route ${route}` });
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const waitUntil = async (fn, what, timeout = 45_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for: ${what}\n${JSON.stringify(log, null, 1)}`);
};

// --- browser ------------------------------------------------------------------
const context = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: process.env.HEADED !== '1',
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});
const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
await worker.evaluate(({ serverUrl, token }) => chrome.storage.local.set({ serverUrl, token }), { serverUrl: base, token: TOKEN });
for (const p of context.pages()) if (p.url().startsWith('chrome-extension://')) await p.close(); // options page opened on install

let failures = 0;
async function scenario(name, fn) {
  const started = Date.now();
  try {
    await fn();
    console.log(`ok - ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  } catch (error) {
    failures += 1;
    console.log(`not ok - ${name}\n${error.stack}`);
  }
}

await scenario('company form: pauses for CAPTCHA, then fills and submits', async () => {
  const page = await context.newPage();
  await page.goto('about:blank');
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'about:blank' }))[0].id);
  await worker.evaluate(
    ({ tabId }) =>
      chrome.storage.session.set({
        atsTabs: { [tabId]: { mode: 'linkedin', applicationId: 'app-900', job: { title: 'Backend Engineer', company: 'Acme', url: 'https://example.test/job' } } },
      }),
    { tabId },
  );
  await page.goto(`${base}/apply`);

  await waitUntil(() => log.alerts.length === 1, 'verification alert');
  assert.equal(log.alerts[0].kind, 'hcaptcha');
  assert.equal(log.alerts[0].application_id, 'app-900');
  assert.equal(log.submitted.length, 0, 'must not submit while the CAPTCHA is showing');

  await page.evaluate(() => document.getElementById('captcha').remove()); // the human solved it
  await waitUntil(() => log.alertPatches.some((p) => p.status === 'resolved'), 'alert resolved');
  await waitUntil(() => log.submitted.length === 1, 'form submitted');

  const data = log.submitted[0];
  assert.equal(data.first_name, 'Asha');
  assert.equal(data.last_name, 'Menon');
  assert.equal(data.email, 'asha@example.com');
  assert.equal(data.phone, '+91 98765 43210');
  assert.equal(data.linkedin, 'https://linkedin.com/in/asha');
  assert.equal(data['cards[python]'], '4');
  assert.equal(data.sponsor, 'no');
  assert.equal(data.gender, 'Decline to self-identify');
  assert.match(data.why, /^Answer: Why do you want to work at Acme/);
  assert.match(data.resume, /^file:Asha_Menon_Resume\.pdf:\d+$/);
  assert.equal(data.consent, true);
  assert.equal(data.sms, false);

  await waitUntil(() => log.patches.some((p) => p.id === 'app-900' && p.status === 'submitted'), 'application marked submitted');
  const patch = log.patches.find((p) => p.id === 'app-900' && p.status === 'submitted');
  assert.ok(patch.questions_answered >= 10, `questions_answered=${patch.questions_answered}`);
  assert.equal(patch.llm_answers, 2); // only the two free-text questions needed the AI
  if (!page.isClosed()) await page.close();
});

await scenario('LinkedIn: Easy Apply, external apply, title filter', async () => {
  const companyUrl = `${base}/apply`;
  await context.route('https://www.linkedin.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: fixture('linkedin-search.html').replace('<script>', `<script>window.COMPANY_URL=${JSON.stringify(companyUrl)};`),
    }),
  );
  const page = await context.newPage();
  await page.goto('about:blank');
  const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'about:blank' }))[0].id);
  await worker.evaluate(({ tabId }) => chrome.storage.session.set({ running: true, linkedinTabId: tabId }), { tabId });
  await page.goto('https://www.linkedin.com/jobs/search/?keywords=engineer');

  await waitUntil(() => worker.evaluate(async () => !(await chrome.storage.session.get('running')).running), 'run finished', 90_000);

  const easy = log.applications.find((a) => a.job_title === 'Backend Engineer' && a.method === 'easy_apply');
  assert.ok(easy, 'Easy Apply application recorded');
  assert.equal(easy.company, 'Globex');
  assert.equal(easy.job_url, 'https://www.linkedin.com/jobs/view/101/');
  assert.ok(log.patches.some((p) => p.id === easy.id && p.status === 'submitted'), 'Easy Apply submitted');
  const sent = (await page.evaluate(() => window.SUBMITTED ?? [])).find((s) => s.id === '101');
  assert.equal(sent.answers.phone, '+91 98765 43210');
  assert.equal(sent.answers['commute-yes'], true);
  assert.equal(sent.answers.k8s, '0');
  assert.equal(sent.answers['follow-company-checkbox'], false, 'unfollows the company');

  const external = log.applications.find((a) => a.job_title === 'Data Engineer');
  assert.equal(external.method, 'external_autofill');
  assert.ok(log.patches.some((p) => p.id === external.id && p.status === 'submitted'), 'external application submitted');
  assert.equal(log.submitted.length, 2, 'company form submitted for the external job');

  assert.ok(!log.applications.some((a) => /intern/i.test(a.job_title)), 'intern job filtered out');
  assert.equal(log.badAuth, 0);
});

await context.close();
server.close();
console.log(failures ? `\n${failures} scenario(s) failed` : '\nall scenarios passed');
process.exit(failures ? 1 : 0);

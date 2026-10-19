// Drives LinkedIn job search: opens each job, applies with Easy Apply, or hands
// external "Apply" jobs to the company site tab (content/ats.js).
//
// LinkedIn runs two job-search designs at once (rolled out per account in 2026):
//   classic  /jobs/search/          li[data-occludable-job-id] cards, BEM classes
//   new      /jobs/search-results/  div[role=button][componentkey=job-card-component-ref-<id>]
//                                   cards, hashed classes, data-testid/aria hooks only
// and three Easy Apply containers: the classic modal, the same modal inside the open
// shadow root of #interop-outlet, and a native <dialog data-testid="dialog">.
// Selectors prefer ids, aria-labels and data attributes; classes are only a first try.
//
// Account safety (LinkedIn's terms forbid automation; see README):
//   - nothing is injected into LinkedIn pages; status goes to the extension popup
//   - LinkedIn's daily-limit or "applying too fast" notices stop the run and start a cooldown
//   - a LinkedIn security check stops the run after you clear it
//   - the bot only acts while the LinkedIn tab is visible, with human-scale pauses
(() => {
  const JA = globalThis.JA;
  if (window.top !== window || JA.linkedinLoaded) return;
  JA.linkedinLoaded = true;

  const CLASSIC = {
    cardLink: 'a.job-card-container__link, a.job-card-list__title--link, a.job-card-list__title, a[href*="/jobs/view/"]',
    cardTitle: '.job-card-list__title--link, .job-card-container__link, .artdeco-entity-lockup__title, .job-card-list__title',
    cardCompany: '.artdeco-entity-lockup__subtitle, .job-card-container__primary-description',
    cardLocation: '.job-card-container__metadata-item, .job-card-container__metadata-wrapper li',
    title: '.job-details-jobs-unified-top-card__job-title h1, .job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title',
    company: '.job-details-jobs-unified-top-card__company-name a, .job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name',
    location: '.job-details-jobs-unified-top-card__tertiary-description-container, .job-details-jobs-unified-top-card__primary-description-container, .jobs-unified-top-card__bullet',
    topCard: '.job-details-jobs-unified-top-card__container--two-pane, .jobs-unified-top-card, .job-details-jobs-unified-top-card',
  };
  const CARD = 'div[role="button"][componentkey^="job-card-component-ref-"], li[data-occludable-job-id], div.job-card-container[data-job-id]';
  const NEW_TOP_CARD = '[data-sdui-component*="JobDetailsTopCard"]';
  const DESCRIPTION = '#job-details, .jobs-description__content, .jobs-box__html-content, [componentkey^="JobDetails_AboutTheJob_"], [data-sdui-component$=".aboutTheJob"]';
  // Places where "Easy Apply" text or apply links appear but are not this job's control.
  const NOT_THIS_JOB = '[componentkey^="job-card-component-"], li[data-occludable-job-id], [role="radiogroup"], [role="toolbar"], [id^="JobDetailsSimilarJobsSlot"], [data-view-name*="similar-jobs"], dialog, [role="dialog"]';
  const DIALOGS = 'dialog[open], [role="dialog"], [role="alertdialog"], .artdeco-modal';
  const NOTICES = `${DIALOGS}, [role="alert"], .artdeco-toast-item, .artdeco-inline-feedback`;
  const NEXT_PAGE =
    'button[aria-label="View next page"], .jobs-search-pagination__button--next, [data-testid="pagination-controls-next-button-visible"], [data-testid^="pagination-indicator-"], button[aria-label^="Page "], li[data-test-pagination-page-btn]';

  // LinkedIn's own limits. Never retry around these.
  const DAILY_LIMIT = /reached today.?s easy apply limit|exceeded the daily application limit|continue applying tomorrow|limit daily submissions|great effort applying today/i;
  const THROTTLE = /applying at a fast pace|briefly paused easy apply|safeguard against automated|applying to (too )?many jobs/i;
  const SUCCESS = /your application was sent|application sent|application submitted/i;

  // Minimum pause between applications, whatever the settings say.
  const MIN_GAP_SEC = 20;

  class StopRun extends Error {
    constructor(reason, cooldownHours = 0) {
      super(reason);
      this.cooldownHours = cooldownHours;
    }
  }

  let running = false;
  let stopRequested = false;
  let settings = null;
  let searchQueries = [''];
  let externalWaiter = null;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'linkedin:start') {
      start();
      sendResponse({ ok: true });
    } else if (msg.type === 'linkedin:stop') {
      stopRequested = true;
      status('Stopping after the current step…');
      sendResponse({ ok: true });
    } else if (msg.type === 'external:opened' || msg.type === 'external:done') {
      externalWaiter?.(msg);
      sendResponse({ ok: true });
    } else if (msg.type === 'linkedin:diagnose') {
      sendResponse(diagnose());
    }
  });

  // Resume after page navigations (pagination, security checkpoint) while a run is active.
  JA.send({ type: 'state:get' })
    .then((s) => {
      if (!JA.detectVerification()) JA.send({ type: 'verification:tab-clear' }).catch(() => {});
      if (s?.running && s.isBotTab) start();
    })
    .catch(() => {});

  const status = (text, tone = 'info') => JA.panel.show(text, { tone });

  // ---------------------------------------------------------------------------
  // Run loop
  // ---------------------------------------------------------------------------

  function searchUrl(s, keywords, startAt = 0) {
    const url = new URL('https://www.linkedin.com/jobs/search/');
    if (keywords) url.searchParams.set('keywords', keywords);
    if (s.search_location) url.searchParams.set('location', s.search_location);
    if (s.easy_apply_only) url.searchParams.set('f_AL', 'true');
    url.searchParams.set('sortBy', 'DD');
    if (startAt) url.searchParams.set('start', String(startAt));
    return url.toString();
  }

  const isJobSearchPage = () => /^\/jobs\/(search|search-results|collections)\b/.test(location.pathname);

  async function stop(reason, cooldownHours = 0) {
    running = false;
    await JA.send({ type: 'linkedin:finished', reason, cooldownHours }).catch(() => {});
  }

  // LinkedIn does not render job details in background tabs, so only act while visible.
  async function whileVisible() {
    if (!document.hidden) return;
    status('Paused: keep the LinkedIn tab in front. LinkedIn does not load jobs in background tabs.', 'warning');
    await new Promise((resolve) => {
      const onChange = () => {
        if (document.hidden) return;
        document.removeEventListener('visibilitychange', onChange);
        resolve();
      };
      document.addEventListener('visibilitychange', onChange);
    });
  }

  // Human-scale, uneven pauses: mostly near the minimum, sometimes much longer.
  const pause = (minSec, maxSec) => JA.sleep((minSec + (maxSec - minSec) * Math.random() ** 1.5) * 1000);

  async function start() {
    if (running) return;
    running = true;
    stopRequested = false;
    try {
      const session = await JA.api('GET', '/session');
      settings = session.settings;
      searchQueries = session.search_queries?.length ? session.search_queries : [''];
      if (!session.has_resume) return await stop('Upload your resume in the dashboard first.');
      await securityGate(null);
      const { searchQueryIndex = 0 } = await chrome.storage.local.get('searchQueryIndex');
      if (!isJobSearchPage()) {
        location.href = searchUrl(settings, searchQueries[searchQueryIndex] ?? searchQueries[0]);
        return; // the script starts again on the search page
      }

      let submittedToday = session.submitted_today;
      const seen = await loadSeen();
      const progress = () => status(`Running. ${submittedToday} of ${settings.daily_limit} applications sent today.`);
      progress();

      await JA.waitFor(() => collectCards().length || noResults(), { timeout: 15_000 });
      for (;;) {
        const pending = collectCards().filter((c) => !seen.has(c.id));
        if (!pending.length) break;

        for (const card of pending) {
          if (stopRequested) throw new StopRun('Stopped by you');
          if (submittedToday >= settings.daily_limit) throw new StopRun(`Daily limit of ${settings.daily_limit} reached. Start again tomorrow.`);
          if (seen.has(card.id)) continue;
          seen.add(card.id);
          await saveSeen(seen);
          await whileVisible();

          let outcome;
          try {
            outcome = await processCard(card);
          } catch (error) {
            if (error instanceof StopRun) throw error;
            console.warn('[Job Autopilot]', error);
            outcome = 'error';
          }
          if (outcome === 'submitted') submittedToday += 1;
          progress();
          if (outcome === 'skip') await pause(2, 5);
          else {
            // min_gap_override exists only for the automated tests; the real API strips it.
            const floor = Number.isFinite(settings.min_gap_override) ? settings.min_gap_override : MIN_GAP_SEC;
            await pause(Math.max(floor, settings.min_delay_sec), Math.max(floor, settings.max_delay_sec));
          }
        }
      }

      const next = nextPageUrl();
      if (next) {
        location.href = next;
        return;
      }
      // This search is used up: move on to the next role that fits the resume.
      const nextIndex = searchQueryIndex + 1;
      if (nextIndex >= searchQueries.length) throw new StopRun('No more jobs in these searches. Done!');
      await chrome.storage.local.set({ searchQueryIndex: nextIndex });
      status(`Now searching for "${searchQueries[nextIndex]}"…`);
      location.href = searchUrl(settings, searchQueries[nextIndex]);
    } catch (error) {
      if (error instanceof StopRun) {
        status(error.message, error.cooldownHours ? 'error' : 'success');
        await stop(error.message, error.cooldownHours);
      } else {
        console.error('[Job Autopilot]', error);
        status(`Stopped: ${error.message}`, 'error');
        await stop(error.message);
      }
    } finally {
      running = false;
    }
  }

  // Stop on LinkedIn's limits, and hand any security check to the user, then stop.
  function checkLimits() {
    const text = JA.queryAllDeep(NOTICES)
      .filter(JA.visible)
      .map((el) => JA.text(el).slice(0, 600))
      .join(' | ');
    if (DAILY_LIMIT.test(text)) throw new StopRun("LinkedIn says you've reached today's Easy Apply limit. Stopped for 24 hours.", 24);
    if (THROTTLE.test(text)) throw new StopRun('LinkedIn paused Easy Apply because applications were too fast. Stopped for 12 hours.', 12);
  }

  async function securityGate(applicationId) {
    checkLimits();
    if (!JA.detectVerification()) return;
    const solved = await JA.handleVerification({ applicationId });
    throw new StopRun(
      solved
        ? 'LinkedIn showed a security check. Thanks for clearing it. The run stopped to protect your account; start again in a while.'
        : 'LinkedIn security check was not completed.',
    );
  }

  function nextPageUrl() {
    const url = new URL(location.href);
    const startAt = Number(url.searchParams.get('start') || 0) + 25;
    if (startAt >= 1000) return null; // LinkedIn stops at 1000 results
    const hasNext = [...document.querySelectorAll(NEXT_PAGE)].some((el) => !el.closest(DIALOGS));
    if (!hasNext || noResults()) return null;
    url.searchParams.set('start', String(startAt));
    return url.toString();
  }

  async function loadSeen() {
    const { seenJobs = {} } = await chrome.storage.local.get('seenJobs');
    return new Set(Object.keys(seenJobs));
  }

  async function saveSeen(seen) {
    const ids = [...seen].slice(-5000);
    await chrome.storage.local.set({ seenJobs: Object.fromEntries(ids.map((id) => [id, 1])) });
  }

  // ---------------------------------------------------------------------------
  // Job cards
  // ---------------------------------------------------------------------------

  const noResults = () => /no matching jobs found/i.test(JA.text(document.querySelector('main') ?? document.body).slice(0, 4000));

  function cardJobId(el) {
    return (
      el.getAttribute('componentkey')?.match(/^job-card-component-ref-(\d+)/)?.[1] ||
      el.dataset.occludableJobId ||
      el.dataset.jobId ||
      el.querySelector('[data-job-id]')?.dataset.jobId ||
      null
    );
  }

  /** Result cards, one per job id (outermost element), excluding "similar jobs" blocks. */
  function collectCards() {
    if (noResults()) return [];
    const byId = new Map();
    for (const el of document.querySelectorAll(CARD)) {
      if (el.closest('[id^="JobDetailsSimilarJobsSlot"], [data-view-name*="similar-jobs"], dialog, [role="dialog"]')) continue;
      const id = cardJobId(el);
      if (!id) continue;
      const prev = byId.get(id);
      if (!prev || el.contains(prev)) byId.set(id, el);
    }
    let cards = [...byId.entries()].map(([id, el]) => ({ id, el }));
    // New design: the results list is the lazy column holding the most cards.
    const columns = new Map();
    for (const c of cards) {
      const col = c.el.closest('[data-testid="lazy-column"]');
      if (col) columns.set(col, (columns.get(col) ?? 0) + 1);
    }
    if (columns.size > 1) {
      const main = [...columns.entries()].sort((a, b) => b[1] - a[1])[0][0];
      cards = cards.filter((c) => !c.el.closest('[data-testid="lazy-column"]') || c.el.closest('[data-testid="lazy-column"]') === main);
    }
    return cards;
  }

  // Text without screen-reader duplicates (aria-hidden copies, button labels).
  function plainText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[aria-hidden="true"], button, svg').forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim() || JA.text(el);
  }

  const cleanTitle = (t) =>
    String(t ?? '')
      .replace(/^Selected,\s*/i, '')
      .replace(/\s*\(Verified job\)\s*$/i, '')
      .replace(/\s+with verification\s*$/i, '')
      .trim();

  function cardInfo(card) {
    const el = card.el;
    const classicTitle = el.querySelector(CLASSIC.cardTitle);
    const paragraphs = [...el.querySelectorAll('p')].map(plainText).filter((t) => t && !/^[·•|]$/.test(t));
    const lines = [...el.querySelectorAll('p, li, span')].map((n) => JA.text(n));
    return {
      title: cleanTitle(classicTitle ? plainText(classicTitle) : paragraphs[0]),
      company: JA.text(el.querySelector(CLASSIC.cardCompany)) || paragraphs[1] || '',
      location: (JA.text(el.querySelector(CLASSIC.cardLocation)) || paragraphs[2] || '').split('·')[0].trim(),
      applied: lines.some((t) => /^Applied$|^Applied \d+ \w+ ago$|^Application submitted$/i.test(t)),
      external: lines.some((t) => /^Apply on company website$/i.test(t)),
    };
  }

  const detailJobId = () =>
    new URL(location.href).searchParams.get('currentJobId') || location.pathname.match(/\/jobs\/view\/(\d+)/)?.[1] || null;

  async function openCard(card) {
    card.el.scrollIntoView({ block: 'center' });
    await JA.sleep(600);
    // Classic cards render their content lazily once scrolled into view.
    await JA.waitFor(() => JA.text(card.el), { timeout: 3000 });
    const link = card.el.matches('[role="button"]') ? null : card.el.querySelector(CLASSIC.cardLink);
    (link ?? card.el).click();
    return JA.waitFor(() => detailJobId() === card.id && (detailTitle() || applyControls().easy || applyControls().external), {
      timeout: 8000,
    });
  }

  // ---------------------------------------------------------------------------
  // Job details
  // ---------------------------------------------------------------------------

  function aboutHeading() {
    return [...document.querySelectorAll('h2, h3')].find((h) => /^about the job$/i.test(JA.text(h)) && !h.closest(DIALOGS)) ?? null;
  }

  // Controls below "About the job" belong to similar-job suggestions.
  function aboveAbout(el) {
    const h = aboutHeading();
    return !h || Boolean(h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
  }

  const detailTitle = () =>
    JA.text(document.querySelector(CLASSIC.title)) || JA.text(document.querySelector(`${NEW_TOP_CARD} h1`)) || '';

  function detailCompany() {
    const classic = JA.text(document.querySelector(CLASSIC.company));
    if (classic) return classic;
    const top = document.querySelector(NEW_TOP_CARD);
    const companyLink = [...(top ?? document).querySelectorAll('a[href*="/company/"]')].find(
      (a) => JA.text(a) && !a.closest(NOT_THIS_JOB) && aboveAbout(a),
    );
    return JA.text(companyLink) || JA.text(top?.querySelector('p')) || '';
  }

  function detailDescription() {
    const direct = document.querySelector(DESCRIPTION);
    if (direct) return JA.text(direct);
    const h = aboutHeading();
    return h ? JA.text(h.parentElement) : '';
  }

  // Text of the selected job's header area (not the result cards, not similar jobs).
  function detailHeaderText() {
    const box = document.querySelector(CLASSIC.topCard) ?? document.querySelector(NEW_TOP_CARD);
    if (box) return JA.text(box);
    const main = document.querySelector('main');
    if (!main) return '';
    const clone = main.cloneNode(true);
    clone.querySelectorAll(`${CARD}, ${DIALOGS}, [id^="JobDetailsSimilarJobsSlot"]`).forEach((n) => n.remove());
    return (clone.innerText || clone.textContent || '').split(/About the job/i)[0];
  }

  const alreadyApplied = () => /^\s*(Application submitted|Applied \d+ \w+ ago)\b/im.test(detailHeaderText());
  const noLongerAccepting = () => /no longer accepting applications/i.test(detailHeaderText());

  const controlLabel = (el) => `${el.getAttribute('aria-label') ?? ''} ${JA.text(el)}`.trim().toLowerCase();

  function applyControls() {
    const candidates = [
      ...document.querySelectorAll(
        '#jobs-apply-button-id, .jobs-apply-button, button[aria-label], a[aria-label], a[href*="openSDUIApplyFlow"], a[href*="/safety/go"]',
      ),
    ].filter(
      (el) =>
        JA.visible(el) &&
        !el.closest(NOT_THIS_JOB) &&
        !['radio', 'checkbox', 'switch', 'tab', 'option'].includes(el.getAttribute('role')) &&
        !el.hasAttribute('aria-checked') &&
        !el.hasAttribute('aria-pressed') &&
        el.getAttribute('aria-disabled') !== 'true' &&
        !el.disabled &&
        aboveAbout(el),
    );
    const isEasy = (el) => {
      const label = controlLabel(el);
      if (/filter by/.test(label)) return false;
      return /\b(easy|linkedin) apply to\b|^easy apply\b/.test(label) || /openSDUIApplyFlow/.test(el.getAttribute('href') ?? '');
    };
    const easy = candidates.find(isEasy) ?? null;
    const external =
      candidates.find((el) => {
        if (el === easy || isEasy(el)) return false;
        const label = controlLabel(el);
        if (/on company website/.test(label)) return true;
        if (/\/safety\/go/.test(el.getAttribute('href') ?? '') && /^apply$/i.test(JA.text(el))) return true;
        return el.matches('#jobs-apply-button-id, .jobs-apply-button') && /\bapply\b/.test(label);
      }) ?? null;
    return { easy, external };
  }

  function readJob(card) {
    const info = cardInfo(card);
    return {
      id: card.id,
      title: cleanTitle(detailTitle()) || info.title,
      company: detailCompany() || info.company,
      location: (JA.text(document.querySelector(CLASSIC.location)).split('·')[0] || info.location).trim(),
      description: detailDescription().slice(0, 20_000),
      url: `https://www.linkedin.com/jobs/view/${card.id}/`,
    };
  }

  function filterReason(job) {
    const title = job.title.toLowerCase();
    const company = job.company.toLowerCase();
    const has = (list, text) => list.some((w) => text.includes(w.toLowerCase()));
    if (settings.title_include.length && !has(settings.title_include, title)) return 'title not in your include list';
    if (has(settings.title_exclude, title)) return 'title excluded';
    if (has(settings.company_blacklist, company)) return 'company on your block list';
    return null;
  }

  async function processCard(card) {
    const info = cardInfo(card);
    if (info.applied) return 'skip';
    if (info.title && filterReason({ title: info.title, company: info.company })) return 'skip';
    if (info.external && (settings.easy_apply_only || !settings.apply_external)) return 'skip';

    if (!(await openCard(card))) return 'skip';
    await JA.sleep(900);
    await securityGate(null);
    const job = readJob(card);
    if (!job.title || filterReason(job) || alreadyApplied() || noLongerAccepting()) return 'skip';

    const { easy, external } = applyControls();
    const useExternal = !easy && external && settings.apply_external && !settings.easy_apply_only;
    if (!easy && !useExternal) return 'skip';
    if (!(await fitsResume(job, easy ? 'easy_apply' : 'external_autofill'))) return 'skip';
    return easy ? easyApply(job, easy) : externalApply(job, external);
  }

  // Score the job against the resume (server side, no AI cost). Low matches are
  // recorded as skipped so the dashboard shows why.
  async function fitsResume(job, method) {
    if (!settings.min_match_score) return true;
    let fit;
    try {
      fit = await JA.api('POST', '/match', { job: { title: job.title, company: job.company, description: job.description } });
    } catch (error) {
      console.warn('[Job Autopilot] could not score the job', error);
      return true;
    }
    job.matchScore = fit.score;
    if (fit.apply) return true;
    status(`Skipping ${job.title}: ${fit.score}% match with your resume.`);
    await JA.api('POST', '/applications', {
      job_url: job.url,
      job_title: job.title,
      company: job.company,
      location: job.location,
      source: 'linkedin',
      method,
      ats: method === 'easy_apply' ? 'linkedin' : 'other',
      status: 'skipped',
      match_score: fit.score,
      failure_reason: `Low match (${fit.score}%): ${fit.reasons.join('; ') || 'few of your skills'}`.slice(0, 2000),
    }).catch(() => {});
    return false;
  }

  // ---------------------------------------------------------------------------
  // Easy Apply
  // ---------------------------------------------------------------------------

  function isApplyDialog(el) {
    if (el.matches('.jobs-easy-apply-modal')) return true;
    if (
      el.querySelector(
        '[data-sdui-screen*="easyapply" i], .jobs-easy-apply-content, [data-easy-apply-next-button], [data-live-test-easy-apply-submit-button], button[aria-label="Submit application"], button[aria-label="Continue to next step"], button[aria-label="Review your application"]',
      )
    ) {
      return true;
    }
    return /^apply to /i.test(JA.text(el.querySelector('#jobs-apply-header, header h2, h2, h3')));
  }

  function getModal() {
    return JA.queryAllDeep('.jobs-easy-apply-modal, [data-test-modal][role="dialog"], .artdeco-modal[role="dialog"], dialog[open]').find(
      (m) => JA.visible(m) && isApplyDialog(m),
    ) ?? null;
  }

  function modalKind(m) {
    if (!m) return 'none';
    if (m.getRootNode() !== document) return 'classic (shadow root)';
    return m.matches('dialog') ? 'new (native dialog)' : 'classic';
  }

  const usable = (b) => b && JA.visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true';

  // The step's forward button: Submit, else Review, else Next. Never searched outside the dialog.
  function primaryButton(m) {
    const buttons = [...m.querySelectorAll('button')].filter(usable);
    const pick = (selector, text) => [...m.querySelectorAll(selector)].find(usable) ?? buttons.find((b) => text.test(JA.text(b)));
    const submit = pick('button[aria-label="Submit application"], button[data-live-test-easy-apply-submit-button]', /^submit application$/i);
    if (submit) return { button: submit, kind: 'submit' };
    const review = pick('button[aria-label="Review your application"], button[data-live-test-easy-apply-review-button]', /^review( your application)?$/i);
    if (review) return { button: review, kind: 'review' };
    const next = pick('button[aria-label="Continue to next step"], button[data-easy-apply-next-button], button[data-live-test-easy-apply-next-button]', /^(next|continue to next step)$/i);
    return next ? { button: next, kind: 'next' } : null;
  }

  function stepSignature(m) {
    const progress = m.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') ?? JA.text(m).match(/\d+ percent complete|\d+\/\d+ pages/i)?.[0] ?? '';
    const fields = [...m.querySelectorAll('input, select, textarea')].map((e) => e.id || e.name).join(',');
    return `${progress}|${fields}`;
  }

  function findInDialogs(pattern, selector = 'a, button') {
    return (
      JA.queryAllDeep(DIALOGS.split(', ').map((d) => selector.split(', ').map((s) => `${d} ${s}`).join(', ')).join(', ')).find(
        (el) => usable(el) && pattern.test(JA.text(el)),
      ) ?? null
    );
  }

  function uncheckFollow(m) {
    for (const el of m.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
      const wrap = el.matches('[role="checkbox"]') ? el : el.closest('[role="checkbox"]');
      const label = el.id ? m.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const texts = [JA.text(label), el.getAttribute('aria-label'), wrap?.getAttribute('aria-label'), JA.text(wrap ?? el.parentElement)];
      if (!/follow-company/.test(el.id) && !texts.some((t) => /^follow\b/i.test(String(t ?? '').trim()))) continue;
      const checked = wrap?.hasAttribute('aria-checked') ? wrap.getAttribute('aria-checked') === 'true' : el.checked;
      if (checked) (wrap ?? (label && JA.visible(label) ? label : el)).click();
    }
  }

  const successDialog = () =>
    JA.queryAllDeep(`${DIALOGS}, .artdeco-toast-item`).find((d) => JA.visible(d) && SUCCESS.test(JA.text(d).slice(0, 600))) ?? null;

  async function closeSuccess() {
    const d = successDialog();
    if (!d) return;
    (JA.findButton(d, /^(done|not now)$/i) ?? d.querySelector('button[aria-label="Dismiss"]'))?.click();
    await JA.sleep(600);
  }

  async function discard() {
    const m = getModal();
    if (!m) return;
    (m.querySelector('button[aria-label="Dismiss"], button[data-test-modal-close-btn]') ?? JA.findButton(m, /^(dismiss|close)$/i))?.click();
    const confirm = await JA.waitFor(
      () =>
        JA.queryAllDeep('button[data-control-name="discard_application_confirm_btn"], button[data-test-dialog-secondary-btn]').find(usable) ??
        findInDialogs(/^discard$/i, 'button'),
      { timeout: 3000 },
    );
    confirm?.click();
    await JA.sleep(800);
  }

  async function finish(applicationId, status, reason, counts = {}) {
    await JA.api('PATCH', `/applications/${applicationId}`, {
      status,
      failure_reason: reason ?? null,
      questions_answered: counts.questions ?? 0,
      llm_answers: counts.llm ?? 0,
    }).catch((e) => console.warn('[Job Autopilot] could not update application', e));
    return status === 'submitted' ? 'submitted' : status;
  }

  // Click Easy Apply and get past LinkedIn's interstitials to the form.
  async function openEasyApply(button) {
    button.click();
    let reclicked = false;
    const end = Date.now() + 15_000;
    while (Date.now() < end) {
      await JA.sleep(500);
      checkLimits();
      const m = getModal();
      if (m && primaryButton(m)) return m;
      const cont = findInDialogs(/^continue applying$/i);
      if (cont) {
        cont.click(); // "Job search safety reminder"
        continue;
      }
      if (!m && !reclicked && /some required qualifications|show match details/i.test(detailHeaderText())) {
        reclicked = true;
        applyControls().easy?.click();
      }
    }
    return getModal();
  }

  async function easyApply(job, button) {
    const { application, already_applied } = await JA.api('POST', '/applications', {
      job_url: job.url,
      job_title: job.title,
      company: job.company,
      location: job.location,
      source: 'linkedin',
      method: 'easy_apply',
      ats: 'linkedin',
      match_score: job.matchScore ?? null,
    });
    if (already_applied) return 'skip';
    const appId = application.id;
    const counts = { questions: 0, llm: 0 };

    let m;
    try {
      m = await openEasyApply(button);
    } catch (error) {
      if (error instanceof StopRun) await finish(appId, 'skipped', error.message, counts);
      throw error;
    }
    if (!m) return finish(appId, 'failed', 'The Easy Apply form did not open');

    let lastSig = '';
    let stuck = 0;
    let missing = [];
    for (let step = 0; step < 15; step++) {
      try {
        await whileVisible();
        await securityGate(appId);
      } catch (error) {
        await discard();
        await finish(appId, 'skipped', error.message, counts);
        throw error;
      }
      if (stopRequested) {
        await discard();
        return finish(appId, 'skipped', 'Stopped by you', counts);
      }
      if (successDialog()) break;
      m = getModal();
      if (!m) return finish(appId, alreadyApplied() ? 'submitted' : 'failed', alreadyApplied() ? null : 'The form closed unexpectedly', counts);

      const result = await JA.autofill(m, job);
      counts.questions += result.filled;
      counts.llm += result.llm;
      missing = [...new Set([...missing, ...result.missing.map((x) => x.label), ...result.unfilled])];
      await JA.sleep(600);

      const primary = primaryButton(m);
      if (!primary) {
        await discard();
        return finish(appId, 'failed', 'Could not find the Next/Submit button', counts);
      }

      if (primary.kind === 'submit') {
        uncheckFollow(m);
        await JA.sleep(400);
        if (settings.auto_submit_easy_apply) {
          primaryButton(m)?.button.click();
        } else {
          await finish(appId, 'needs_review', 'Waiting for you to review and submit', counts);
          status('Review this application on LinkedIn and click "Submit application". I will continue after it is sent.', 'warning');
        }
        const sent = await JA.waitFor(() => successDialog() || (!getModal() && alreadyApplied()), {
          timeout: settings.auto_submit_easy_apply ? 20_000 : 15 * 60_000,
          interval: 1000,
        });
        await closeSuccess();
        checkLimits();
        if (sent) return finish(appId, 'submitted', null, counts);
        if (getModal()) await discard();
        return finish(appId, 'failed', 'The application was not submitted', counts);
      }

      const sig = stepSignature(m);
      primary.button.click();
      await JA.sleep(1500);
      const after = getModal();
      const errors = after ? JA.visibleErrors(after) : [];
      if (after && (errors.length || stepSignature(after) === sig)) {
        stuck = sig === lastSig ? stuck + 1 : 1;
        lastSig = sig;
        if (stuck >= 2) {
          await discard();
          const why = missing.length ? `Missing answers: ${missing.slice(0, 4).join('; ')}` : `Form errors: ${errors.join(' | ').slice(0, 300) || 'stuck on a step'}`;
          return finish(appId, 'failed', why, counts);
        }
      }
    }
    if (successDialog()) {
      await closeSuccess();
      return finish(appId, 'submitted', null, counts);
    }
    await discard();
    return finish(appId, 'failed', 'Too many steps in the application', counts);
  }

  // ---------------------------------------------------------------------------
  // External applications (company website)
  // ---------------------------------------------------------------------------

  function waitForExternal(type, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        externalWaiter = null;
        resolve(null);
      }, timeoutMs);
      externalWaiter = (msg) => {
        if (msg.type !== type) return;
        clearTimeout(timer);
        externalWaiter = null;
        resolve(msg);
      };
    });
  }

  async function externalApply(job, button) {
    const { application, already_applied } = await JA.api('POST', '/applications', {
      job_url: job.url,
      job_title: job.title,
      company: job.company,
      location: job.location,
      source: 'linkedin',
      method: 'external_autofill',
      ats: 'other',
      match_score: job.matchScore ?? null,
    });
    if (already_applied) return 'skip';

    await JA.send({ type: 'external:expect', applicationId: application.id, job });
    let opened = null;
    const openedPromise = waitForExternal('external:opened', 25_000).then((msg) => (opened = msg));
    button.click();
    // "Job search safety reminder" / "Share your profile?" come before the company site opens.
    for (let i = 0; i < 16 && !opened; i++) {
      await JA.sleep(500);
      checkLimits();
      findInDialogs(/^(continue|continue applying)$/i)?.click();
    }
    await openedPromise;
    if (!opened) {
      await JA.send({ type: 'external:cancel' });
      return finish(application.id, 'failed', 'The company website did not open in a new tab');
    }
    status(`Applying on ${job.company || 'the company'} website in another tab…`);
    const done = await waitForExternal('external:done', 20 * 60_000);
    return done?.status === 'submitted' ? 'submitted' : done?.status ?? 'skip';
  }

  // ---------------------------------------------------------------------------
  // Self-check: reports which parts of the current LinkedIn page the bot can find,
  // without clicking anything. Run from the popup ("Check this LinkedIn page").
  // ---------------------------------------------------------------------------

  function diagnose() {
    const check = (key, label, ok, detail = '', { optional = false } = {}) => ({ key, label, ok: Boolean(ok), optional, detail: String(detail ?? '') });

    const onSearch = isJobSearchPage();
    const onJobView = /^\/jobs\/view\//.test(location.pathname);
    const cards = collectCards();
    const newDesign = Boolean(document.querySelector('[componentkey^="job-card-component-ref-"]')) || /^\/jobs\/search-results/.test(location.pathname);
    const selected = cards.find((c) => c.id === detailJobId());
    const sample = cards[0] ? cardInfo(cards[0]) : null;
    const { easy, external } = applyControls();
    const applied = alreadyApplied();
    const modal = getModal();
    const verification = JA.detectVerification();

    const checks = [
      check('page', 'On a LinkedIn jobs page', onSearch || onJobView, location.pathname),
      check('design', 'Page design', true, newDesign ? 'new design' : 'classic design', { optional: true }),
      check('cards', 'Job cards in the results list', cards.length > 0, `${cards.length} found`, { optional: !onSearch }),
      check('card_text', 'Title and company read from a card', sample?.title && sample?.company, sample ? `${sample.title} · ${sample.company}` : '', { optional: !onSearch }),
      check('selected', 'Selected job ID', Boolean(detailJobId()), detailJobId() ?? 'click a job first'),
      check('title', 'Job title', detailTitle() || (selected && cardInfo(selected).title), detailTitle() || (selected ? cardInfo(selected).title : '')),
      check('company', 'Company name', detailCompany() || (selected && cardInfo(selected).company), detailCompany()),
      check('description', 'Job description', detailDescription(), `${detailDescription().slice(0, 40)}…`),
      check(
        'apply',
        'Apply button',
        Boolean(easy || external) || applied,
        easy ? `Easy Apply (${controlLabel(easy).slice(0, 40)})` : external ? 'Apply on company website' : applied ? 'already applied' : 'not found',
      ),
      check('verification', 'No security check on the page', !verification, verification ?? ''),
    ];

    if (modal) {
      const { fields } = JA.collectFields(modal);
      const primary = primaryButton(modal);
      checks.push(
        check('modal', 'Easy Apply form', true, `${modalKind(modal)}: ${JA.text(modal.querySelector('h2, h3')).slice(0, 50)}`),
        check(
          'fields',
          'Questions detected in the form',
          true,
          fields
            .map((f) => `${f.type}${f.required ? '*' : ''}: ${f.label || '(no label)'}${f.options?.length ? ` [${f.options.join('/').slice(0, 60)}]` : ''}`)
            .join(' | ') || 'none on this step',
          { optional: true },
        ),
        check('next', 'Next / Review / Submit button', Boolean(primary), primary ? `${primary.kind}: ${JA.text(primary.button)}` : 'not found'),
      );
    } else {
      checks.push(check('modal', 'Easy Apply form (open one to check its questions)', false, 'not open', { optional: true }));
    }

    const required = checks.filter((c) => !c.optional);
    return {
      ok: required.every((c) => c.ok),
      version: chrome.runtime.getManifest().version,
      url: location.origin + location.pathname,
      checked_at: new Date().toISOString(),
      checks,
    };
  }
})();

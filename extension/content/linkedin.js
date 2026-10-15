// Drives LinkedIn job search: opens each job, applies with Easy Apply, or hands
// external "Apply" jobs to the company site tab (content/ats.js).
//
// LinkedIn changes its markup often. Selectors lean on aria-labels and stable
// class prefixes; if the bot stops finding buttons, update the SELECTORS below.
(() => {
  const JA = globalThis.JA;
  if (window.top !== window || JA.linkedinLoaded) return;
  JA.linkedinLoaded = true;

  const SELECTORS = {
    jobCard: 'li[data-occludable-job-id], div.job-card-container[data-job-id], [data-job-id].job-card-list',
    cardLink: 'a.job-card-list__title, a.job-card-container__link, a[href*="/jobs/view/"]',
    title: '.job-details-jobs-unified-top-card__job-title, .jobs-unified-top-card__job-title, .t-24.job-details-jobs-unified-top-card__job-title',
    company: '.job-details-jobs-unified-top-card__company-name, .jobs-unified-top-card__company-name',
    location: '.job-details-jobs-unified-top-card__primary-description-container, .job-details-jobs-unified-top-card__tertiary-description-container, .jobs-unified-top-card__bullet',
    description: '#job-details, .jobs-description__content, .jobs-box__html-content',
    topCard: '.job-details-jobs-unified-top-card__container--two-pane, .jobs-unified-top-card, .job-details-jobs-unified-top-card',
    applyButton: '.jobs-apply-button--top-card button, button.jobs-apply-button, .jobs-s-apply button',
    modal: '.jobs-easy-apply-modal, [data-test-modal][role="dialog"], .artdeco-modal[role="dialog"]',
    listContainer: '.jobs-search-results-list, .scaffold-layout__list > div, .scaffold-layout__list',
  };

  let running = false;
  let stopRequested = false;
  let settings = null;
  let externalWaiter = null;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'linkedin:start') {
      start();
      sendResponse({ ok: true });
    } else if (msg.type === 'linkedin:stop') {
      stopRequested = true;
      JA.panel.show('Stopping after the current step…');
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

  // ---------------------------------------------------------------------------

  function searchUrl(s, startAt = 0) {
    const url = new URL('https://www.linkedin.com/jobs/search/');
    if (s.search_keywords) url.searchParams.set('keywords', s.search_keywords);
    if (s.search_location) url.searchParams.set('location', s.search_location);
    if (s.easy_apply_only) url.searchParams.set('f_AL', 'true');
    url.searchParams.set('sortBy', 'DD');
    if (startAt) url.searchParams.set('start', String(startAt));
    return url.toString();
  }

  const isJobSearchPage = () => /^\/jobs\/(search|collections)/.test(location.pathname);

  async function stop(reason) {
    running = false;
    await JA.send({ type: 'linkedin:finished', reason }).catch(() => {});
  }

  async function start() {
    if (running) return;
    running = true;
    stopRequested = false;
    try {
      const session = await JA.api('GET', '/session');
      settings = session.settings;
      if (!session.has_resume) {
        JA.panel.show('Upload your resume in the dashboard first.', { tone: 'error' });
        return stop('No resume uploaded');
      }
      if (!(await JA.handleVerification())) return stop('Verification not completed');
      if (!isJobSearchPage()) {
        location.href = searchUrl(settings);
        return; // the script starts again on the search page
      }

      let submittedToday = session.submitted_today;
      const seen = await loadSeen();
      JA.panel.show(`Running. ${submittedToday} of ${settings.daily_limit} applications sent today.`, {
        actions: [{ label: 'Stop', onClick: () => (stopRequested = true) }],
      });

      await JA.waitFor(() => document.querySelector(SELECTORS.jobCard), { timeout: 15_000 });
      for (;;) {
        const pending = [...document.querySelectorAll(SELECTORS.jobCard)].filter((c) => {
          const id = cardJobId(c);
          return id && !seen.has(id);
        });
        if (!pending.length) break;

        for (const card of pending) {
          if (stopRequested) {
            JA.panel.show('Stopped.');
            return stop('Stopped by you');
          }
          if (submittedToday >= settings.daily_limit) {
            JA.panel.show(`Daily limit of ${settings.daily_limit} reached. Start again tomorrow.`, { tone: 'success' });
            return stop('Daily limit reached');
          }
          const jobId = cardJobId(card);
          seen.add(jobId);
          await saveSeen(seen);

          const outcome = await processCard(card, jobId).catch((error) => {
            console.warn('[Job Autopilot]', error);
            return 'error';
          });
          if (outcome === 'submitted') submittedToday += 1;
          JA.panel.show(`Running. ${submittedToday} of ${settings.daily_limit} applications sent today.`, {
            actions: [{ label: 'Stop', onClick: () => (stopRequested = true) }],
          });
          if (outcome !== 'skip') await JA.jitter(settings.min_delay_sec, settings.max_delay_sec);
        }
      }

      const next = nextPageUrl();
      if (!next) {
        JA.panel.show('No more jobs in this search. Done!', { tone: 'success' });
        return stop('Search finished');
      }
      location.href = next;
    } catch (error) {
      console.error('[Job Autopilot]', error);
      JA.panel.show(`Stopped: ${error.message}`, { tone: 'error' });
      await stop(error.message);
    } finally {
      running = false;
    }
  }

  function nextPageUrl() {
    const url = new URL(location.href);
    const startAt = Number(url.searchParams.get('start') || 0) + 25;
    if (startAt >= 1000) return null; // LinkedIn stops at 1000 results
    const hasNext = document.querySelector('button[aria-label="View next page"], .jobs-search-pagination__button--next, li[data-test-pagination-page-btn]');
    if (!hasNext) return null;
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

  const cardJobId = (card) =>
    card.dataset.occludableJobId || card.dataset.jobId || card.querySelector('[data-job-id]')?.dataset.jobId || null;

  const detailJobId = () =>
    new URL(location.href).searchParams.get('currentJobId') || location.pathname.match(/\/jobs\/view\/(\d+)/)?.[1] || null;

  const textOf = (sel) => JA.text(document.querySelector(sel));

  function readJob(jobId, card) {
    const title = textOf(SELECTORS.title) || JA.text(card.querySelector(SELECTORS.cardLink));
    const company = textOf(SELECTORS.company) || JA.text(card.querySelector('.artdeco-entity-lockup__subtitle'));
    const place = (textOf(SELECTORS.location) || JA.text(card.querySelector('.job-card-container__metadata-item'))).split('·')[0].trim();
    return {
      id: jobId,
      title,
      company,
      location: place,
      description: textOf(SELECTORS.description).slice(0, 20_000),
      url: `https://www.linkedin.com/jobs/view/${jobId}/`,
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

  const alreadyApplied = () => /\bApplied\b.{0,40}\bago\b|Application submitted/i.test(textOf(SELECTORS.topCard));

  function applyButtons() {
    const buttons = [...document.querySelectorAll(SELECTORS.applyButton)].filter(JA.visible);
    const label = (b) => `${JA.text(b)} ${b.getAttribute('aria-label') ?? ''}`;
    return {
      easy: buttons.find((b) => /easy apply/i.test(label(b))) ?? null,
      external: buttons.find((b) => !/easy apply/i.test(label(b)) && /apply/i.test(label(b))) ?? null,
    };
  }

  async function processCard(card, jobId) {
    card.scrollIntoView({ block: 'center' });
    await JA.sleep(500);
    (card.querySelector(SELECTORS.cardLink) ?? card).click();
    if (!(await JA.waitFor(() => detailJobId() === jobId && document.querySelector(SELECTORS.title), { timeout: 8000 }))) {
      return 'skip';
    }
    await JA.sleep(900);
    const job = readJob(jobId, card);
    if (!job.title || filterReason(job) || alreadyApplied()) return 'skip';

    const { easy, external } = applyButtons();
    if (easy) return easyApply(job, easy);
    if (external && settings.apply_external && !settings.easy_apply_only) return externalApply(job, external);
    return 'skip';
  }

  // ---------------------------------------------------------------------------
  // Easy Apply
  // ---------------------------------------------------------------------------

  function getModal() {
    return [...document.querySelectorAll(SELECTORS.modal)].find((m) => JA.visible(m)) ?? null;
  }

  const isSuccess = (m) => Boolean(m) && /application (was )?sent|your application was sent|applied to/i.test(JA.text(m).slice(0, 400));

  function primaryButton(m) {
    return (
      m.querySelector('button[aria-label="Submit application"], button[aria-label="Review your application"], button[aria-label="Continue to next step"]') ??
      JA.findButton(m, /^(next|review|submit application|continue)\b/i, 'footer button, button')
    );
  }

  function uncheckFollow(m) {
    const follow = m.querySelector('input#follow-company-checkbox, input[id*="follow-company"]');
    if (follow?.checked) (m.querySelector(`label[for="${CSS.escape(follow.id)}"]`) ?? follow).click();
  }

  async function discard() {
    const m = getModal();
    if (!m) return;
    (m.querySelector('button[aria-label="Dismiss"]') ?? JA.findButton(m, /dismiss|close/i))?.click();
    const confirm = await JA.waitFor(
      () =>
        document.querySelector('button[data-control-name="discard_application_confirm_btn"]') ??
        JA.findButton(document, /^discard$/i, '[role="alertdialog"] button, [role="dialog"] button'),
      { timeout: 3000 },
    );
    confirm?.click();
    await JA.sleep(800);
  }

  async function closeDialog() {
    const m = getModal();
    if (!m) return;
    (JA.findButton(m, /^(done|not now)$/i) ?? m.querySelector('button[aria-label="Dismiss"]'))?.click();
    await JA.sleep(600);
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

  async function easyApply(job, button) {
    const { application, already_applied } = await JA.api('POST', '/applications', {
      job_url: job.url,
      job_title: job.title,
      company: job.company,
      location: job.location,
      source: 'linkedin',
      method: 'easy_apply',
      ats: 'linkedin',
    });
    if (already_applied) return 'skip';
    const appId = application.id;
    const counts = { questions: 0, llm: 0 };

    button.click();
    if (!(await JA.waitFor(getModal, { timeout: 8000 }))) {
      return finish(appId, 'failed', 'The Easy Apply dialog did not open');
    }

    let lastErrors = '';
    let repeats = 0;
    let missing = [];
    for (let step = 0; step < 15; step++) {
      if (stopRequested) {
        await discard();
        return finish(appId, 'skipped', 'Stopped by you', counts);
      }
      if (!(await JA.handleVerification({ applicationId: appId }))) {
        await discard();
        return finish(appId, 'failed', 'Verification was not completed', counts);
      }
      const m = getModal();
      if (!m) return finish(appId, 'failed', 'The dialog closed unexpectedly', counts);
      if (isSuccess(m)) break;

      const result = await JA.autofill(m, job);
      counts.questions += result.filled;
      counts.llm += result.llm;
      missing = [...new Set([...missing, ...result.missing.map((x) => x.label), ...result.unfilled])];
      uncheckFollow(m);
      await JA.sleep(600);

      const primary = primaryButton(m);
      if (!primary) {
        await discard();
        return finish(appId, 'failed', 'Could not find the Next/Submit button', counts);
      }
      const label = `${primary.getAttribute('aria-label') ?? ''} ${JA.text(primary)}`;

      if (/submit/i.test(label)) {
        if (settings.auto_submit_easy_apply) {
          primary.click();
        } else {
          await finish(appId, 'needs_review', 'Waiting for you to review and submit', counts);
          JA.panel.show('Review this application and click "Submit application". I will continue after it is sent.', { tone: 'warning' });
        }
        const sent = await JA.waitFor(() => isSuccess(getModal()) || (!getModal() && alreadyApplied()), {
          timeout: settings.auto_submit_easy_apply ? 20_000 : 15 * 60_000,
          interval: 1000,
        });
        await closeDialog();
        if (sent) return finish(appId, 'submitted', null, counts);
        if (getModal()) await discard();
        return finish(appId, 'failed', 'The application was not submitted', counts);
      }

      primary.click();
      await JA.sleep(1500);
      const errors = JA.visibleErrors(getModal() ?? document).join(' | ');
      if (errors) {
        repeats = errors === lastErrors ? repeats + 1 : 0;
        lastErrors = errors;
        if (repeats >= 1) {
          await discard();
          const why = missing.length ? `Missing answers: ${missing.slice(0, 4).join('; ')}` : `Form errors: ${errors.slice(0, 300)}`;
          return finish(appId, 'failed', why, counts);
        }
      }
    }
    if (isSuccess(getModal())) {
      await closeDialog();
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
    });
    if (already_applied) return 'skip';

    await JA.send({ type: 'external:expect', applicationId: application.id, job });
    const opened = waitForExternal('external:opened', 20_000);
    button.click();
    // LinkedIn sometimes asks to share your profile first.
    await JA.sleep(1500);
    JA.findButton(document, /^(continue|apply)$/i, '[role="dialog"] button')?.click();

    if (!(await opened)) {
      await JA.send({ type: 'external:cancel' });
      return finish(application.id, 'failed', 'The company website did not open in a new tab');
    }
    JA.panel.show(`Applying on ${job.company || 'the company'} website in another tab…`);
    const done = await waitForExternal('external:done', 20 * 60_000);
    return done?.status === 'submitted' ? 'submitted' : done?.status ?? 'skip';
  }

  // ---------------------------------------------------------------------------
  // Self-check: reports which parts of the current LinkedIn page the bot can find,
  // without clicking anything. Run from the popup ("Check this LinkedIn page").
  // ---------------------------------------------------------------------------

  function diagnose() {
    const probe = (selector) => {
      const els = [...document.querySelectorAll(selector)];
      const first = els.find(JA.visible) ?? els[0];
      return { total: els.length, visible: els.filter(JA.visible).length, sample: first ? JA.text(first).slice(0, 80) : '' };
    };
    const check = (key, label, ok, detail = '', { optional = false } = {}) => ({ key, label, ok: Boolean(ok), optional, detail });

    const onSearch = isJobSearchPage();
    const onJobView = /^\/jobs\/view\//.test(location.pathname);
    const cards = probe(SELECTORS.jobCard);
    const ids = [...document.querySelectorAll(SELECTORS.jobCard)].map(cardJobId).filter(Boolean);
    const title = probe(SELECTORS.title);
    const company = probe(SELECTORS.company);
    const place = probe(SELECTORS.location);
    const description = probe(SELECTORS.description);
    const { easy, external } = applyButtons();
    const applied = alreadyApplied();
    const modal = getModal();
    const verification = JA.detectVerification();

    const checks = [
      check('page', 'On a LinkedIn jobs page', onSearch || onJobView, location.pathname),
      check('cards', 'Job cards in the results list', cards.total > 0, `${cards.total} found, ${cards.visible} visible`, { optional: !onSearch }),
      check('card_ids', 'Job IDs readable from the cards', ids.length > 0, ids.slice(0, 3).join(', '), { optional: !onSearch }),
      check('selected', 'Selected job ID', Boolean(detailJobId()), detailJobId() ?? 'click a job first'),
      check('title', 'Job title', title.visible > 0, title.sample),
      check('company', 'Company name', company.visible > 0, company.sample),
      check('location', 'Location', place.total > 0, place.sample, { optional: true }),
      check('description', 'Job description', description.total > 0, `${description.sample.slice(0, 40)}…`),
      check(
        'apply',
        'Apply button',
        Boolean(easy || external) || applied,
        easy ? 'Easy Apply' : external ? 'Apply on company website' : applied ? 'already applied' : 'not found',
      ),
      check('verification', 'No verification challenge on the page', !verification, verification ?? ''),
    ];

    if (modal) {
      const { fields } = JA.collectFields(modal);
      const primary = primaryButton(modal);
      checks.push(
        check('modal', 'Easy Apply dialog', true, JA.text(modal.querySelector('h2, h3')).slice(0, 60)),
        check(
          'fields',
          'Questions detected in the dialog',
          true,
          fields.map((f) => `${f.type}${f.required ? '*' : ''}: ${f.label || '(no label)'}${f.options?.length ? ` [${f.options.length} options]` : ''}`).join(' | ') || 'none on this step',
          { optional: true },
        ),
        check('next', 'Next / Review / Submit button', Boolean(primary), primary ? (primary.getAttribute('aria-label') || JA.text(primary)) : 'not found'),
      );
    } else {
      checks.push(check('modal', 'Easy Apply dialog (open one to check its questions)', false, 'not open', { optional: true }));
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

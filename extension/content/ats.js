// Fills job applications on company career sites (Greenhouse, Lever, Workday,
// Ashby, ... or any other form). Only acts in tabs the bot opened from LinkedIn,
// or when you click "Autofill this page" in the extension popup.
(() => {
  const JA = globalThis.JA;
  if (JA.atsLoaded) return;
  JA.atsLoaded = true;
  const isTop = window.top === window;

  const ATS = [
    [/(^|\.)greenhouse\.io$/, 'greenhouse'],
    [/(^|\.)lever\.co$/, 'lever'],
    [/myworkdayjobs\.com$|(^|\.)workday\.com$/, 'workday'],
    [/(^|\.)ashbyhq\.com$/, 'ashby'],
    [/(^|\.)smartrecruiters\.com$/, 'smartrecruiters'],
    [/(^|\.)icims\.com$/, 'icims'],
    [/(^|\.)workable\.com$/, 'workable'],
    [/(^|\.)bamboohr\.com$/, 'bamboohr'],
    [/(^|\.)jobvite\.com$/, 'jobvite'],
    [/(^|\.)taleo\.net$/, 'taleo'],
    [/successfactors\.(com|eu)$/, 'successfactors'],
    [/(^|\.)naukri\.com$/, 'naukri'],
    [/(^|\.)indeed\.com$/, 'indeed'],
  ];
  const detectAts = () => ATS.find(([re]) => re.test(location.hostname))?.[1] ?? 'other';

  const CONFIRMATION =
    /thank you for (applying|your application|submitting)|application (has been |was )?(submitted|received|sent|complete)|we('ve| have) received your application|successfully (applied|submitted)|your application is (complete|in)/i;
  const APPLY_CTA = /^(apply( now| for this (job|position|role)| online)?|i'?m interested|start (my |your )?application)$/i;
  const SUBMIT = /^(submit( (my |your )?application)?|send( (my )?application)?|apply( now)?|finish|complete( application)?)$/i;
  const NEXT = /^(next( step| page)?|continue|save (and|&) continue|proceed)$/i;

  const visibleFields = (root) =>
    [...root.querySelectorAll('input, select, textarea')].filter(
      (el) => !['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type) && JA.visible(el),
    ).length;

  const isConfirmation = () => CONFIRMATION.test(JA.text(document.body).slice(0, 6000)) && visibleFields(document) < 3;

  const hasLoginWall = () =>
    [...document.querySelectorAll('input[type="password"]')].some(JA.visible) && visibleFields(document) <= 5;

  function formRoot() {
    const forms = [...document.querySelectorAll('form')]
      .map((f) => ({ f, n: visibleFields(f) }))
      .filter((x) => x.n >= 2)
      .sort((a, b) => b.n - a.n);
    if (forms.length) return forms[0].f;
    return visibleFields(document) >= 2 ? document.body : null;
  }

  let started = false;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'ats:start') {
      run(msg.session);
      sendResponse({ ok: true });
    }
  });

  JA.send({ type: 'ats:session' })
    .then((session) => {
      if (!session) return;
      if (isTop && !JA.detectVerification()) JA.send({ type: 'verification:tab-clear' }).catch(() => {});
      run(session);
    })
    .catch(() => {});

  async function run(session) {
    if (started) return;
    started = true;
    const settings = session.settings ?? {};
    const assist = session.mode === 'assist';
    const applicationId = session.applicationId ?? null;
    const job = { ...(session.job ?? {}) };
    const counts = { questions: 0, llm: 0 };
    const report = (status, reason = null) =>
      JA.send({ type: 'ats:done', status, reason, questions: counts.questions, llm: counts.llm }).catch(() => {});

    await JA.sleep(2500); // let single-page apps render
    if (!isTop && visibleFields(document) < 2) return; // ads, analytics and other frames without a form

    try {
      if (!(await JA.handleVerification({ applicationId }))) return report('failed', 'Verification was not completed');
      if (isConfirmation()) return report('submitted');

      if (isTop && hasLoginWall()) {
        const ok = await pauseForUser(
          applicationId,
          'login_required',
          'This site needs you to sign in or create an account. Do that in this tab and I will fill in the application afterwards.',
          () => !hasLoginWall(),
        );
        if (!ok) return report('needs_review', 'The site required signing in');
      }

      if (isTop && !formRoot()) {
        const cta = JA.findButton(document, APPLY_CTA);
        if (cta) {
          cta.click(); // may navigate; this script then starts again on the next page
          await JA.sleep(3500);
        }
      }

      const root = await JA.waitFor(formRoot, { timeout: 10_000 });
      if (!root) {
        if (isTop) return waitForUserSubmit({ applicationId, filled: 0, unanswered: [], report, note: 'I could not find an application form here.' });
        return;
      }
      if (applicationId) JA.api('PATCH', `/applications/${applicationId}`, { ats: detectAts() }).catch(() => {});

      for (let page = 0; page < 10; page++) {
        if (!(await JA.handleVerification({ applicationId }))) return report('failed', 'Verification was not completed');
        const form = formRoot() ?? root;
        JA.panel.show('Filling in the application…');
        const result = await JA.autofill(form, job);
        counts.questions += result.filled;
        counts.llm += result.llm;
        const unanswered = [...new Set([...result.missing.map((m) => m.label), ...result.unfilled])].filter(Boolean);
        await JA.sleep(800);

        const submit = JA.findButton(form, SUBMIT) ?? JA.findButton(document, SUBMIT, 'button[type="submit"], input[type="submit"]');
        const next = submit ? null : JA.findButton(form, NEXT);
        if (next) {
          next.click();
          await JA.sleep(3000);
          if (isConfirmation()) return report('submitted');
          continue;
        }

        if (submit && settings.auto_submit_external && !assist && !unanswered.length) {
          submit.click();
          await JA.sleep(3000);
          if (!(await JA.handleVerification({ applicationId }))) return report('failed', 'Verification was not completed');
          if (await JA.waitFor(isConfirmation, { timeout: 20_000, interval: 1000 })) return report('submitted');
        }
        return waitForUserSubmit({ applicationId, filled: counts.questions, unanswered, report });
      }
      return waitForUserSubmit({ applicationId, filled: counts.questions, unanswered: [], report });
    } catch (error) {
      console.error('[Job Autopilot]', error);
      JA.panel.show(`Something went wrong: ${error.message}`, { tone: 'error' });
      return report('failed', error.message);
    }
  }

  async function pauseForUser(applicationId, kind, message, isDone, timeoutMs = 15 * 60_000) {
    JA.panel.show(message, { tone: 'warning' });
    const res = await JA.send({ type: 'verification:start', kind, applicationId, url: location.href, title: document.title }).catch(() => null);
    const ok = await JA.waitFor(isDone, { timeout: timeoutMs, interval: 2000 });
    await JA.send({ type: 'verification:end', alertId: res?.alertId, status: ok ? 'resolved' : 'expired' }).catch(() => null);
    return Boolean(ok);
  }

  async function waitForUserSubmit({ applicationId, filled, unanswered, report, note = '' }) {
    JA.highlightUnfilled();
    if (applicationId) {
      JA.api('PATCH', `/applications/${applicationId}`, {
        status: 'needs_review',
        failure_reason: unanswered.length ? `Needs your answer: ${unanswered.slice(0, 4).join('; ')}` : 'Waiting for you to review and submit',
      }).catch(() => {});
    }
    let finished = false;
    const finish = (status, reason) => {
      if (finished) return;
      finished = true;
      JA.panel.show(status === 'submitted' ? 'Recorded as submitted.' : status === 'skipped' ? 'Skipped.' : 'Left for you to finish later.', {
        tone: status === 'submitted' ? 'success' : 'info',
      });
      report(status, reason);
    };
    const ask = unanswered.length ? ` Please answer: ${unanswered.slice(0, 3).join('; ')}.` : '';
    JA.panel.show(`${note} I filled ${filled} field(s).${ask} Review the form and submit it; I will notice when it is sent.`.trim(), {
      tone: 'warning',
      actions: [
        { label: 'I submitted it', primary: true, onClick: () => finish('submitted') },
        { label: 'Skip this job', onClick: () => finish('skipped', 'Skipped by you') },
      ],
    });
    const confirmed = await JA.waitFor(() => finished || isConfirmation(), { timeout: 20 * 60_000, interval: 2000 });
    if (!finished) finish(confirmed ? 'submitted' : 'needs_review', confirmed ? null : 'Not submitted within 20 minutes');
  }
})();

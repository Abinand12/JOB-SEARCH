// Detects human-verification challenges and pauses the bot until the user solves
// them by hand. The extension never tries to solve or bypass a challenge.
(() => {
  const JA = globalThis.JA;
  if (JA.detectVerification) return;

  const all = (sel) => [...document.querySelectorAll(sel)];

  // A challenge the user can actually see and interact with (not an invisible badge).
  const onScreen = (el) => {
    if (!JA.visible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 40 && r.height >= 40 && r.bottom > 0 && r.right > 0;
  };

  const tokenFilled = (names) =>
    names.some((n) => all(`[name="${n}"]`).some((el) => (el.value ?? '').length > 20));

  const DETECTORS = [
    {
      kind: 'linkedin_checkpoint',
      test: () =>
        JA.onLinkedIn &&
        (/^\/(checkpoint|authwall)\b/.test(location.pathname) ||
          all('iframe[src*="captchaInternal"], iframe[src*="px-captcha"], #px-captcha, iframe[src*="protechts.net"][src*="captcha"]').some(onScreen)),
    },
    {
      kind: 'cloudflare',
      test: () =>
        /just a moment|attention required|checking your browser/i.test(document.title) &&
        Boolean(document.querySelector('#challenge-form, #challenge-running, #challenge-stage, #cf-challenge-running, .cf-browser-verification')),
    },
    {
      kind: 'recaptcha',
      test: () => {
        if (all('iframe[src*="/recaptcha/"][src*="bframe"]').some(onScreen)) return true; // image challenge open
        const checkbox = all('iframe[src*="/recaptcha/"][src*="anchor"]').filter(
          (f) => !/size=invisible/.test(f.src) && !f.closest('.grecaptcha-badge') && onScreen(f),
        );
        return checkbox.length > 0 && !tokenFilled(['g-recaptcha-response']);
      },
    },
    {
      kind: 'hcaptcha',
      test: () => {
        if (all('iframe[src*="hcaptcha.com"][src*="frame=challenge"]').some(onScreen)) return true;
        const checkbox = all('iframe[src*="hcaptcha.com"][src*="frame=checkbox"]').filter(onScreen);
        return checkbox.length > 0 && !tokenFilled(['h-captcha-response', 'g-recaptcha-response']);
      },
    },
    {
      kind: 'turnstile',
      test: () => all('iframe[src*="challenges.cloudflare.com"]').some(onScreen) && !tokenFilled(['cf-turnstile-response']),
    },
    {
      kind: 'arkose',
      test: () => all('iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], iframe[id*="arkose" i], #captcha-internal').some(onScreen),
    },
    {
      kind: 'unknown',
      test: () => {
        const headings = all('h1, h2, h3, [role="heading"]').filter(JA.visible).map(JA.text).join(' | ');
        return /verify (that )?you('re| are) (a )?human|are you a robot|let'?s confirm you('re| are) human|security (check|verification)|unusual (activity|traffic)/i.test(headings);
      },
    },
  ];

  JA.detectVerification = () => {
    for (const d of DETECTORS) {
      try {
        if (d.test()) return d.kind;
      } catch {
        // ignore a broken detector
      }
    }
    return null;
  };

  /**
   * Returns true when the page is clear (immediately, or after the user solved the
   * challenge), false if the user did not solve it within the timeout.
   */
  JA.handleVerification = async ({ applicationId = null, timeoutMs = 15 * 60_000 } = {}) => {
    if (!JA.detectVerification()) return true;
    // Managed challenges (Turnstile, Cloudflare) often clear themselves within seconds.
    await JA.sleep(4000);
    const kind = JA.detectVerification();
    if (!kind) return true;

    JA.panel.show('This site wants to check that you are human. Complete the check in this tab. I will continue automatically once it is done.', {
      tone: 'warning',
    });
    const res = await JA.send({ type: 'verification:start', kind, applicationId, url: location.href, title: document.title }).catch(() => null);
    const alertId = res?.alertId ?? null;

    const deadline = Date.now() + timeoutMs;
    let clearPolls = 0;
    while (Date.now() < deadline && clearPolls < 2) {
      await JA.sleep(2000);
      clearPolls = JA.detectVerification() ? 0 : clearPolls + 1;
    }
    const solved = clearPolls >= 2;
    await JA.send({ type: 'verification:end', alertId, status: solved ? 'resolved' : 'expired' }).catch(() => null);
    JA.panel.show(solved ? 'Thanks! Continuing…' : 'The verification was not completed in time, so I skipped this job.', {
      tone: solved ? 'success' : 'error',
    });
    return solved;
  };
})();

// Shared helpers for all content scripts (they share one isolated world per frame).
(() => {
  if (globalThis.JA?.ready) return;
  const JA = (globalThis.JA = globalThis.JA || {});
  JA.ready = true;

  JA.onLinkedIn = /(^|\.)linkedin\.com$/.test(location.hostname);

  // LinkedIn sometimes renders the Easy Apply dialog inside the open shadow root of
  // #interop-outlet (possibly nested). These helpers search the page and those roots.
  JA.roots = () => {
    const roots = [document];
    const hosts = [...document.querySelectorAll('#interop-outlet, [data-testid="interop-shadowdom"]')];
    for (let i = 0; i < hosts.length && i < 20; i++) {
      const sr = hosts[i].shadowRoot;
      if (!sr || roots.includes(sr)) continue;
      roots.push(sr);
      for (const el of sr.querySelectorAll('*')) if (el.shadowRoot) hosts.push(el);
    }
    return roots;
  };
  JA.queryAllDeep = (selector) => JA.roots().flatMap((r) => [...r.querySelectorAll(selector)]);

  JA.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  JA.jitter = (minSec = 2, maxSec = 5) => JA.sleep((minSec + Math.random() * Math.max(0, maxSec - minSec)) * 1000);

  JA.visible = (el) => {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };

  // innerText, whitespace-collapsed, with LinkedIn's "visually hidden" duplicates removed.
  JA.text = (el) => {
    const t = (el?.innerText ?? el?.textContent ?? '').replace(/\s+/g, ' ').trim();
    return dedupeHalves(t);
  };
  function dedupeHalves(t) {
    const words = t.split(' ');
    if (words.length >= 2 && words.length % 2 === 0) {
      const half = words.length / 2;
      const a = words.slice(0, half).join(' ');
      if (a === words.slice(half).join(' ')) return a;
    }
    return t;
  }

  JA.waitFor = async (fn, { timeout = 10_000, interval = 250 } = {}) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try {
        const v = fn();
        if (v) return v;
      } catch {
        // keep polling
      }
      await JA.sleep(interval);
    }
    return null;
  };

  JA.send = (msg) => chrome.runtime.sendMessage(msg);

  JA.api = async (method, path, body) => {
    const res = await JA.send({ type: 'api', method, path, body });
    if (!res?.ok) throw new Error(res?.error || `Server returned ${res?.status ?? 'no response'}`);
    return res.data;
  };

  // React/Vue/Angular track input values internally; use the native setter and
  // fire the events frameworks listen to.
  JA.setValue = (el, value) => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    el.focus({ preventScroll: true });
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  };

  JA.findButton = (root, pattern, selector = 'button, a[role="button"], a, input[type="submit"], input[type="button"]') =>
    [...root.querySelectorAll(selector)].find((b) => {
      if (!JA.visible(b) || b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
      const label = `${JA.text(b)} ${b.getAttribute('aria-label') ?? ''} ${b.value ?? ''}`.trim();
      return pattern.test(label);
    }) ?? null;

  // Floating status card, isolated from the page's CSS with a shadow root.
  JA.panel = (() => {
    let host;
    let box;
    const ensure = () => {
      if (host?.isConnected) return;
      host = document.createElement('div');
      host.id = 'job-autopilot-panel';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `<style>
        .box { position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; width: 320px; max-width: calc(100vw - 32px);
          font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color: #0b0b0b; background: #fcfcfb;
          border: 1px solid rgba(11,11,11,.12); border-left: 4px solid #2a78d6; border-radius: 10px;
          box-shadow: 0 8px 24px rgba(0,0,0,.18); padding: 12px 14px; }
        .box[data-tone="warning"] { border-left-color: #fab219; background: #fff8e8; }
        .box[data-tone="error"] { border-left-color: #d03b3b; }
        .box[data-tone="success"] { border-left-color: #0ca30c; }
        .title { font-weight: 600; margin-bottom: 4px; display: flex; justify-content: space-between; }
        .close { border: 0; background: none; cursor: pointer; font-size: 16px; line-height: 1; color: #52514e; }
        .actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
        .actions:empty { display: none; }
        .actions button { font: inherit; border: 1px solid #c3c2b7; background: #fff; border-radius: 6px; padding: 4px 10px; cursor: pointer; }
        .actions button.primary { background: #2a78d6; border-color: #2a78d6; color: #fff; }
      </style>
      <div class="box" role="status" aria-live="polite">
        <div class="title"><span>Job Autopilot</span><button class="close" aria-label="Hide">×</button></div>
        <div class="msg"></div><div class="actions"></div>
      </div>`;
      box = root.querySelector('.box');
      root.querySelector('.close').addEventListener('click', () => host.remove());
      document.documentElement.append(host);
    };
    return {
      show(text, { tone = 'info', actions = [] } = {}) {
        // Never inject anything into LinkedIn pages (its terms forbid modifying the
        // page, and it scans the DOM for extensions); report status to the popup instead.
        if (JA.onLinkedIn) {
          JA.send({ type: 'status:update', text, tone }).catch(() => {});
          return;
        }
        ensure();
        box.dataset.tone = tone;
        box.querySelector('.msg').textContent = text;
        const bar = box.querySelector('.actions');
        bar.replaceChildren(
          ...actions.map((a) => {
            const b = document.createElement('button');
            b.textContent = a.label;
            if (a.primary) b.className = 'primary';
            b.addEventListener('click', a.onClick);
            return b;
          }),
        );
      },
      hide() {
        host?.remove();
      },
    };
  })();
})();

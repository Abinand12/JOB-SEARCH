// Service worker: talks to the Railway API, tracks which tabs are part of an
// auto-apply run, and raises notifications when a human has to step in.
// MV3 workers are short-lived, so run state lives in chrome.storage.session.

const SESSION_DEFAULTS = {
  running: false,
  linkedinTabId: null,
  pendingExternal: null, // { fromTabId, applicationId, job, at }
  atsTabs: {}, // tabId -> { mode, applicationId, job, originTabId, done }
  alertsByTab: {}, // tabId -> alertId
  status: null, // { text, tone, at } latest bot status, shown in the popup
};

async function getState() {
  const stored = await chrome.storage.session.get(Object.keys(SESSION_DEFAULTS));
  return { ...SESSION_DEFAULTS, ...stored };
}
const setState = (patch) => chrome.storage.session.set(patch);

async function getConfig() {
  const { serverUrl = '', token = '' } = await chrome.storage.local.get(['serverUrl', 'token']);
  return { serverUrl: serverUrl.replace(/\/+$/, ''), token };
}

async function apiFetch(method, path, body) {
  const { serverUrl, token } = await getConfig();
  if (!serverUrl || !token) {
    return { ok: false, status: 0, error: 'Open the Job Autopilot options and connect it to your dashboard first.' };
  }
  try {
    const res = await fetch(`${serverUrl}/api${path}`, {
      method,
      headers: { 'x-extension-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data, error: res.ok ? undefined : data?.error ?? `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, status: 0, error: `Cannot reach ${serverUrl}: ${error.message}` };
  }
}

// --- resume (cached in memory; refetched when the worker restarts) ----------
let resumeCache = null;
async function getResume() {
  if (resumeCache && Date.now() - resumeCache.at < 10 * 60_000) return { ok: true, data: resumeCache.data };
  const { serverUrl, token } = await getConfig();
  const res = await fetch(`${serverUrl}/api/resume/file`, { headers: { 'x-extension-token': token } });
  if (!res.ok) return { ok: false, error: (await res.json().catch(() => null))?.error ?? 'Could not download resume' };
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const data = {
    base64: btoa(binary),
    filename: decodeURIComponent(res.headers.get('x-filename') || 'resume.pdf'),
    mime: res.headers.get('content-type')?.split(';')[0] || 'application/pdf',
  };
  resumeCache = { at: Date.now(), data };
  return { ok: true, data };
}

// --- settings (cached briefly) ---------------------------------------------
let sessionCache = null;
async function getSession() {
  if (sessionCache && Date.now() - sessionCache.at < 60_000) return sessionCache.data;
  const res = await apiFetch('GET', '/session');
  if (!res.ok) throw new Error(res.error);
  sessionCache = { at: Date.now(), data: res.data };
  return res.data;
}

// --- notifications & badge ----------------------------------------------------
function notify(id, title, message, requireInteraction = false) {
  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 2,
    requireInteraction,
  });
}

async function refreshBadge() {
  const { alertsByTab, running } = await getState();
  const open = Object.keys(alertsByTab).length;
  await chrome.action.setBadgeBackgroundColor({ color: open ? '#fab219' : '#2a78d6' });
  await chrome.action.setBadgeText({ text: open ? '!' : running ? 'ON' : '' });
}

chrome.notifications.onClicked.addListener(async (notificationId) => {
  const tabId = Number(notificationId.split(':')[1]);
  if (!Number.isFinite(tabId)) return;
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch {
    // tab was closed
  }
  chrome.notifications.clear(notificationId);
});

async function resolveTabAlert(tabId, status = 'resolved') {
  const state = await getState();
  const alertId = state.alertsByTab[tabId];
  if (!alertId) return;
  delete state.alertsByTab[tabId];
  await setState({ alertsByTab: state.alertsByTab });
  await apiFetch('PATCH', `/alerts/${alertId}`, { status });
  chrome.notifications.clear(`alert:${tabId}:${alertId}`);
  await refreshBadge();
}

// --- LinkedIn run control ---------------------------------------------------
function linkedinSearchUrl(settings) {
  const url = new URL('https://www.linkedin.com/jobs/search/');
  if (settings.search_keywords) url.searchParams.set('keywords', settings.search_keywords);
  if (settings.search_location) url.searchParams.set('location', settings.search_location);
  if (settings.easy_apply_only) url.searchParams.set('f_AL', 'true');
  url.searchParams.set('sortBy', 'DD');
  return url.toString();
}

async function startLinkedIn() {
  const { cooldownUntil = 0, cooldownReason = '' } = await chrome.storage.local.get(['cooldownUntil', 'cooldownReason']);
  if (Date.now() < cooldownUntil) {
    const until = new Date(cooldownUntil).toLocaleString();
    throw new Error(`${cooldownReason} You can start again after ${until}.`);
  }
  const session = await getSession();
  if (!session.has_resume) throw new Error('Upload your resume in the dashboard first.');
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  let tab = active;
  if (!active?.url?.startsWith('https://www.linkedin.com/jobs/')) {
    tab = await chrome.tabs.create({ url: linkedinSearchUrl(session.settings) });
  }
  await setState({ running: true, linkedinTabId: tab.id });
  await refreshBadge();
  // An already-loaded tab gets the message; a new tab starts itself via state:get.
  chrome.tabs.sendMessage(tab.id, { type: 'linkedin:start' }).catch(() => {});
  return { ok: true };
}

async function stopLinkedIn() {
  const state = await getState();
  await setState({ running: false });
  if (state.linkedinTabId) chrome.tabs.sendMessage(state.linkedinTabId, { type: 'linkedin:stop' }).catch(() => {});
  await refreshBadge();
  return { ok: true };
}

// --- message handlers ---------------------------------------------------------
const handlers = {
  api: (msg) => apiFetch(msg.method, msg.path, msg.body),
  resume: () => getResume(),

  'state:get': async (_msg, sender) => {
    const state = await getState();
    return { running: state.running, isBotTab: sender.tab?.id === state.linkedinTabId };
  },
  'popup:status': async () => {
    const config = await getConfig();
    const state = await getState();
    if (!config.serverUrl || !config.token) return { configured: false };
    sessionCache = null;
    try {
      const session = await getSession();
      const { cooldownUntil = 0 } = await chrome.storage.local.get('cooldownUntil');
      return {
        configured: true,
        running: state.running,
        botStatus: state.status,
        cooldownUntil: cooldownUntil > Date.now() ? cooldownUntil : null,
        dashboardUrl: config.serverUrl,
        ...session,
      };
    } catch (error) {
      return { configured: true, error: error.message, dashboardUrl: config.serverUrl };
    }
  },
  'linkedin:start': () => startLinkedIn(),
  'linkedin:stop': () => stopLinkedIn(),
  'status:update': async (msg) => {
    await setState({ status: { text: String(msg.text ?? '').slice(0, 300), tone: msg.tone ?? 'info', at: Date.now() } });
    return { ok: true };
  },
  'linkedin:finished': async (msg) => {
    if (msg.cooldownHours > 0) {
      await chrome.storage.local.set({ cooldownUntil: Date.now() + msg.cooldownHours * 3_600_000, cooldownReason: msg.reason });
    }
    await setState({ running: false, status: { text: msg.reason, tone: msg.cooldownHours ? 'error' : 'info', at: Date.now() } });
    await refreshBadge();
    notify(`done:${Date.now()}`, 'Job Autopilot stopped', msg.reason || 'Run finished');
    return { ok: true };
  },

  'external:expect': async (msg, sender) => {
    await setState({ pendingExternal: { fromTabId: sender.tab.id, applicationId: msg.applicationId, job: msg.job, at: Date.now() } });
    return { ok: true };
  },
  'external:cancel': async () => {
    await setState({ pendingExternal: null });
    return { ok: true };
  },

  'ats:session': async (_msg, sender) => {
    const state = await getState();
    const entry = state.atsTabs[sender.tab?.id];
    if (!entry || entry.done) return null;
    const session = await getSession().catch(() => null);
    return { ...entry, settings: session?.settings ?? {} };
  },
  'ats:done': async (msg, sender) => {
    const tabId = sender.tab?.id;
    const state = await getState();
    const entry = state.atsTabs[tabId];
    if (!entry || entry.done) return { ok: true };
    entry.done = true;
    await setState({ atsTabs: state.atsTabs });

    if (entry.applicationId) {
      await apiFetch('PATCH', `/applications/${entry.applicationId}`, {
        status: msg.status,
        failure_reason: msg.reason ?? null,
        questions_answered: msg.questions ?? 0,
        llm_answers: msg.llm ?? 0,
      });
    }
    if (entry.originTabId) {
      chrome.tabs.sendMessage(entry.originTabId, { type: 'external:done', status: msg.status }).catch(() => {});
    }
    if (msg.status === 'submitted' && entry.mode === 'linkedin') {
      setTimeout(() => chrome.tabs.remove(tabId).catch(() => {}), 3000);
    }
    return { ok: true };
  },
  'assist:start': async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/.test(tab.url ?? '')) throw new Error('Open a job application page first.');
    if (/^https:\/\/www\.linkedin\.com\//.test(tab.url)) throw new Error('On LinkedIn, use "Start auto-apply" instead.');
    const res = await apiFetch('POST', '/applications', {
      job_url: tab.url.split('#')[0],
      job_title: tab.title?.slice(0, 500) ?? '',
      company: new URL(tab.url).hostname.replace(/^www\./, ''),
      source: 'direct',
      method: 'manual_assist',
      ats: 'other',
    });
    if (!res.ok) throw new Error(res.error);
    const entry = { mode: 'assist', applicationId: res.data.application.id, job: { title: tab.title, url: tab.url } };
    const state = await getState();
    state.atsTabs[tab.id] = entry;
    await setState({ atsTabs: state.atsTabs });
    const session = await getSession();
    await chrome.tabs.sendMessage(tab.id, { type: 'ats:start', session: { ...entry, settings: session.settings } });
    return { ok: true };
  },

  'verification:start': async (msg, sender) => {
    const tabId = sender.tab?.id;
    const res = await apiFetch('POST', '/alerts', {
      application_id: msg.applicationId ?? null,
      kind: msg.kind,
      page_url: msg.url,
      page_title: msg.title?.slice(0, 500),
    });
    const alertId = res.data?.alert?.id ?? null;
    if (alertId) {
      const state = await getState();
      state.alertsByTab[tabId] = alertId;
      await setState({ alertsByTab: state.alertsByTab });
    }
    const what = msg.kind === 'login_required' ? 'Sign in or create an account' : 'Complete the human verification';
    notify(`alert:${tabId}:${alertId}`, 'Job Autopilot needs you', `${what} on ${new URL(msg.url).hostname}. Click to open the tab.`, true);
    await refreshBadge();
    return { ok: true, alertId };
  },
  'verification:end': async (msg, sender) => {
    await resolveTabAlert(sender.tab?.id, msg.status === 'resolved' ? 'resolved' : 'expired');
    return { ok: true };
  },
  'verification:tab-clear': async (_msg, sender) => {
    await resolveTabAlert(sender.tab?.id, 'resolved');
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg, sender))
    .then(sendResponse, (error) => sendResponse({ ok: false, error: error.message }));
  return true; // async response
});

// --- tab tracking ---------------------------------------------------------------
chrome.tabs.onCreated.addListener(async (tab) => {
  const state = await getState();
  const pending = state.pendingExternal;
  if (!pending || tab.openerTabId !== pending.fromTabId || Date.now() - pending.at > 30_000) return;
  state.atsTabs[tab.id] = { mode: 'linkedin', applicationId: pending.applicationId, job: pending.job, originTabId: pending.fromTabId };
  await setState({ atsTabs: state.atsTabs, pendingExternal: null });
  chrome.tabs.sendMessage(pending.fromTabId, { type: 'external:opened' }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  const entry = state.atsTabs[tabId];
  if (entry && !entry.done) {
    if (entry.applicationId) {
      await apiFetch('PATCH', `/applications/${entry.applicationId}`, { status: 'skipped', failure_reason: 'The tab was closed' });
    }
    if (entry.originTabId) chrome.tabs.sendMessage(entry.originTabId, { type: 'external:done', status: 'skipped' }).catch(() => {});
  }
  delete state.atsTabs[tabId];
  const patch = { atsTabs: state.atsTabs };
  if (state.linkedinTabId === tabId) Object.assign(patch, { running: false, linkedinTabId: null });
  await setState(patch);
  if (state.alertsByTab[tabId]) await resolveTabAlert(tabId, 'expired');
  await refreshBadge();
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

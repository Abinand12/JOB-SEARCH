const $ = (id) => document.getElementById(id);
const show = (id, on = true) => $(id).classList.toggle('hidden', !on);

async function refresh() {
  const s = await chrome.runtime.sendMessage({ type: 'popup:status' });
  if (!s.configured) {
    $('status').textContent = 'Not connected yet. Open Settings and paste your dashboard address and token.';
    $('dashboard').classList.add('hidden');
    return;
  }
  $('dashboard').href = s.dashboardUrl;
  if (s.error) {
    $('status').textContent = '';
    $('error').textContent = s.error;
    return;
  }
  $('status').textContent = s.running ? 'Running on LinkedIn.' : s.name ? `Ready, ${s.name.split(' ')[0]}.` : 'Ready.';
  $('today').textContent = `${s.submitted_today} / ${s.settings.daily_limit} applications today`;
  show('today');
  if (s.botStatus?.text) {
    $('bot-status').textContent = s.botStatus.text;
    $('bot-status').className = `bot-status ${s.botStatus.tone ?? ''}`;
  }
  if (s.cooldownUntil) {
    $('bot-status').textContent = `${s.botStatus?.text ?? 'LinkedIn asked to slow down.'} Next start allowed after ${new Date(s.cooldownUntil).toLocaleString()}.`;
    $('bot-status').className = 'bot-status warning';
  }
  show('bot-status', Boolean(s.botStatus?.text || s.cooldownUntil));
  if (!s.has_resume) $('error').textContent = 'Upload your resume in the dashboard before starting.';
  show('start', !s.running && s.has_resume);
  show('stop', s.running);
  show('assist', s.has_resume);
}

async function run(type) {
  $('error').textContent = '';
  const res = await chrome.runtime.sendMessage({ type });
  if (res && res.ok === false) $('error').textContent = res.error;
  else if (type === 'assist:start') window.close();
  await refresh();
}

// "Check this LinkedIn page": asks the LinkedIn content script which parts of the
// page it can find. Works without a server connection.
let lastReport = null;
async function activeLinkedInTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url?.startsWith('https://www.linkedin.com/') ? tab : null;
}

async function diagnose() {
  const tab = await activeLinkedInTab();
  if (!tab) return;
  $('error').textContent = '';
  let report;
  try {
    report = await chrome.tabs.sendMessage(tab.id, { type: 'linkedin:diagnose' });
  } catch {
    $('error').textContent = 'Reload the LinkedIn tab (the extension was installed or updated after it opened), then try again.';
    return;
  }
  lastReport = report;
  const failed = report.checks.filter((c) => !c.ok && !c.optional);
  $('report-summary').textContent = report.ok
    ? 'Everything the bot needs was found on this page.'
    : `${failed.length} required item(s) not found. Copy the report and send it to whoever maintains your bot.`;
  $('report-list').replaceChildren(
    ...report.checks.map((c) => {
      const li = document.createElement('li');
      li.className = c.ok ? 'ok' : c.optional ? 'optional' : 'fail';
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = c.ok ? '✓' : c.optional ? '–' : '✗';
      const text = document.createElement('span');
      text.textContent = c.detail ? `${c.label}: ${c.detail}` : c.label;
      li.append(mark, text);
      return li;
    }),
  );
  show('report');
}

$('diagnose').addEventListener('click', diagnose);
$('copy-report').addEventListener('click', async () => {
  if (!lastReport) return;
  await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2));
  $('copy-report').textContent = 'Copied';
});
activeLinkedInTab().then((tab) => show('diagnose', Boolean(tab)));

$('start').addEventListener('click', () => run('linkedin:start'));
$('stop').addEventListener('click', () => run('linkedin:stop'));
$('assist').addEventListener('click', () => run('assist:start'));
refresh();

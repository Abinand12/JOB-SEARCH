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

$('start').addEventListener('click', () => run('linkedin:start'));
$('stop').addEventListener('click', () => run('linkedin:stop'));
$('assist').addEventListener('click', () => run('assist:start'));
refresh();

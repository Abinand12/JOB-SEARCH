const $ = (id) => document.getElementById(id);

const stored = await chrome.storage.local.get(['serverUrl', 'token']);
$('serverUrl').value = stored.serverUrl ?? '';
$('token').value = stored.token ?? '';

$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const serverUrl = $('serverUrl').value.trim().replace(/\/+$/, '');
  const token = $('token').value.trim();
  await chrome.storage.local.set({ serverUrl, token });
  $('result').textContent = 'Testing…';
  const res = await chrome.runtime.sendMessage({ type: 'api', method: 'GET', path: '/session' });
  $('result').textContent = res.ok
    ? `Connected${res.data.name ? ` as ${res.data.name}` : ''}. ${res.data.has_resume ? 'Resume found.' : 'Upload your resume in the dashboard next.'}`
    : `Could not connect: ${res.error}`;
});

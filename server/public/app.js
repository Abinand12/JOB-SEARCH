/* global Chart */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Only http(s) links from stored data become clickable.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? '')) ? esc(u) : '#');
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const fmt = new Intl.NumberFormat();

const STATUS_LABELS = {
  submitted: 'Submitted',
  in_progress: 'In progress',
  needs_verification: 'Needs verification',
  needs_review: 'Needs your review',
  failed: 'Failed',
  skipped: 'Skipped',
};
const METHOD_LABELS = {
  easy_apply: 'LinkedIn Easy Apply',
  external_autofill: 'Company site (auto-filled)',
  manual_assist: 'Assisted on any site',
};
const ATS_LABELS = {
  linkedin: 'LinkedIn',
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  workday: 'Workday',
  ashby: 'Ashby',
  smartrecruiters: 'SmartRecruiters',
  icims: 'iCIMS',
  workable: 'Workable',
  bamboohr: 'BambooHR',
  jobvite: 'Jobvite',
  taleo: 'Taleo',
  successfactors: 'SuccessFactors',
  naukri: 'Naukri',
  indeed: 'Indeed',
  other: 'Other sites',
};
const ALERT_LABELS = {
  recaptcha: 'reCAPTCHA',
  hcaptcha: 'hCaptcha',
  turnstile: 'Cloudflare check',
  cloudflare: 'Cloudflare check',
  arkose: 'puzzle verification',
  linkedin_checkpoint: 'LinkedIn security check',
  login_required: 'sign-in or account creation',
  unknown: 'human verification',
};

let supabase;
let currentUser;
const charts = {};
const state = { days: 30, stats: null, me: null, appsOffset: 0, seenAlerts: new Set(), firstAlertLoad: true };
const PAGE_SIZE = 25;

// ---------------------------------------------------------------------------
// Boot & auth
// ---------------------------------------------------------------------------

async function init() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const { data } = await supabase.auth.getSession();
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.reload();
  });
  if (data.session) startApp(data.session.user);
  else showAuth();
}

function showAuth() {
  $('#auth').classList.remove('hidden');
  $('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = e.submitter?.dataset.mode ?? 'signin';
    const form = new FormData(e.target);
    const creds = { email: form.get('email'), password: form.get('password') };
    const msg = $('#auth-message');
    msg.textContent = mode === 'signup' ? 'Creating account…' : 'Signing in…';
    const { data, error } =
      mode === 'signup'
        ? // Bring the confirmation link back to this dashboard (must be in Supabase's Redirect URLs).
          await supabase.auth.signUp({ ...creds, options: { emailRedirectTo: location.origin } })
        : await supabase.auth.signInWithPassword(creds);
    if (error) {
      msg.textContent = error.message;
      return;
    }
    if (!data.session) {
      msg.textContent = 'Check your inbox to confirm your email, then sign in.';
      return;
    }
    $('#auth').classList.add('hidden');
    startApp(data.session.user);
  });
}

async function api(path, opts = {}) {
  const { data } = await supabase.auth.getSession();
  const headers = { authorization: `Bearer ${data.session?.access_token}`, ...opts.headers };
  let body = opts.body;
  if (body && !(body instanceof FormData)) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { ...opts, headers, body });
  if (res.status === 204) return null;
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload.error || `Request failed (${res.status})`);
  return payload;
}

function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.append(el);
  setTimeout(() => el.remove(), 2500);
}

async function startApp(user) {
  currentUser = user;
  $('#app').classList.remove('hidden');
  $('#user-email').textContent = user.email ?? '';
  $('#server-url').textContent = location.origin;
  $('#signout').addEventListener('click', () => supabase.auth.signOut());
  setupTabs();
  setupNotifications();

  state.me = await api('/me');
  $('#model-badge').textContent = `AI: ${state.me.llm.provider} · ${state.me.llm.model}`;

  setupOverview();
  setupApplications();
  setupProfile();
  setupAnswers();
  setupSettings();
  await Promise.all([loadOverview(), refreshAlerts()]);
  subscribeRealtime();
  setInterval(refreshAlerts, 20_000); // fallback if Realtime is not enabled
}

function setupTabs() {
  const loaders = { applications: loadApplications, answers: loadAnswers, settings: loadTokens, overview: loadOverview };
  $$('nav.tabs button').forEach((btn) =>
    btn.addEventListener('click', () => {
      $$('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b === btn)));
      $$('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== btn.dataset.tab));
      loaders[btn.dataset.tab]?.();
    }),
  );
}

// ---------------------------------------------------------------------------
// Verification alerts
// ---------------------------------------------------------------------------

function setupNotifications() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  const btn = $('#notify-btn');
  btn.classList.remove('hidden');
  btn.addEventListener('click', async () => {
    await Notification.requestPermission();
    btn.classList.add('hidden');
  });
}

async function refreshAlerts() {
  let alerts;
  try {
    ({ alerts } = await api('/alerts?status=open'));
  } catch {
    return;
  }
  const box = $('#alerts');
  box.innerHTML = alerts
    .map((a) => {
      const where = a.applications?.company || hostOf(a.page_url);
      const job = a.applications?.job_title ? ` · ${esc(a.applications.job_title)}` : '';
      return `<div class="alert" role="alert">
        <span class="icon" aria-hidden="true">⚠</span>
        <div class="body">
          <strong>Verification needed: ${esc(ALERT_LABELS[a.kind] ?? a.kind)} on ${esc(where)}${job}</strong>
          <span class="secondary">The bot is paused on that tab. Switch to it (click the extension's notification), complete the check, and the bot continues by itself. Raised ${esc(timeAgo(a.created_at))}.</span>
        </div>
        ${a.page_url ? `<a class="btn small" href="${safeUrl(a.page_url)}" target="_blank" rel="noopener">Open page</a>` : ''}
        <button class="btn small" type="button" data-resolve="${esc(a.id)}">Dismiss</button>
      </div>`;
    })
    .join('');
  $$('[data-resolve]', box).forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/alerts/${btn.dataset.resolve}`, { method: 'PATCH', body: { status: 'expired' } });
      refreshAlerts();
    }),
  );

  document.title = alerts.length ? `(${alerts.length}) Verification needed · Job Autopilot` : 'Job Autopilot';
  for (const a of alerts) {
    if (state.seenAlerts.has(a.id)) continue;
    state.seenAlerts.add(a.id);
    if (!state.firstAlertLoad && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Job Autopilot needs you', {
        body: `Complete the ${ALERT_LABELS[a.kind] ?? 'verification'} on ${a.applications?.company || hostOf(a.page_url)}`,
        tag: a.id,
      });
    }
  }
  state.firstAlertLoad = false;
}

function subscribeRealtime() {
  let pending;
  const refreshSoon = () => {
    clearTimeout(pending);
    pending = setTimeout(() => {
      if (!$('[data-panel="overview"]').classList.contains('hidden')) loadOverview();
      if (!$('[data-panel="applications"]').classList.contains('hidden')) loadApplications();
    }, 1500);
  };
  supabase
    .channel('autopilot')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'verification_alerts', filter: `user_id=eq.${currentUser.id}` }, refreshAlerts)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'applications', filter: `user_id=eq.${currentUser.id}` }, refreshSoon)
    .subscribe();
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function setupOverview() {
  $$('#range button').forEach((btn) =>
    btn.addEventListener('click', () => {
      state.days = Number(btn.dataset.days);
      $$('#range button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      loadOverview();
    }),
  );
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state.stats && renderCharts(state.stats));
}

async function loadOverview() {
  state.stats = await api(`/stats?days=${state.days}`);
  renderKpis(state.stats);
  renderCharts(state.stats);
  renderTables(state.stats);
}

function renderKpis(s) {
  const limit = state.me?.settings?.daily_limit;
  const rate = s.totals.success_rate === null ? '–' : `${Math.round(s.totals.success_rate * 100)}%`;
  const pending = s.totals.pending_verification;
  const tiles = [
    { label: `Applications submitted, last ${s.range_days} days`, value: fmt.format(s.totals.submitted), sub: `${fmt.format(s.totals.submitted_today)} today${limit ? ` · daily limit ${limit}` : ''}`, hero: true },
    { label: 'Success rate', value: rate, sub: 'submitted vs failed' },
    { label: 'Waiting on you', value: `${pending ? '⚠ ' : ''}${fmt.format(pending)}`, sub: 'verifications to complete' },
    { label: 'Questions answered', value: fmt.format(s.totals.questions_answered), sub: `${fmt.format(s.totals.llm_answers)} needed the AI` },
    { label: 'Jobs tracked', value: fmt.format(s.totals.tracked), sub: 'including failed & skipped' },
  ];
  $('#kpis').innerHTML = tiles
    .map((t) => `<div class="card tile${t.hero ? ' hero' : ''}"><div class="label">${esc(t.label)}</div><div class="value">${esc(t.value)}</div><div class="sub">${esc(t.sub)}</div></div>`)
    .join('');
}

const shortDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

function baseScales({ horizontal = false, stacked = false } = {}) {
  const valueAxis = {
    stacked,
    beginAtZero: true,
    grid: { color: css('--grid'), lineWidth: 1 },
    border: { display: false },
    ticks: { color: css('--text-muted'), precision: 0 },
  };
  const categoryAxis = {
    stacked,
    grid: { display: false },
    border: { color: css('--baseline') },
    ticks: { color: horizontal ? css('--text-secondary') : css('--text-muted'), maxRotation: 0, autoSkip: true, maxTicksLimit: 10 },
  };
  return horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis };
}

function tooltipStyle() {
  return {
    backgroundColor: css('--surface'),
    titleColor: css('--text-primary'),
    bodyColor: css('--text-secondary'),
    borderColor: css('--border'),
    borderWidth: 1,
    padding: 10,
    boxPadding: 4,
    usePointStyle: true,
  };
}

// A stacked segment is the "top" one when nothing visible sits above it.
function isTopSegment(ctx) {
  const { datasets } = ctx.chart.data;
  for (let d = datasets.length - 1; d > ctx.datasetIndex; d--) {
    if (ctx.chart.isDatasetVisible(d) && datasets[d].data[ctx.dataIndex] > 0) return false;
  }
  return true;
}

const valueLabels = {
  id: 'valueLabels',
  afterDatasetsDraw(chart) {
    const { ctx } = chart;
    ctx.save();
    ctx.fillStyle = css('--text-secondary');
    ctx.font = `12px ${css('--font')}`;
    ctx.textBaseline = 'middle';
    chart.getDatasetMeta(0).data.forEach((bar, i) => {
      ctx.fillText(fmt.format(chart.data.datasets[0].data[i]), bar.x + 6, bar.y);
    });
    ctx.restore();
  },
};

function draw(id, config) {
  charts[id]?.destroy();
  charts[id] = new Chart(document.getElementById(id), config);
}

function renderCharts(s) {
  const methods = Object.keys(METHOD_LABELS);
  const colors = [css('--series-1'), css('--series-2'), css('--series-3')];
  const surface = css('--surface');

  draw('chart-daily', {
    type: 'bar',
    data: {
      labels: s.by_day.map((d) => shortDate(d.date)),
      datasets: methods.map((m, i) => ({
        label: METHOD_LABELS[m],
        data: s.by_day.map((d) => d[m]),
        backgroundColor: colors[i],
        borderColor: surface,
        borderWidth: (ctx) => (isTopSegment(ctx) ? 0 : { top: 2, right: 0, bottom: 0, left: 0 }),
        borderSkipped: 'start',
        borderRadius: (ctx) => (isTopSegment(ctx) ? { topLeft: 4, topRight: 4 } : 0),
        maxBarThickness: 24,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          align: 'start',
          labels: { color: css('--text-secondary'), usePointStyle: true, pointStyle: 'rectRounded', boxWidth: 10, boxHeight: 10 },
        },
        tooltip: { ...tooltipStyle(), filter: (item) => item.raw > 0 },
      },
      scales: baseScales({ stacked: true }),
    },
  });

  const horizontal = (id, rows, label) =>
    draw(id, {
      type: 'bar',
      data: {
        labels: rows.map((r) => r.label),
        datasets: [{ label, data: rows.map((r) => r.count), backgroundColor: colors[0], borderRadius: 4, borderSkipped: 'start', maxBarThickness: 24 }],
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { right: 36 } },
        plugins: { legend: { display: false }, tooltip: tooltipStyle() },
        scales: baseScales({ horizontal: true }),
      },
      plugins: [valueLabels],
    });

  horizontal('chart-status', s.by_status.map((r) => ({ label: STATUS_LABELS[r.status], count: r.count })), 'Applications');
  const ats = s.by_ats.length ? s.by_ats : [{ ats: 'linkedin', count: 0 }];
  horizontal('chart-ats', ats.map((r) => ({ label: ATS_LABELS[r.ats] ?? r.ats, count: r.count })), 'Submitted');
}

function simpleTable(headers, rows) {
  return `<table><thead><tr>${headers.map((h, i) => `<th${i ? ' class="num"' : ''}>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderTables(s) {
  const methods = Object.keys(METHOD_LABELS);
  $('#table-daily').innerHTML = simpleTable(
    ['Date', ...methods.map((m) => METHOD_LABELS[m])],
    s.by_day.map((d) => [d.date, ...methods.map((m) => fmt.format(d[m]))]),
  );
  $('#table-status').innerHTML = simpleTable(['Status', 'Applications'], s.by_status.map((r) => [STATUS_LABELS[r.status], fmt.format(r.count)]));
  $('#table-ats').innerHTML = simpleTable(['Platform', 'Submitted'], s.by_ats.map((r) => [ATS_LABELS[r.ats] ?? r.ats, fmt.format(r.count)]));
  $('#top-companies').innerHTML = s.top_companies.length
    ? simpleTable(['Company', 'Submitted'], s.top_companies.map((r) => [r.company, fmt.format(r.count)]))
    : '<p class="muted">No submitted applications in this range yet.</p>';
  const cost = s.llm.estimated_cost_usd;
  $('#llm-usage').innerHTML = simpleTable(
    ['Metric', `Last ${s.range_days} days`],
    [
      ['AI calls', fmt.format(s.llm.calls)],
      ['Input tokens', fmt.format(s.llm.input_tokens)],
      ['Output tokens', fmt.format(s.llm.output_tokens)],
      ['Estimated cost', cost === null ? 'Not priced (free tier or unknown model)' : `$${cost.toFixed(cost < 1 ? 4 : 2)}`],
    ],
  );
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

function setupApplications() {
  $('#app-status').innerHTML += Object.entries(STATUS_LABELS).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  $('#app-method').innerHTML += Object.entries(METHOD_LABELS).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  let debounce;
  const reload = () => {
    state.appsOffset = 0;
    loadApplications();
  };
  $('#app-search').addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(reload, 300);
  });
  $('#app-status').addEventListener('change', reload);
  $('#app-method').addEventListener('change', reload);
  $('#app-prev').addEventListener('click', () => {
    state.appsOffset = Math.max(0, state.appsOffset - PAGE_SIZE);
    loadApplications();
  });
  $('#app-next').addEventListener('click', () => {
    state.appsOffset += PAGE_SIZE;
    loadApplications();
  });
}

const statusPill = (status) =>
  `<span class="status ${esc(status)}"><span class="dot" aria-hidden="true"></span>${esc(STATUS_LABELS[status] ?? status)}</span>`;

async function loadApplications() {
  const params = new URLSearchParams({ limit: PAGE_SIZE, offset: state.appsOffset });
  if ($('#app-search').value) params.set('q', $('#app-search').value);
  if ($('#app-status').value) params.set('status', $('#app-status').value);
  if ($('#app-method').value) params.set('method', $('#app-method').value);
  const { rows, total } = await api(`/applications?${params}`);
  $('#app-table').innerHTML = `<thead><tr><th>Date</th><th>Job</th><th>Company</th><th>Platform</th><th>How</th><th>Status</th><th class="num">AI answers</th></tr></thead>
    <tbody>${
      rows.length
        ? rows
            .map(
              (r) => `<tr>
          <td>${esc(new Date(r.started_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))}</td>
          <td><a href="${safeUrl(r.job_url)}" target="_blank" rel="noopener">${esc(r.job_title || 'Untitled job')}</a>${r.location ? `<div class="muted">${esc(r.location)}</div>` : ''}</td>
          <td>${esc(r.company || '–')}</td>
          <td>${esc(ATS_LABELS[r.ats] ?? r.ats ?? '–')}</td>
          <td>${esc(METHOD_LABELS[r.method] ?? r.method)}</td>
          <td>${statusPill(r.status)}${r.failure_reason ? `<div class="muted">${esc(r.failure_reason)}</div>` : ''}</td>
          <td class="num">${fmt.format(r.llm_answers ?? 0)} / ${fmt.format(r.questions_answered ?? 0)}</td>
        </tr>`,
            )
            .join('')
        : '<tr><td colspan="7" class="muted">No applications match.</td></tr>'
    }</tbody>`;
  const end = Math.min(state.appsOffset + PAGE_SIZE, total);
  $('#app-page').textContent = total ? `${state.appsOffset + 1}–${end} of ${fmt.format(total)}` : '';
  $('#app-prev').disabled = state.appsOffset === 0;
  $('#app-next').disabled = end >= total;
}

// ---------------------------------------------------------------------------
// Generic form builder (profile & settings)
// ---------------------------------------------------------------------------

function renderFields(container, specs, values) {
  container.innerHTML = specs
    .map((f) => {
      const v = values?.[f.key];
      const id = `f-${container.id}-${f.key}`;
      if (f.type === 'bool') {
        return `<label class="check"><input type="checkbox" id="${id}" data-key="${f.key}" ${v ? 'checked' : ''}> ${esc(f.label)}</label>`;
      }
      if (f.type === 'textarea') {
        return `<label style="grid-column:1/-1">${esc(f.label)}<textarea id="${id}" data-key="${f.key}">${esc(v ?? '')}</textarea></label>`;
      }
      if (f.type === 'select') {
        return `<label>${esc(f.label)}<select id="${id}" data-key="${f.key}">${f.options
          .map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`)
          .join('')}</select></label>`;
      }
      const value = f.type === 'list' ? (v ?? []).join(', ') : (v ?? '');
      const type = f.type === 'list' ? 'text' : f.type;
      return `<label>${esc(f.label)}<input type="${type}" id="${id}" data-key="${f.key}" value="${esc(value)}" ${f.placeholder ? `placeholder="${esc(f.placeholder)}"` : ''} ${type === 'number' ? 'step="any" min="0"' : ''}></label>`;
    })
    .join('');
}

function readFields(container, specs) {
  const out = {};
  for (const f of specs) {
    const el = container.querySelector(`[data-key="${f.key}"]`);
    if (!el) continue;
    if (f.type === 'bool') out[f.key] = el.checked;
    else if (f.type === 'number') out[f.key] = el.value === '' ? 0 : Number(el.value);
    else if (f.type === 'list') out[f.key] = el.value.split(',').map((s) => s.trim()).filter(Boolean);
    else out[f.key] = el.value.trim();
  }
  return out;
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

const PERSONAL_FIELDS = [
  { key: 'first_name', label: 'First name' },
  { key: 'last_name', label: 'Last name' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'phone', label: 'Phone' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State / province' },
  { key: 'country', label: 'Country' },
  { key: 'postal_code', label: 'Postal code' },
  { key: 'linkedin_url', label: 'LinkedIn URL', type: 'url' },
  { key: 'github_url', label: 'GitHub URL', type: 'url' },
  { key: 'portfolio_url', label: 'Portfolio / website', type: 'url' },
];
const DECLINE = 'Prefer not to say';
const PREFERENCE_FIELDS = [
  { key: 'authorized_to_work', label: 'Authorized to work where I apply', type: 'bool' },
  { key: 'authorized_countries', label: 'Countries I can work in (comma separated)', type: 'list', placeholder: 'India, United Arab Emirates' },
  { key: 'requires_sponsorship', label: 'I need visa sponsorship', type: 'bool' },
  { key: 'willing_to_relocate', label: 'Willing to relocate', type: 'bool' },
  { key: 'willing_to_work_onsite', label: 'OK with on-site / hybrid', type: 'bool' },
  { key: 'notice_period', label: 'Notice period (text)', placeholder: '30 days' },
  { key: 'notice_period_days', label: 'Notice period in days', type: 'number' },
  { key: 'earliest_start_date', label: 'Earliest start date', type: 'date' },
  { key: 'expected_salary', label: 'Expected salary', placeholder: '1800000' },
  { key: 'current_salary', label: 'Current salary' },
  { key: 'salary_currency', label: 'Salary currency', placeholder: 'INR' },
  { key: 'phone_country_code', label: 'Phone country code', placeholder: '+91' },
  { key: 'address', label: 'Street address' },
  { key: 'date_of_birth', label: 'Date of birth (only if you want it filled)', type: 'date' },
  { key: 'referral_source', label: '"How did you hear about us?"' },
  { key: 'has_drivers_license', label: "I have a driver's license", type: 'bool' },
  { key: 'background_check_ok', label: 'OK with background checks', type: 'bool' },
  { key: 'gender', label: 'Gender (EEO questions)', type: 'select', options: [DECLINE, 'Female', 'Male', 'Non-binary'] },
  { key: 'pronouns', label: 'Pronouns (leave blank to skip)' },
  { key: 'ethnicity', label: 'Race / ethnicity (EEO)', placeholder: DECLINE },
  { key: 'veteran_status', label: 'Veteran status (EEO)', type: 'select', options: [DECLINE, 'I am not a protected veteran', 'I am a protected veteran'] },
  { key: 'disability_status', label: 'Disability (EEO)', type: 'select', options: [DECLINE, 'No, I do not have a disability', 'Yes, I have a disability'] },
];
const CAREER_FIELDS = [
  { key: 'headline', label: 'Headline' },
  { key: 'current_title', label: 'Current title' },
  { key: 'current_company', label: 'Current company' },
  { key: 'total_years_experience', label: 'Total years of experience', type: 'number' },
  { key: 'summary', label: 'Summary', type: 'textarea' },
];
const CAREER_JSON_KEYS = ['skills', 'experience', 'education', 'certifications', 'languages'];

function renderProfile(profile) {
  renderFields($('#personal-fields'), PERSONAL_FIELDS, profile.personal);
  renderFields($('#preference-fields'), PREFERENCE_FIELDS, profile.preferences);
  renderFields($('#career-fields'), CAREER_FIELDS, profile);
  $('#career-json').value = JSON.stringify(Object.fromEntries(CAREER_JSON_KEYS.map((k) => [k, profile[k] ?? []])), null, 2);
  const resume = state.me.resume;
  $('#resume-current').textContent = resume ? `Current: ${resume.filename}` : 'No resume uploaded yet';
}

function setupProfile() {
  renderProfile(state.me.profile);

  $('#resume-upload').addEventListener('click', async () => {
    const file = $('#resume-file').files[0];
    if (!file) return toast('Choose a PDF first');
    const status = $('#resume-status');
    status.textContent = 'Reading your resume with AI… (10–30 seconds)';
    const form = new FormData();
    form.append('resume', file);
    try {
      const result = await api('/resume', { method: 'POST', body: form });
      state.me.profile = result.profile;
      state.me.resume = result.resume;
      renderProfile(result.profile);
      status.textContent = 'Done. Review the details below and save.';
    } catch (e) {
      status.innerHTML = `<span class="error-text">${esc(e.message)}</span>`;
    }
  });

  $('#profile-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#profile-status');
    let career;
    try {
      career = JSON.parse($('#career-json').value || '{}');
    } catch {
      status.innerHTML = '<span class="error-text">The details JSON is not valid.</span>';
      return;
    }
    const profile = {
      ...state.me.profile,
      ...readFields($('#career-fields'), CAREER_FIELDS),
      ...Object.fromEntries(CAREER_JSON_KEYS.map((k) => [k, career[k] ?? []])),
      personal: readFields($('#personal-fields'), PERSONAL_FIELDS),
      preferences: { ...state.me.profile.preferences, ...readFields($('#preference-fields'), PREFERENCE_FIELDS) },
    };
    try {
      const result = await api('/profile', { method: 'PUT', body: { profile } });
      state.me.profile = result.profile;
      status.textContent = 'Saved.';
      setTimeout(() => (status.textContent = ''), 2500);
    } catch (err) {
      status.innerHTML = `<span class="error-text">${esc(err.message)}</span>`;
    }
  });
}

// ---------------------------------------------------------------------------
// Saved answers
// ---------------------------------------------------------------------------

let savedAnswers = [];

function setupAnswers() {
  $('#answer-search').addEventListener('input', renderAnswers);
}

async function loadAnswers() {
  ({ answers: savedAnswers } = await api('/saved-answers'));
  renderAnswers();
}

function renderAnswers() {
  const term = $('#answer-search').value.toLowerCase();
  const rows = savedAnswers.filter((a) => !term || a.question.toLowerCase().includes(term));
  $('#answer-table').innerHTML = `<thead><tr><th>Question</th><th>Answer</th><th>By</th><th></th></tr></thead>
    <tbody>${
      rows.length
        ? rows
            .map(
              (a) => `<tr data-id="${esc(a.id)}">
          <td>${esc(a.question)}${a.needs_review ? '<div class="muted">AI answer · not reviewed yet</div>' : ''}</td>
          <td><textarea rows="2" data-answer>${esc(a.answer)}</textarea></td>
          <td>${a.source === 'user' ? 'You' : 'AI'}</td>
          <td><div class="actions" style="margin:0"><button class="btn small" data-save type="button">Save</button><button class="btn small" data-delete type="button">Delete</button></div></td>
        </tr>`,
            )
            .join('')
        : '<tr><td colspan="4" class="muted">No saved answers yet. They appear after the bot answers its first screening questions.</td></tr>'
    }</tbody>`;
  $$('#answer-table tr[data-id]').forEach((tr) => {
    $('[data-save]', tr).addEventListener('click', async () => {
      await api(`/saved-answers/${tr.dataset.id}`, { method: 'PATCH', body: { answer: $('[data-answer]', tr).value } });
      toast('Answer saved. The bot will use it from now on.');
      loadAnswers();
    });
    $('[data-delete]', tr).addEventListener('click', async () => {
      await api(`/saved-answers/${tr.dataset.id}`, { method: 'DELETE' });
      loadAnswers();
    });
  });
}

// ---------------------------------------------------------------------------
// Settings & extension tokens
// ---------------------------------------------------------------------------

const SETTINGS_FIELDS = [
  { key: 'daily_limit', label: 'Max applications per day', type: 'number' },
  { key: 'search_keywords', label: 'LinkedIn search keywords', placeholder: 'backend engineer' },
  { key: 'search_location', label: 'LinkedIn search location', placeholder: 'Bengaluru' },
  { key: 'title_include', label: 'Only titles containing (comma separated)', type: 'list', placeholder: 'engineer, developer' },
  { key: 'title_exclude', label: 'Skip titles containing', type: 'list', placeholder: 'intern, principal' },
  { key: 'company_blacklist', label: 'Never apply to these companies', type: 'list' },
  { key: 'min_delay_sec', label: 'Min pause between applications (s)', type: 'number' },
  { key: 'max_delay_sec', label: 'Max pause between applications (s)', type: 'number' },
  { key: 'easy_apply_only', label: 'Only Easy Apply jobs', type: 'bool' },
  { key: 'apply_external', label: 'Also apply on company websites', type: 'bool' },
  { key: 'auto_submit_easy_apply', label: 'Submit Easy Apply automatically (off = stop at review)', type: 'bool' },
  { key: 'auto_submit_external', label: 'Submit on company websites automatically (off = fill and wait for me)', type: 'bool' },
  { key: 'auto_accept_consent', label: 'Tick privacy-policy / terms consent boxes', type: 'bool' },
];

function setupSettings() {
  renderFields($('#settings-fields'), SETTINGS_FIELDS, state.me.settings);
  $('#settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = $('#settings-status');
    try {
      const result = await api('/profile', { method: 'PUT', body: { settings: readFields($('#settings-fields'), SETTINGS_FIELDS) } });
      state.me.settings = result.settings;
      renderFields($('#settings-fields'), SETTINGS_FIELDS, result.settings);
      status.textContent = 'Saved. The extension picks this up on its next run.';
    } catch (err) {
      status.innerHTML = `<span class="error-text">${esc(err.message)}</span>`;
    }
  });

  $('#token-create').addEventListener('click', async () => {
    const result = await api('/tokens', { method: 'POST', body: { label: `Chrome · ${new Date().toLocaleDateString()}` } });
    $('#token-value').textContent = result.token;
    $('#token-new').classList.remove('hidden');
    loadTokens();
  });
  $('#token-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#token-value').textContent);
    toast('Token copied');
  });
}

async function loadTokens() {
  const { tokens } = await api('/tokens');
  $('#token-table').innerHTML = tokens.length
    ? `<thead><tr><th>Token</th><th>Created</th><th>Last used</th><th></th></tr></thead><tbody>${tokens
        .map(
          (t) => `<tr><td>${esc(t.label)}</td><td>${esc(new Date(t.created_at).toLocaleDateString())}</td><td>${esc(t.last_used_at ? timeAgo(t.last_used_at) : 'never')}</td>
          <td><button class="btn small" data-revoke="${esc(t.id)}" type="button">Revoke</button></td></tr>`,
        )
        .join('')}</tbody>`
    : '';
  $$('[data-revoke]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      await api(`/tokens/${btn.dataset.revoke}`, { method: 'DELETE' });
      loadTokens();
    }),
  );
}

// ---------------------------------------------------------------------------

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'a job site';
  }
}

function timeAgo(iso) {
  const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
}

init().catch((e) => {
  document.body.innerHTML = `<div class="wrap"><div class="card auth-card"><h2>Could not start</h2><p class="error-text">${esc(e.message)}</p></div></div>`;
});

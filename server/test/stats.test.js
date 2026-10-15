import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeStats } from '../src/stats.js';
import { extractJson } from '../src/llm/openaiCompatible.js';
import { sanitizeSettings } from '../src/routes/api.js';
import { mergeParsedResume } from '../src/profile.js';

test('computeStats buckets submitted applications by day and method', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  const apps = [
    { status: 'submitted', method: 'easy_apply', ats: 'linkedin', company: 'Acme', started_at: '2026-10-15T09:00:00Z', submitted_at: '2026-10-15T09:02:00Z', llm_answers: 2 },
    { status: 'submitted', method: 'external_autofill', ats: 'greenhouse', company: 'Acme', started_at: '2026-10-14T09:00:00Z', submitted_at: '2026-10-14T09:05:00Z' },
    { status: 'failed', method: 'easy_apply', ats: 'linkedin', company: 'Globex', started_at: '2026-10-13T09:00:00Z' },
    { status: 'needs_verification', method: 'external_autofill', ats: 'lever', started_at: '2026-10-15T10:00:00Z' },
  ];
  const usage = [{ input_tokens: 2_000_000, output_tokens: 100_000 }];
  const stats = computeStats(apps, { days: 7, now, usage, prices: { input: 0.1, output: 0.5 } });

  assert.equal(stats.by_day.length, 7);
  assert.equal(stats.by_day.at(-1).date, '2026-10-15');
  assert.deepEqual(stats.by_day.at(-1), { date: '2026-10-15', easy_apply: 1, external_autofill: 0, manual_assist: 0 });
  assert.equal(stats.totals.submitted, 2);
  assert.equal(stats.totals.submitted_today, 1);
  assert.equal(stats.totals.pending_verification, 1);
  assert.equal(stats.totals.success_rate, 2 / 3);
  assert.deepEqual(stats.top_companies[0], { company: 'Acme', count: 2 });
  assert.deepEqual(stats.by_ats.map((a) => a.ats), ['greenhouse', 'linkedin']);
  assert.equal(stats.llm.estimated_cost_usd, 0.25);
});

test('extractJson tolerates code fences and chatter', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! {"a":2} hope that helps'), { a: 2 });
  assert.equal(extractJson('no json here'), null);
});

test('sanitizeSettings coerces types and keeps delays ordered', () => {
  const s = sanitizeSettings({ daily_limit: '25', title_exclude: 'intern, senior manager', min_delay_sec: 10, max_delay_sec: 2, bogus: 1 });
  assert.equal(s.daily_limit, 25);
  assert.deepEqual(s.title_exclude, ['intern', 'senior manager']);
  assert.equal(s.max_delay_sec, 10);
  assert.equal('bogus' in s, false);
});

test('mergeParsedResume keeps preferences and hand-entered personal fields', () => {
  const merged = mergeParsedResume(
    { personal: { phone: '+1 555 0100', first_name: 'Old' }, preferences: { expected_salary: '90000' } },
    { personal: { first_name: 'Asha', phone: '' }, skills: [{ name: 'Go', years: 2 }] },
  );
  assert.equal(merged.personal.first_name, 'Asha');
  assert.equal(merged.personal.phone, '+1 555 0100');
  assert.equal(merged.preferences.expected_salary, '90000');
  assert.deepEqual(merged.skills, [{ name: 'Go', years: 2 }]);
});

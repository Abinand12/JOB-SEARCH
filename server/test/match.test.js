import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchJob, requiredYears, searchQueries, titleSimilarity } from '../src/match.js';
import { withDefaults } from '../src/profile.js';

const profile = withDefaults({
  current_title: 'Software Engineer',
  target_roles: ['Backend Engineer', 'Platform Engineer'],
  total_years_experience: 4,
  skills: [{ name: 'Go' }, { name: 'Kubernetes' }, { name: 'PostgreSQL' }, { name: 'AWS' }, { name: 'C++' }],
});

test('titles: seniority and developer/engineer wording do not matter', () => {
  assert.equal(titleSimilarity('Senior Backend Developer', 'Backend Engineer'), 1);
  assert.equal(titleSimilarity('SDE II', 'Software Engineer'), 1);
  assert.ok(titleSimilarity('Marketing Engineer', 'Backend Engineer') < 0.4);
  assert.equal(titleSimilarity('Accountant', 'Backend Engineer'), 0);
});

test('a fitting job scores high and lists matched and missing skills', () => {
  const fit = matchJob(profile, {
    title: 'Backend Engineer (Go)',
    description: 'You have 3+ years building services in Go and C++ on Kubernetes and AWS. Kafka is a plus.',
  });
  assert.ok(fit.score >= 80, JSON.stringify(fit));
  assert.deepEqual(fit.skills_matched.sort(), ['aws', 'c++', 'go', 'kubernetes']);
  assert.deepEqual(fit.skills_missing, ['kafka']);
  assert.equal(fit.required_years, 3);
});

test('an unrelated job scores low', () => {
  const fit = matchJob(profile, { title: 'Marketing Manager', description: 'Own SEO, SEM and content marketing. 5+ years.' });
  assert.ok(fit.score < 30, JSON.stringify(fit));
});

test('without a description only the title counts', () => {
  assert.ok(matchJob(profile, { title: 'Platform Engineer' }).score >= 90);
  assert.ok(matchJob(profile, { title: 'Chef' }).score < 20);
});

test('years and seniority requirements lower the score', () => {
  const base = { title: 'Backend Engineer', description: 'Go and Kubernetes.' };
  const easy = matchJob(profile, base).score;
  const hard = matchJob(profile, { ...base, description: 'Go and Kubernetes. 10+ years of experience.' });
  assert.ok(hard.score < easy);
  assert.match(hard.reasons.join(' '), /10\+ years/);
  assert.equal(requiredYears('3-5 years of experience, ideally 7 yrs'), 3);
  assert.equal(requiredYears('founded 150 years ago'), null);
});

test('search queries: your keywords first, else the roles the resume fits', () => {
  assert.deepEqual(searchQueries(profile, { search_keywords: 'go developer; SRE ;' }), ['go developer', 'SRE']);
  assert.deepEqual(searchQueries(profile, { search_keywords: '' }), ['Backend Engineer', 'Platform Engineer', 'Software Engineer']);
  assert.deepEqual(searchQueries(withDefaults({}), {}), ['']);
});

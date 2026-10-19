import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerFields } from '../src/answers.js';
import { formatDate, parseDate, sectionCounts } from '../src/sections.js';

const profile = {
  personal: { first_name: 'Asha', city: 'Kochi', country: 'India' },
  current_company: 'Globex',
  experience: [
    { title: 'Senior Engineer', company: 'Globex', location: 'Bengaluru', start_date: '2021-03', end_date: '', is_current: true, highlights: 'Payments.' },
    { title: 'Engineer', company: 'Initech', location: 'Kochi', start_date: '2018', end_date: '2021-02', is_current: false, highlights: 'Pipelines.' },
  ],
  education: [{ degree: 'B.Tech', field_of_study: 'Computer Science', school: 'CUSAT', start_year: '2013', end_year: '2017', grade: '8.1' }],
  projects: [{ name: 'Ledger', role: 'Author', url: 'https://x.dev/ledger', start_date: '', end_date: '', technologies: ['Go', 'SQLite'], description: 'A ledger.' }],
};

const llm = {
  async generateJson() {
    throw new Error('section fields must not need the AI');
  },
};

async function answer(fields) {
  const { answers } = await answerFields({ fields, profile, llm });
  return Object.fromEntries(answers.map((a) => [a.id, a.value]));
}

test('fields in the 2nd experience block answer from the 2nd job', async () => {
  const exp = (index, id, label, extra = {}) => ({ id, label, type: 'text', section: { kind: 'experience', index }, ...extra });
  const v = await answer([
    exp(0, 'a', 'Company'),
    exp(1, 'b', 'Company'),
    exp(1, 'c', 'Job title'),
    exp(1, 'd', 'Start date', { placeholder: 'MM/YYYY' }),
    exp(1, 'e', 'End date', { type: 'date' }),
    exp(0, 'f', 'End date'),
    exp(0, 'g', 'I currently work here', { type: 'checkbox' }),
    exp(1, 'h', 'Role description', { type: 'textarea' }),
    exp(1, 'i', 'Location'),
    exp(2, 'j', 'Company'),
    { id: 'k', label: 'Location', type: 'text' },
  ]);
  assert.deepEqual(v, {
    a: 'Globex',
    b: 'Initech',
    c: 'Engineer',
    d: '2018',
    e: '2021-02-01',
    f: null, // current role has no end date
    g: true,
    h: 'Pipelines.',
    i: 'Kochi',
    j: null, // no third job: leave it
    k: 'Kochi, India',
  });
});

test('education and project blocks', async () => {
  const v = await answer([
    { id: 'a', label: 'School', type: 'text', section: { kind: 'education', index: 0 } },
    { id: 'b', label: 'Field of study', type: 'text', section: { kind: 'education', index: 0 } },
    { id: 'c', label: 'To year', type: 'select', options: ['Year', '2016', '2017'], section: { kind: 'education', index: 0 } },
    { id: 'd', label: 'GPA', type: 'text', section: { kind: 'education', index: 0 } },
    { id: 'e', label: 'Project name', type: 'text', section: { kind: 'project', index: 0 } },
    { id: 'f', label: 'Technologies used', type: 'text', section: { kind: 'project', index: 0 } },
    { id: 'g', label: 'Project URL', type: 'url', section: { kind: 'project', index: 0 } },
    { id: 'h', label: 'Your role', type: 'text', section: { kind: 'project', index: 0 } },
  ]);
  assert.deepEqual(v, { a: 'CUSAT', b: 'Computer Science', c: '2017', d: '8.1', e: 'Ledger', f: 'Go, SQLite', g: 'https://x.dev/ledger', h: 'Author' });
});

test('dates: parse resume formats, format for the field', () => {
  assert.deepEqual(parseDate('2021-03'), { year: 2021, month: 3 });
  assert.deepEqual(parseDate('Mar 2021'), { year: 2021, month: 3 });
  assert.deepEqual(parseDate('2019'), { year: 2019, month: null });
  assert.equal(formatDate('2021-03', { type: 'text' }, 'start date'), '03/2021');
  assert.equal(formatDate('2021-03', { type: 'select', options: ['January', 'March'] }, 'start month'), 'March');
  assert.equal(formatDate('2021-03', { type: 'text' }, 'start month'), '3');
  assert.equal(formatDate('2021-03', { type: 'text', placeholder: 'YYYY-MM' }, 'from'), '2021-03');
  assert.equal(formatDate('2021-03', { type: 'date' }, 'from'), '2021-03-01');
});

test('section counts are capped', () => {
  const many = { experience: Array(9).fill({}), education: [{}], projects: [] };
  assert.deepEqual(sectionCounts(many), { experience: 5, education: 1, project: 0 });
});

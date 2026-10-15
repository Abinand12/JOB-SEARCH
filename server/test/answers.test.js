import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answerFields, coerce, findRule, matchOption, normalizeQuestion, RESUME_TOKEN } from '../src/answers.js';

const profile = {
  personal: {
    first_name: 'Asha',
    last_name: 'Menon',
    email: 'asha@example.com',
    phone: '+91 98765 43210',
    city: 'Kochi',
    state: 'Kerala',
    country: 'India',
    linkedin_url: 'https://linkedin.com/in/asha',
  },
  current_title: 'Backend Engineer',
  current_company: 'Acme',
  total_years_experience: 4.6,
  skills: [
    { name: 'Python', years: 4 },
    { name: 'AWS', years: 2.5 },
  ],
  education: [{ degree: "Bachelor's Degree", field_of_study: 'Computer Science', school: 'CUSAT' }],
  preferences: {
    authorized_countries: ['India'],
    requires_sponsorship: false,
    notice_period: '30 days',
    notice_period_days: 30,
    expected_salary: '',
  },
};

test('normalizeQuestion strips noise but keeps tech symbols', () => {
  assert.equal(normalizeQuestion('  Years of C++ / C# experience?* (required)'), 'years of c++ c# experience');
  assert.equal(normalizeQuestion('Node.js experience.'), 'node.js experience');
});

test('matchOption handles yes/no, ranges, prefixes and decline answers', () => {
  assert.equal(matchOption(true, ['Select an option', 'Yes', 'No']), 'Yes');
  assert.equal(matchOption(false, ['Yes', 'No']), 'No');
  assert.equal(matchOption(4, ['0-1 years', '1-3 years', '3-5 years', '5+ years']), '3-5 years');
  assert.equal(matchOption(5, ['0-1 years', '1-3 years', '3-5 years', '5+ years']), '5+ years');
  assert.equal(matchOption('India', ['United States (+1)', 'India (+91)']), 'India (+91)');
  assert.equal(matchOption('Prefer not to say', ['Male', 'Female', 'I don\'t wish to answer']), "I don't wish to answer");
  assert.equal(
    matchOption(true, ['I am authorized to work in this country', 'I am not authorized to work in this country']),
    'I am authorized to work in this country',
  );
  assert.equal(matchOption('Bachelors degree', ["Bachelor's Degree (BA/BS)", "Master's Degree"]), "Bachelor's Degree (BA/BS)");
  assert.equal(matchOption('Astronaut', ['Yes', 'No']), null);
});

test('coerce adapts values to the field type', () => {
  assert.equal(coerce({ type: 'number' }, 4.6), '4.6');
  assert.equal(coerce({ type: 'number' }, '5 years'), '5');
  assert.equal(coerce({ type: 'checkbox' }, true), true);
  assert.equal(coerce({ type: 'text' }, false), 'No');
  assert.deepEqual(coerce({ type: 'checkbox_group', options: ['Python', 'Go', 'Rust'] }, 'Python\nRust'), ['Python', 'Rust']);
  assert.equal(coerce({ type: 'text', max_length: 5 }, 'abcdefgh'), 'abcde');
});

test('rules do not fire on long sentences that merely contain a keyword', () => {
  assert.equal(findRule(normalizeQuestion('Please state your notice period'), { type: 'text' })?.key, 'notice_period');
  assert.equal(findRule(normalizeQuestion('Email address'), { type: 'email' })?.key, 'email');
  assert.equal(findRule(normalizeQuestion('Location (city)'), { type: 'combobox' })?.key, 'city');
  assert.equal(findRule(normalizeQuestion('Describe a project where you had to name a new service and why'), { type: 'textarea' }), undefined);
});

test('answerFields answers common fields without calling the LLM', async () => {
  const fields = [
    { id: 'f1', label: 'First name', type: 'text', required: true },
    { id: 'f2', label: 'Mobile phone number', type: 'tel', required: true },
    { id: 'f3', label: 'How many years of work experience do you have with Python?', type: 'number', required: true },
    { id: 'f4', label: 'How many years of work experience do you have?', type: 'number' },
    { id: 'f5', label: 'Are you legally authorized to work in India?', type: 'radio', options: ['Yes', 'No'], required: true },
    { id: 'f6', label: 'Are you legally authorized to work in the United States?', type: 'radio', options: ['Yes', 'No'] },
    { id: 'f7', label: 'Will you now or in the future require sponsorship?', type: 'select', options: ['Select an option', 'Yes', 'No'] },
    { id: 'f8', label: 'Notice period (in days)', type: 'number' },
    { id: 'f9', label: 'Resume', type: 'file', required: true },
    { id: 'f10', label: 'Gender', type: 'select', options: ['Male', 'Female', 'Decline to self-identify'] },
    { id: 'f11', label: 'I agree to the privacy policy', type: 'checkbox', required: true },
  ];
  let llmCalled = false;
  const llm = { generateJson: async () => ((llmCalled = true), { data: { answers: [] }, usage: {} }) };

  const { answers, missing } = await answerFields({ fields, profile, llm });
  const byId = Object.fromEntries(answers.map((a) => [a.id, a.value]));

  assert.equal(llmCalled, false);
  assert.equal(byId.f1, 'Asha');
  assert.equal(byId.f2, '+91 98765 43210');
  assert.equal(byId.f3, '4');
  assert.equal(byId.f4, '4');
  assert.equal(byId.f5, 'Yes');
  assert.equal(byId.f6, 'No');
  assert.equal(byId.f7, 'No');
  assert.equal(byId.f8, '30');
  assert.equal(byId.f9, RESUME_TOKEN);
  assert.equal(byId.f10, 'Decline to self-identify');
  assert.equal(byId.f11, true);
  assert.deepEqual(missing, []);
});

test('answerFields batches unknown questions into one LLM call and never guesses salary', async () => {
  const fields = [
    { id: 'a', label: 'How many years of experience do you have with Kubernetes?', type: 'number', required: true },
    { id: 'b', label: 'Describe your experience with distributed systems', type: 'textarea' },
    { id: 'c', label: 'Why do you want to work at Globex?', type: 'textarea' },
    { id: 'd', label: 'Expected salary', type: 'text', required: true },
  ];
  const calls = [];
  const llm = {
    generateJson: async (req) => {
      calls.push(req);
      return {
        data: {
          answers: [
            { id: 'a', answer: '0', confidence: 'high' },
            { id: 'b', answer: 'I built event-driven services on AWS.', confidence: 'medium' },
            { id: 'c', answer: 'Globex builds the payments infrastructure I want to work on.', confidence: 'medium' },
          ],
        },
        usage: { inputTokens: 1000, outputTokens: 80 },
      };
    },
  };

  const result = await answerFields({
    fields,
    profile,
    job: { title: 'Backend Engineer', company: 'Globex', description: 'Payments platform team.' },
    llm,
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0].user, /Globex/);
  assert.match(calls[0].user, /Payments platform team/); // description included for the "why" question
  assert.doesNotMatch(calls[0].user, /Expected salary/);
  const byId = Object.fromEntries(result.answers.map((a) => [a.id, a]));
  assert.equal(byId.a.value, '0');
  assert.equal(byId.d.value, null);
  assert.deepEqual(result.missing.map((m) => m.id), ['d']);
  // The company-specific answer is not cached for reuse; the generic ones are.
  assert.deepEqual(result.newSaved.map((s) => s.question_key).sort(), [
    'describe your experience with distributed systems',
    'how many years of experience do you have with kubernetes',
  ]);
  assert.equal(result.llmCount, 3);
});

test('answers the user corrected take priority over rules and the LLM', async () => {
  const saved = new Map([['are you willing to relocate', { answer: 'No', source: 'user' }]]);
  const { answers } = await answerFields({
    fields: [{ id: 'r', label: 'Are you willing to relocate?', type: 'radio', options: ['Yes', 'No'] }],
    profile: { ...profile, preferences: { ...profile.preferences, willing_to_relocate: true } },
    saved,
  });
  assert.equal(answers[0].value, 'No');
  assert.equal(answers[0].source, 'saved');
});

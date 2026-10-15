// Answers form fields in three tiers, cheapest first:
//   1. answers the user saved or corrected in the dashboard
//   2. deterministic rules over the profile + preferences (free, instant, never wrong about salary etc.)
//   3. previously generated LLM answers for the same question
//   4. one batched LLM call for whatever is left
// A typical application costs zero or one LLM call.

import { AnswersSchema } from './llm/schemas.js';
import { fullName, profileContext, withDefaults, settingsWithDefaults } from './profile.js';

export const RESUME_TOKEN = '__RESUME__';

export function normalizeQuestion(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\(required\)|\(optional\)/g, ' ')
    .replace(/['’`]/g, '')
    .replace(/[^\p{L}\p{N}+#.\s]/gu, ' ')
    .replace(/\.(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

const wordCount = (q) => (q ? q.split(' ').length : 0);

// ---------------------------------------------------------------------------
// Option matching
// ---------------------------------------------------------------------------

const PLACEHOLDER_OPTION = /^(select|choose|please select|please choose|--|—|-|none selected)\b|^$/i;
const DECLINE = /prefer not|decline|dont wish|do not wish|not to (say|disclose|answer|identify)|rather not|choose not/;
const NEGATION = /\b(no|not|dont|never|none|cannot|cant|wont|isnt|arent)\b/;

export function realOptions(options = []) {
  return options.filter((o) => !PLACEHOLDER_OPTION.test(String(o).trim()));
}

function parseRange(option) {
  const o = String(option).toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ').trim();
  let m;
  if ((m = o.match(/(less than|under|below|fewer than|<)\s*(\d+(?:\.\d+)?)/))) return [-Infinity, Number(m[2]) - 1e-9];
  if ((m = o.match(/(\d+(?:\.\d+)?)\s*(\+|or more|and above|plus|or above)/))) return [Number(m[1]), Infinity];
  if ((m = o.match(/(more than|over|above|greater than|>)\s*(\d+(?:\.\d+)?)/))) return [Number(m[2]) + 1e-9, Infinity];
  if ((m = o.match(/(\d+(?:\.\d+)?)\s*(?:-|to|–)\s*(\d+(?:\.\d+)?)/))) return [Number(m[1]), Number(m[2])];
  if ((m = o.match(/^(\d+(?:\.\d+)?)\b/))) return [Number(m[1]), Number(m[1])];
  return null;
}

function matchNumber(n, options) {
  const ranges = options.map((o) => ({ o, r: parseRange(o) })).filter((x) => x.r);
  if (!ranges.length) return null;
  // Half-open first so 5 picks "5-7" rather than "3-5"; then closed for the last bucket.
  const halfOpen = ranges.find(({ r }) => n >= r[0] && n < r[1]);
  if (halfOpen) return halfOpen.o;
  const closed = ranges.find(({ r }) => n >= r[0] && n <= r[1]);
  return closed ? closed.o : null;
}

function matchBoolean(value, options) {
  const norm = options.map((o) => ({ o, n: normalizeQuestion(o) }));
  const direct = norm.find(({ n }) => (value ? /^(yes|y|true)\b/.test(n) : /^(no|n|false)\b/.test(n)));
  if (direct) return direct.o;
  // "I am authorized ..." vs "I am not authorized ..."
  if (norm.length === 2) {
    const negatives = norm.filter(({ n }) => NEGATION.test(n));
    if (negatives.length === 1) {
      return value ? norm.find((x) => x !== negatives[0]).o : negatives[0].o;
    }
  }
  return null;
}

export function matchOption(raw, options = []) {
  const opts = realOptions(options);
  if (!opts.length || raw === null || raw === undefined) return null;

  if (typeof raw === 'boolean') return matchBoolean(raw, opts);
  if (typeof raw === 'number' || /^\s*\d+(\.\d+)?\s*$/.test(String(raw))) {
    const byNumber = matchNumber(Number(raw), opts);
    if (byNumber) return byNumber;
  }

  const target = normalizeQuestion(raw);
  if (!target) return null;
  const norm = opts.map((o) => ({ o, n: normalizeQuestion(o) }));

  const exact = norm.find(({ n }) => n === target);
  if (exact) return exact.o;

  if (/^(yes|true)$/.test(target)) return matchBoolean(true, opts);
  if (/^(no|false)$/.test(target)) return matchBoolean(false, opts);

  if (DECLINE.test(target)) {
    const decline = norm.find(({ n }) => DECLINE.test(n));
    if (decline) return decline.o;
  }

  const prefix = norm.find(({ n }) => n.startsWith(target) || target.startsWith(n));
  if (prefix) return prefix.o;

  const contains = norm.find(({ n }) => n.length > 1 && (n.includes(target) || target.includes(n)));
  if (contains) return contains.o;

  // Token overlap as a last resort ("Bachelor's degree" vs "Bachelors Degree (BA/BS)").
  const tokens = new Set(target.split(' '));
  let best = null;
  let bestScore = 0;
  for (const { o, n } of norm) {
    const optTokens = n.split(' ');
    const overlap = optTokens.filter((t) => tokens.has(t)).length;
    const score = overlap / Math.max(tokens.size, optTokens.length);
    if (score > bestScore) {
      best = o;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

// ---------------------------------------------------------------------------
// Coercion: turn a raw value into what the field can actually accept
// ---------------------------------------------------------------------------

function toBool(raw) {
  if (typeof raw === 'boolean') return raw;
  const s = normalizeQuestion(raw);
  if (/^(yes|y|true|agree|i agree|accept|checked)$/.test(s)) return true;
  if (/^(no|n|false|disagree|unchecked)$/.test(s)) return false;
  return null;
}

function toNumberString(raw) {
  if (typeof raw === 'boolean') return null;
  const m = String(raw).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? m[0] : null;
}

export function coerce(field, raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const options = realOptions(field.options);

  if (field.type === 'checkbox') return toBool(raw);

  if (field.type === 'checkbox_group') {
    const parts = Array.isArray(raw) ? raw : String(raw).split(/\n|;|\|\|/);
    const picked = [...new Set(parts.map((p) => matchOption(p.trim(), options)).filter(Boolean))];
    return picked.length ? picked : null;
  }

  if (options.length) return matchOption(raw, options);

  if (field.type === 'number') return toNumberString(raw);
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  if (typeof raw === 'number') return String(Math.round(raw * 10) / 10);
  const text = String(raw);
  return field.max_length ? text.slice(0, field.max_length) : text;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const COUNTRY_ALIASES = {
  'united states': ['united states', 'usa', 'u s', 'us', 'america'],
  'united kingdom': ['united kingdom', 'uk', 'britain', 'england'],
  'united arab emirates': ['united arab emirates', 'uae', 'dubai', 'abu dhabi'],
  'european union': ['european union', 'eu'],
};
const KNOWN_COUNTRIES = [
  'india', 'canada', 'australia', 'germany', 'france', 'netherlands', 'ireland', 'singapore',
  'saudi arabia', 'qatar', 'oman', 'kuwait', 'bahrain', 'new zealand', 'japan', 'spain',
  'italy', 'sweden', 'switzerland', 'poland', 'malaysia', 'philippines', 'south africa',
];

function countryInQuestion(q) {
  for (const [canonical, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (aliases.some((a) => new RegExp(`\\b${a}\\b`).test(q))) return canonical;
  }
  return KNOWN_COUNTRIES.find((c) => new RegExp(`\\b${c}\\b`).test(q)) ?? null;
}

function canonicalCountry(name) {
  const n = normalizeQuestion(name);
  for (const [canonical, aliases] of Object.entries(COUNTRY_ALIASES)) {
    if (aliases.includes(n)) return canonical;
  }
  return n;
}

function authorizedFor(q, prefs) {
  const country = countryInQuestion(q);
  const list = (prefs.authorized_countries ?? []).map(canonicalCountry);
  if (country && list.length) return list.includes(country);
  return Boolean(prefs.authorized_to_work);
}

function skillYears(subject, profile) {
  const s = normalizeQuestion(subject);
  const match = (profile.skills ?? []).find((skill) => {
    const name = normalizeQuestion(skill.name);
    return name.length > 1 && (new RegExp(`\\b${escapeRegExp(name)}\\b`).test(s) || (s.length > 2 && name.includes(s)));
  });
  return match ? Math.max(0, Math.floor(Number(match.years) || 0)) : undefined;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function startDate(prefs) {
  if (prefs.earliest_start_date) return prefs.earliest_start_date;
  const d = new Date();
  d.setDate(d.getDate() + (Number(prefs.notice_period_days) || 0));
  return d.toISOString().slice(0, 10);
}

const BOOLEAN_TYPES = new Set(['checkbox', 'radio', 'select', 'combobox']);

// Each rule: test(q, field) decides whether the rule owns the question; value(ctx)
// returns the raw answer. sensitive rules never fall through to the LLM: if the
// user has not provided the value, the field is left for them.
const RULES = [
  { key: 'first_name', short: true, test: /\b(first|given|fore) ?name\b/, value: (c) => c.p.personal.first_name },
  { key: 'last_name', short: true, test: /\b(last|family) ?name\b|\bsurname\b/, value: (c) => c.p.personal.last_name },
  { key: 'middle_name', short: true, test: /\bmiddle name\b/, value: () => null, sensitive: true },
  { key: 'preferred_name', short: true, test: /\bpreferred (first )?name\b|\bnickname\b/, value: (c) => c.p.personal.first_name },
  {
    key: 'full_name',
    short: true,
    test: (q) => /\b(full|legal|your) name\b|^name$/.test(q) && !/company|employer|school|university|referr|manager|reference|emergency|user ?name/.test(q),
    value: (c) => fullName(c.p),
  },
  {
    key: 'email',
    short: true,
    test: (q) => /\be ?mail\b/.test(q) && !/referr|reference|manager|confirm/.test(q),
    value: (c) => c.p.personal.email,
  },
  { key: 'email_confirm', short: true, test: /confirm (your )?e ?mail|re ?enter (your )?e ?mail/, value: (c) => c.p.personal.email },
  {
    key: 'phone_country_code',
    short: true,
    test: /country (calling )?code|phone country|dial(ing)? code/,
    value: (c) => c.prefs.phone_country_code || c.p.personal.country,
  },
  {
    key: 'phone',
    short: true,
    test: (q) => /\b(phone|mobile|cell|telephone|contact number|whatsapp)\b/.test(q) && !/referr|reference|type|extension|device/.test(q),
    value: (c) => c.p.personal.phone,
  },
  { key: 'linkedin', short: true, test: /\blinked ?in\b/, value: (c) => c.p.personal.linkedin_url },
  { key: 'github', short: true, test: /\bgit ?hub\b/, value: (c) => c.p.personal.github_url },
  {
    key: 'website',
    short: true,
    test: /portfolio|personal (web)?site|\bwebsite\b|\bblog\b|other (url|link|website)/,
    value: (c) => c.p.personal.portfolio_url || c.p.personal.github_url,
  },
  {
    key: 'address',
    short: true,
    test: (q) => /\baddress\b|\bstreet\b/.test(q) && !/e ?mail|ip address/.test(q),
    value: (c) => c.prefs.address,
    sensitive: true,
  },
  { key: 'city', short: true, test: /\bcity\b|\btown\b/, value: (c) => c.p.personal.city },
  {
    key: 'location',
    short: true,
    test: /^(current )?location$|where are you (currently )?(located|based)|current location|location of residence/,
    value: (c) => [c.p.personal.city, c.p.personal.state, c.p.personal.country].filter(Boolean).join(', '),
  },
  {
    key: 'state',
    short: true,
    test: /^(current )?(state|province|state province|state or province|state region|region|county)$|\bstate of residence\b/,
    value: (c) => c.p.personal.state,
  },
  { key: 'country', short: true, test: (q) => /\bcountry\b/.test(q) && !/code/.test(q), value: (c) => c.p.personal.country },
  { key: 'postal_code', short: true, test: /\bzip\b|postal|pin ?code|postcode/, value: (c) => c.p.personal.postal_code },
  {
    key: 'current_company',
    short: true,
    test: /current (company|employer|organi[sz]ation)|most recent (company|employer)|present employer|^(company|employer)( name)?$/,
    value: (c) => c.p.current_company,
  },
  {
    key: 'current_title',
    short: true,
    test: /current (job )?(title|role|position|designation)|most recent (job )?title|^(job )?title$|^designation$/,
    value: (c) => c.p.current_title,
  },
  {
    key: 'years_experience',
    test: /(how many|number of|total) years|years of (\S+ ){0,3}experience|experience in years|\byrs\b/,
    value: (c) => {
      const subject = c.q.match(/(?:experience|worked|working|work)\s+(?:do you have\s+)?(?:with|in|using|on)\s+(.+)$/)?.[1];
      if (subject && !/^(this|the|a|our|similar|relevant)\b/.test(subject)) {
        return skillYears(subject, c.p); // undefined -> let the LLM read the resume
      }
      if (/relevant|this (role|field|position|industry)|similar/.test(c.q)) return undefined;
      return Math.floor(Number(c.p.total_years_experience) || 0);
    },
  },
  {
    key: 'work_authorization',
    test: /authori[sz]ed to work|eligible to work|right to work|legally (able|allowed|permitted|eligible) to work|work authori[sz]ation|work permit/,
    value: (c) => authorizedFor(c.q, c.prefs),
  },
  {
    key: 'sponsorship',
    test: /sponsor|require (a )?visa|visa (status|support|transfer)/,
    value: (c) => Boolean(c.prefs.requires_sponsorship),
  },
  { key: 'relocation', test: /relocat/, value: (c) => Boolean(c.prefs.willing_to_relocate) },
  {
    key: 'onsite',
    test: /commut|on ?site|in ?office|in person|hybrid|work from (the )?office/,
    types: BOOLEAN_TYPES,
    value: (c) => Boolean(c.prefs.willing_to_work_onsite),
  },
  {
    key: 'notice_period',
    test: /notice period|how soon can you (join|start)|when can you (join|start)|earliest (start|joining)|available to (start|join)|availability to (start|join)|start date|joining date/,
    value: (c) => {
      if (c.field.type === 'number') return Number(c.prefs.notice_period_days) || 0;
      if (c.field.type === 'date') return startDate(c.prefs);
      if (realOptions(c.field.options).length) {
        return matchOption(c.prefs.notice_period, c.field.options) ?? Number(c.prefs.notice_period_days) ?? undefined;
      }
      return c.prefs.notice_period;
    },
  },
  {
    key: 'expected_salary',
    test: /expected (salary|ctc|compensation|pay|package|remuneration)|salary expectation|desired (salary|compensation|pay)|compensation expectation|salary requirement/,
    value: (c) => c.prefs.expected_salary,
    sensitive: true,
  },
  {
    key: 'current_salary',
    test: /current (salary|ctc|compensation|package|remuneration)|present (salary|ctc)/,
    value: (c) => c.prefs.current_salary,
    sensitive: true,
  },
  { key: 'gender', short: true, test: /\bgender\b|\bsex\b/, value: (c) => c.prefs.gender, sensitive: true },
  { key: 'pronouns', short: true, test: /pronoun/, value: (c) => c.prefs.pronouns, sensitive: true },
  { key: 'ethnicity', test: /\brace\b|ethnic|hispanic|latin[oa]/, value: (c) => c.prefs.ethnicity, sensitive: true },
  { key: 'veteran', test: /veteran|military service|armed forces/, value: (c) => c.prefs.veteran_status, sensitive: true },
  { key: 'disability', test: /disabilit|handicap/, value: (c) => c.prefs.disability_status, sensitive: true },
  { key: 'date_of_birth', short: true, test: /date of birth|birth ?date|\bdob\b/, value: (c) => c.prefs.date_of_birth, sensitive: true },
  {
    key: 'referral_source',
    test: /how did you (hear|find|learn|come across)|where did you (hear|find|see)|source of (application|hire)|referral source/,
    value: (c) => c.prefs.referral_source,
  },
  { key: 'age', test: /(at least|over|older than) 18|18 years (of age|or older)|legal (working )?age/, value: () => true },
  {
    key: 'background_check',
    test: /background (check|verification|screening)|drug (test|screen)/,
    types: BOOLEAN_TYPES,
    value: (c) => Boolean(c.prefs.background_check_ok),
  },
  { key: 'drivers_license', test: /driv(ers|ing) licen[cs]e/, types: BOOLEAN_TYPES, value: (c) => Boolean(c.prefs.has_drivers_license) },
  {
    key: 'previously_employed',
    test: /(previously|ever|before) (been )?(employed|worked)|former employee|worked (here|for us) before/,
    types: BOOLEAN_TYPES,
    value: () => false,
  },
  {
    key: 'relatives',
    test: /relative|family member|related to (anyone|an employee)|know anyone (who works|working)/,
    types: BOOLEAN_TYPES,
    value: () => false,
  },
  {
    key: 'future_opportunities',
    test: /considered for (other|future) (roles|opportunities|positions|openings)/,
    types: BOOLEAN_TYPES,
    value: () => true,
  },
  {
    key: 'marketing_opt_in',
    test: /text message|\bsms\b|whatsapp (updates|messages)|marketing|newsletter|job alerts|talent (community|network|pool)/,
    types: BOOLEAN_TYPES,
    value: () => false,
  },
  {
    key: 'consent',
    test: /i (have read|agree|acknowledge|consent|certify|confirm|understand|accept)|privacy (policy|notice)|terms (and|&) conditions|terms of (use|service)|true and (accurate|complete)|accurate and complete|data processing|\bgdpr\b/,
    types: BOOLEAN_TYPES,
    value: (c) => (c.settings.auto_accept_consent ? true : undefined),
  },
  { key: 'headline', short: true, test: /^(professional )?headline$/, value: (c) => c.p.headline },
  {
    key: 'summary',
    short: true,
    test: /^(professional )?summary$|^about (you|yourself|me)$/,
    value: (c) => c.p.summary || undefined,
  },
  {
    key: 'highest_education',
    test: /highest (level of )?(education|qualification|degree)/,
    value: (c) => c.p.education?.[0]?.degree || undefined,
  },
  {
    key: 'school',
    short: true,
    test: /^(school|university|college|institution|institute)( name)?$/,
    value: (c) => c.p.education?.[0]?.school,
  },
  { key: 'degree', short: true, test: /^(degree|qualification)$/, value: (c) => c.p.education?.[0]?.degree },
  {
    key: 'field_of_study',
    short: true,
    test: /^(discipline|major|field of study|specialization|specialisation)$/,
    value: (c) => c.p.education?.[0]?.field_of_study,
  },
  { key: 'grade', short: true, test: /\bc?gpa\b|^grade$|^percentage$/, value: (c) => c.p.education?.[0]?.grade },
];

export function findRule(q, field) {
  return RULES.find((rule) => {
    if (rule.short && wordCount(q) > 6) return false;
    if (rule.types && !rule.types.has(field.type)) return false;
    return typeof rule.test === 'function' ? rule.test(q, field) : rule.test.test(q);
  });
}

const JOB_SPECIFIC =
  /cover letter|why (do you|are you|would you|should we|this|our)|what (interests|excites|attracts|draws) you|interest(ed)? in (this|the|our) (role|position|company|job|team)|about (this|the|our) (role|position|company|opportunity)|motivat|fit for (this|the) (role|position)/;

export function isJobSpecific(q, job = {}) {
  if (JOB_SPECIFIC.test(q)) return true;
  const company = normalizeQuestion(job.company);
  return company.length > 2 && new RegExp(`\\b${escapeRegExp(company)}\\b`).test(q);
}

// ---------------------------------------------------------------------------
// LLM prompt
// ---------------------------------------------------------------------------

const ANSWER_INSTRUCTIONS = `You fill in job application forms on behalf of the candidate described below. Your answers are entered into the form exactly as written and the candidate is accountable for them, so they must be truthful.

How to answer:
- Base every answer on the candidate profile, preferences and resume below. Never invent employers, degrees, certifications, licenses, clearances or skills the candidate does not have.
- Questions with "options": answer with exactly one of the options, copied character for character. For type "checkbox_group", give one or more options separated by newlines.
- type "number": digits only, a whole number unless the question asks for decimals.
- "How many years of experience with X": count only the years the resume shows the candidate using X or a directly equivalent technology. Answer 0 if there are none. Do not round up.
- Yes/no questions about a skill or experience: "Yes" only if the resume demonstrates it.
- Personal facts the profile does not contain (ID numbers, date of birth, salary figures, references' contact details): answer "" with confidence "low" rather than guessing.
- Free-text questions: first person, specific to the candidate's real experience, 1-3 sentences of plain text. For a cover letter or a "why this company / role" question, write up to 150 words connecting the candidate's experience to the job, without flattery or clichés.
- Respect "max_length" when present.
- confidence: "high" when the profile states the answer directly, "medium" when you inferred it, "low" when unsure.`;

// Job descriptions can be very long; only the part needed for "why this role"
// style answers is sent, and only when such a question is present.
const MAX_DESCRIPTION_CHARS = 6000;

function buildUserPrompt(items, job) {
  const lines = [`Today's date: ${new Date().toISOString().slice(0, 10)}`, '', '## Job'];
  if (job.title) lines.push(`Title: ${job.title}`);
  if (job.company) lines.push(`Company: ${job.company}`);
  if (job.location) lines.push(`Location: ${job.location}`);
  if (items.some((i) => i.jobSpecific) && job.description) {
    const desc = String(job.description);
    lines.push('Description:', desc.length > MAX_DESCRIPTION_CHARS ? `${desc.slice(0, MAX_DESCRIPTION_CHARS)} ...[description shortened]` : desc);
  }
  const questions = items.map(({ field }) => {
    const q = { id: field.id, question: field.label || field.placeholder || field.name, type: field.type };
    const options = realOptions(field.options);
    if (options.length) q.options = options;
    if (field.required) q.required = true;
    if (field.max_length) q.max_length = field.max_length;
    return q;
  });
  lines.push('', '## Questions', JSON.stringify(questions, null, 1));
  lines.push('', 'Return one entry in "answers" for every question id.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {Array<{id:string,label:string,type:string,options?:string[],required?:boolean,placeholder?:string,name?:string,max_length?:number}>} args.fields
 * @param {object} [args.job] title, company, location, description
 * @param {object} args.profile profile.data
 * @param {string} [args.resumeText]
 * @param {object} [args.settings]
 * @param {Map<string,{answer:string,source:string}>} [args.saved] keyed by normalized question
 * @param {{generateJson:Function}|null} [args.llm]
 */
export async function answerFields({ fields, job = {}, profile, resumeText = '', settings = {}, saved = new Map(), llm = null }) {
  const p = withDefaults(profile);
  const ctxBase = { p, prefs: p.preferences, settings: settingsWithDefaults(settings), job };
  const results = new Map();
  const missing = [];
  const toLlm = [];

  for (const field of fields) {
    const q = normalizeQuestion(field.label || field.placeholder || field.name);
    const none = { id: field.id, value: null, source: 'none' };

    if (field.type === 'file') {
      const isResume = !q || /resume|\bcv\b|curriculum/.test(q);
      results.set(field.id, isResume && !/cover/.test(q) ? { id: field.id, value: RESUME_TOKEN, source: 'rule' } : none);
      continue;
    }
    if (!q) {
      results.set(field.id, none);
      continue;
    }

    const jobSpecific = isJobSpecific(q, job);
    const savedAnswer = jobSpecific ? null : saved.get(q);

    if (savedAnswer?.source === 'user') {
      const value = coerce(field, savedAnswer.answer);
      if (value !== null) {
        results.set(field.id, { id: field.id, value, source: 'saved' });
        continue;
      }
    }

    const rule = findRule(q, field);
    if (rule) {
      const value = coerce(field, rule.value({ ...ctxBase, q, field }));
      if (value !== null) {
        results.set(field.id, { id: field.id, value, source: 'rule', rule: rule.key });
        continue;
      }
      if (rule.sensitive) {
        results.set(field.id, { ...none, rule: rule.key });
        if (field.required) missing.push({ id: field.id, label: field.label, rule: rule.key });
        continue;
      }
    }

    if (savedAnswer) {
      const value = coerce(field, savedAnswer.answer);
      if (value !== null) {
        results.set(field.id, { id: field.id, value, source: 'saved' });
        continue;
      }
    }

    toLlm.push({ field, q, jobSpecific });
  }

  const newSaved = [];
  let usage = null;
  if (toLlm.length && llm) {
    const response = await llm.generateJson({
      system: `${ANSWER_INSTRUCTIONS}\n\n${profileContext(p, resumeText)}`,
      user: buildUserPrompt(toLlm, job),
      schema: AnswersSchema,
      maxTokens: 4096,
    });
    usage = response.usage;
    const byId = new Map(response.data.answers.map((a) => [a.id, a]));
    for (const { field, q, jobSpecific } of toLlm) {
      const answer = byId.get(field.id);
      const value = answer ? coerce(field, answer.answer) : null;
      if (value === null) continue;
      results.set(field.id, { id: field.id, value, source: 'llm', confidence: answer.confidence });
      if (!jobSpecific && answer.confidence !== 'low') {
        newSaved.push({
          question_key: q,
          question: field.label || field.placeholder || field.name,
          answer: Array.isArray(value) ? value.join('\n') : String(value),
          field_type: field.type,
        });
      }
    }
  }

  const answers = fields.map((f) => results.get(f.id) ?? { id: f.id, value: null, source: 'none' });
  for (const a of answers) {
    const field = fields.find((f) => f.id === a.id);
    if (a.value === null && field.required && !missing.some((m) => m.id === a.id)) {
      missing.push({ id: a.id, label: field.label });
    }
  }
  return { answers, missing, newSaved, usage, llmCount: answers.filter((a) => a.source === 'llm').length };
}

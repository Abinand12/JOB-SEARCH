// How well a job fits the candidate, 0-100, from the profile alone (no LLM call, so
// the bot can score every job it opens). Three parts:
//   title  (40%)  job title vs. the candidate's titles and target roles
//   skills (45%)  skills the posting names that the candidate has
//   years  (15%)  "5+ years" style requirements vs. total experience
// Without a description only the title (and no years penalty) counts.

import { normalizeQuestion } from './answers.js';

// Common skills, so a posting's requirements the candidate lacks can be reported.
// The candidate's own skills are always looked for too.
const SKILL_VOCABULARY = [
  'javascript', 'typescript', 'python', 'java', 'kotlin', 'swift', 'objective-c', 'go', 'golang', 'rust', 'c++', 'c#', 'c',
  'ruby', 'php', 'scala', 'r', 'dart', 'elixir', 'perl', 'matlab', 'sql', 'nosql', 'bash', 'powershell',
  'react', 'react native', 'angular', 'vue', 'next.js', 'nuxt', 'svelte', 'redux', 'html', 'css', 'sass', 'tailwind',
  'node.js', 'express', 'nestjs', 'django', 'flask', 'fastapi', 'spring', 'spring boot', '.net', 'asp.net', 'rails', 'laravel',
  'graphql', 'rest', 'grpc', 'microservices', 'kafka', 'rabbitmq', 'redis', 'elasticsearch',
  'postgresql', 'mysql', 'mongodb', 'dynamodb', 'cassandra', 'oracle', 'sql server', 'snowflake', 'bigquery', 'redshift',
  'aws', 'azure', 'gcp', 'docker', 'kubernetes', 'terraform', 'ansible', 'jenkins', 'github actions', 'ci/cd', 'linux',
  'helm', 'prometheus', 'grafana', 'datadog', 'serverless', 'lambda',
  'spark', 'hadoop', 'airflow', 'dbt', 'kafka streams', 'etl', 'data warehousing', 'tableau', 'power bi', 'excel', 'looker',
  'pandas', 'numpy', 'scikit-learn', 'tensorflow', 'pytorch', 'machine learning', 'deep learning', 'nlp', 'computer vision',
  'llm', 'generative ai', 'statistics', 'data analysis', 'data science',
  'android', 'ios', 'flutter', 'unity', 'figma', 'sketch', 'adobe xd', 'photoshop', 'illustrator',
  'selenium', 'cypress', 'playwright', 'jest', 'junit', 'pytest', 'qa', 'test automation',
  'git', 'jira', 'agile', 'scrum', 'kanban', 'product management', 'project management',
  'salesforce', 'sap', 'hubspot', 'seo', 'sem', 'google analytics', 'content marketing', 'social media marketing',
  'accounting', 'financial modeling', 'quickbooks', 'tally', 'gst', 'payroll', 'recruitment', 'customer service',
  'networking', 'cybersecurity', 'penetration testing', 'siem', 'active directory', 'itil',
];

// Words that say nothing about the kind of job.
const TITLE_NOISE = new Set([
  'senior', 'sr', 'junior', 'jr', 'lead', 'principal', 'staff', 'associate', 'head', 'chief', 'i', 'ii', 'iii', 'iv', 'v',
  'the', 'of', 'and', 'for', 'a', 'an', 'in', 'at', 'with', 'remote', 'hybrid', 'onsite', 'contract', 'full', 'time',
  'part', 'permanent', 'temporary', 'm', 'f', 'd', 'x', 'urgent', 'hiring', 'immediate', 'joiner', 'level', 'mid', 'entry',
]);
// Role nouns: they match too many jobs on their own, so they count for half.
const ROLE_NOUNS = new Set([
  'engineer', 'developer', 'manager', 'analyst', 'specialist', 'consultant', 'executive', 'officer', 'coordinator',
  'administrator', 'architect', 'designer', 'scientist', 'assistant', 'representative', 'intern', 'trainee', 'director',
]);
const TITLE_ALIASES = [
  [/\bfront[\s-]?end\b/g, 'frontend'],
  [/\bback[\s-]?end\b/g, 'backend'],
  [/\bfull[\s-]?stack\b/g, 'fullstack'],
  [/\bdev[\s-]?ops\b/g, 'devops'],
  [/\bsde\b|\bswe\b/g, 'software engineer'],
  [/\bsre\b/g, 'site reliability engineer'],
  [/\bqa\b/g, 'quality assurance'],
  [/\bml\b/g, 'machine learning'],
  [/\bai\b/g, 'artificial intelligence'],
  [/\bui\s*\/?\s*ux\b|\bux\s*\/?\s*ui\b/g, 'ui ux'],
  [/\bdeveloper\b/g, 'engineer'],
  [/\bprogrammer\b/g, 'engineer'],
];

const SENIOR = /\b(senior|sr|lead|principal|staff|head|director|vp|vice president|chief|manager)\b/;
const JUNIOR = /\b(intern|internship|trainee|fresher|graduate|junior|jr|entry level|apprentice)\b/;

function titleTokens(title) {
  let t = normalizeQuestion(title).replace(/[.+#]/g, ' ');
  for (const [re, to] of TITLE_ALIASES) t = t.replace(re, to);
  return [...new Set(t.split(' ').filter((w) => w && !TITLE_NOISE.has(w) && !/^\d+$/.test(w)))];
}

const tokenWeight = (w) => (ROLE_NOUNS.has(w) ? 0.5 : 1);

// Weighted Dice similarity of two titles, 0-1.
export function titleSimilarity(a, b) {
  const A = titleTokens(a);
  const B = new Set(titleTokens(b));
  if (!A.length || !B.size) return 0;
  const shared = A.filter((w) => B.has(w)).reduce((n, w) => n + tokenWeight(w), 0);
  const total = A.reduce((n, w) => n + tokenWeight(w), 0) + [...B].reduce((n, w) => n + tokenWeight(w), 0);
  return (2 * shared) / total;
}

function skillPattern(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]?');
  return new RegExp(`(^|[^a-z0-9+#.])${escaped}($|[^a-z0-9+#])`);
}

const SKILL_ALIASES = { golang: 'go', 'node.js': 'node', 'next.js': 'next', postgresql: 'postgres', kubernetes: 'k8s', javascript: 'js', typescript: 'ts' };

function mentions(text, skill) {
  if (skillPattern(skill).test(text)) return true;
  const alias = SKILL_ALIASES[skill];
  return alias ? skillPattern(alias).test(text) : false;
}

// Single letters and two-letter names ("r", "c", "go") are matched only when the
// candidate lists them; from the vocabulary they cause too many false hits.
const vocabularyUsable = (skill) => skill.length > 2;

export function requiredYears(text) {
  const found = [];
  const re = /(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|to|–)\s*\d{1,2}\s*)?\+?\s*(?:years|yrs)/g;
  let m;
  while ((m = re.exec(text))) {
    const n = Number(m[1]);
    if (n > 0 && n <= 25) found.push(n);
  }
  return found.length ? Math.min(...found) : null;
}

/**
 * @param {object} profile profile with defaults applied
 * @param {{title?:string, description?:string}} job
 * @returns {{score:number, title_score:number, skills_matched:string[], skills_missing:string[], required_years:number|null, reasons:string[]}}
 */
export function matchJob(profile, job) {
  const reasons = [];
  const title = String(job.title ?? '');
  const description = String(job.description ?? '');
  const text = ` ${String(title + '\n' + description).toLowerCase()} `;

  // Title
  const candidateTitles = [
    ...(profile.target_roles ?? []),
    profile.current_title,
    profile.headline?.split(/[-|–,]/)[0],
    ...(profile.experience ?? []).slice(0, 4).map((e) => e.title),
  ].filter((t) => t && t.trim());
  const titleScore = candidateTitles.length ? Math.max(...candidateTitles.map((t) => titleSimilarity(title, t))) : 0.5;
  if (candidateTitles.length) {
    if (titleScore >= 0.6) reasons.push('Title matches your roles');
    else if (titleScore < 0.25) reasons.push('Title is unlike your roles');
  }

  // Skills
  const own = [...new Set((profile.skills ?? []).map((s) => String(s.name ?? s).toLowerCase().trim()).filter(Boolean))];
  const ownSet = new Set(own);
  const matched = own.filter((s) => mentions(text, s));
  const missing = description
    ? SKILL_VOCABULARY.filter((s) => vocabularyUsable(s) && !ownSet.has(s) && mentions(text, s))
        .filter((s) => !matched.some((m) => m.includes(s) || s.includes(m)))
    : [];
  const wanted = matched.length + missing.length;
  let skillsScore = null;
  if (description && wanted) {
    skillsScore = Math.min(1, matched.length / Math.min(Math.max(wanted, 3), 8));
    reasons.push(`${matched.length} of the posting's skills are on your resume`);
  }

  // Years
  const years = Number(profile.total_years_experience) || 0;
  const required = description ? requiredYears(description.toLowerCase()) : null;
  let yearsScore = 1;
  if (required !== null) {
    yearsScore = years >= required ? 1 : years >= required - 1 ? 0.7 : years >= required - 2 ? 0.4 : 0;
    if (yearsScore < 1) reasons.push(`Asks for ${required}+ years; you have ${Math.floor(years)}`);
  }
  if (SENIOR.test(normalizeQuestion(title)) && years < 3) {
    yearsScore = Math.min(yearsScore, 0.3);
    reasons.push('Senior role');
  } else if (JUNIOR.test(normalizeQuestion(title)) && years >= 5) {
    yearsScore = Math.min(yearsScore, 0.5);
    reasons.push('Junior role');
  }

  const score =
    skillsScore === null
      ? 0.85 * titleScore + 0.15 * yearsScore
      : 0.4 * titleScore + 0.45 * skillsScore + 0.15 * yearsScore;

  return {
    score: Math.round(score * 100),
    title_score: Math.round(titleScore * 100),
    skills_matched: matched.slice(0, 15),
    skills_missing: missing.slice(0, 10),
    required_years: required,
    reasons,
  };
}

/** LinkedIn searches to run: the user's keywords (";" separated), else the roles the resume fits. */
export function searchQueries(profile, settings) {
  const own = String(settings.search_keywords ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  const list = own.length ? own : [...(profile.target_roles ?? []).slice(0, 3), profile.current_title].filter((s) => s && s.trim());
  const seen = new Set();
  const unique = list.filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.length ? unique.slice(0, 5) : [''];
}

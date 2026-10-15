// Profile = what the resume says (parsed by the LLM) + application preferences the
// user sets once in the dashboard. Preferences answer the questions an LLM must
// never guess: work authorization, sponsorship, salary, notice period, EEO answers.

export const DEFAULT_PREFERENCES = {
  authorized_to_work: true,
  authorized_countries: [], // e.g. ["India", "United Arab Emirates"]; empty = use authorized_to_work everywhere
  requires_sponsorship: false,
  willing_to_relocate: true,
  willing_to_work_onsite: true,
  notice_period: 'Immediate',
  notice_period_days: 0,
  expected_salary: '',
  current_salary: '',
  salary_currency: '',
  earliest_start_date: '',
  phone_country_code: '',
  address: '',
  gender: 'Prefer not to say',
  pronouns: '',
  ethnicity: 'Prefer not to say',
  veteran_status: 'Prefer not to say',
  disability_status: 'Prefer not to say',
  has_drivers_license: true,
  background_check_ok: true,
  referral_source: 'LinkedIn',
  date_of_birth: '',
};

export const DEFAULT_SETTINGS = {
  daily_limit: 40,
  search_keywords: '',
  search_location: '',
  easy_apply_only: false,
  apply_external: true,
  auto_submit_easy_apply: true,
  auto_submit_external: false,
  auto_accept_consent: true,
  title_include: [],
  title_exclude: [],
  company_blacklist: [],
  min_delay_sec: 3,
  max_delay_sec: 8,
};

export const EMPTY_PROFILE = {
  personal: {
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    city: '',
    state: '',
    country: '',
    postal_code: '',
    linkedin_url: '',
    github_url: '',
    portfolio_url: '',
  },
  headline: '',
  summary: '',
  current_title: '',
  current_company: '',
  total_years_experience: 0,
  skills: [],
  experience: [],
  education: [],
  certifications: [],
  languages: [],
  preferences: DEFAULT_PREFERENCES,
};

export function withDefaults(data = {}) {
  return {
    ...EMPTY_PROFILE,
    ...data,
    personal: { ...EMPTY_PROFILE.personal, ...(data.personal ?? {}) },
    preferences: { ...DEFAULT_PREFERENCES, ...(data.preferences ?? {}) },
  };
}

export function settingsWithDefaults(settings = {}) {
  return { ...DEFAULT_SETTINGS, ...settings };
}

// A fresh resume upload replaces the resume-derived sections but keeps the user's
// preferences and any personal field the parser left blank (e.g. a phone number
// the user typed in by hand that is not printed on the resume).
export function mergeParsedResume(existing, parsed) {
  const current = withDefaults(existing);
  const personal = { ...current.personal };
  for (const [key, value] of Object.entries(parsed.personal ?? {})) {
    if (typeof value === 'string' && value.trim()) personal[key] = value.trim();
  }
  return {
    ...current,
    ...parsed,
    personal,
    preferences: current.preferences,
  };
}

export function fullName(profile) {
  return [profile.personal.first_name, profile.personal.last_name].filter(Boolean).join(' ');
}

// Compact, stable text block describing the candidate. Stable ordering matters:
// it is the cached prefix of every answer request.
export function profileContext(profile, resumeText) {
  const p = withDefaults(profile);
  const lines = [
    '## Candidate profile (JSON)',
    JSON.stringify(
      {
        name: fullName(p),
        personal: p.personal,
        headline: p.headline,
        current_title: p.current_title,
        current_company: p.current_company,
        total_years_experience: p.total_years_experience,
        skills: p.skills,
        experience: p.experience,
        education: p.education,
        certifications: p.certifications,
        languages: p.languages,
        preferences: p.preferences,
        summary: p.summary,
      },
      null,
      1,
    ),
  ];
  if (resumeText) {
    lines.push('', '## Resume text', resumeText);
  }
  return lines.join('\n');
}

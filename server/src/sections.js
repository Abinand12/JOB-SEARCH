// Repeating sections on company application forms ("Work experience 1, 2, ...",
// "Education", "Projects" with an "Add another" button). The extension tags each
// field in such a section with { kind, index }; the answer comes from that entry
// of the profile, so "Company" in the second experience block gets the second job.

export const SECTION_KINDS = ['experience', 'education', 'project'];

// How many entries of each kind the extension should create on a form.
export const SECTION_LIMITS = { experience: 5, education: 3, project: 3 };

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "2021-03" / "2021" / "Mar 2021" -> { year, month } (month 1-12 or null)
export function parseDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return { year: Number(m[1]), month: Number(m[2]) };
  m = s.match(/^(\d{1,2})\/(\d{4})$/);
  if (m) return { year: Number(m[2]), month: Number(m[1]) };
  m = s.match(/([a-z]{3,})\.?\s+(\d{4})/i);
  if (m) {
    const month = MONTHS.findIndex((n) => n.toLowerCase().startsWith(m[1].toLowerCase().slice(0, 3)));
    return { year: Number(m[2]), month: month >= 0 ? month + 1 : null };
  }
  m = s.match(/\b(\d{4})\b/);
  return m ? { year: Number(m[1]), month: null } : null;
}

const pad = (n) => String(n).padStart(2, '0');

// Format a date for the field: a month or year part, a date input, or text in the
// format the placeholder shows (MM/YYYY by default).
export function formatDate(value, field, q) {
  const d = parseDate(value);
  if (!d) return undefined;
  if (/\bmonth\b/.test(q) && !/\byear\b/.test(q)) {
    if (!d.month) return undefined;
    return field.options?.length ? MONTHS[d.month - 1] : String(d.month);
  }
  if (/\byear\b/.test(q) && !/\bmonth\b/.test(q)) return String(d.year);
  if (field.type === 'date') return `${d.year}-${pad(d.month ?? 1)}-01`;
  const hint = String(field.placeholder ?? '').toLowerCase();
  if (/yyyy-mm/.test(hint)) return `${d.year}-${pad(d.month ?? 1)}`;
  if (/^yyyy$/.test(hint.trim())) return String(d.year);
  if (/mm\/dd\/yyyy/.test(hint)) return `${pad(d.month ?? 1)}/01/${d.year}`;
  if (/dd\/mm\/yyyy/.test(hint)) return `01/${pad(d.month ?? 1)}/${d.year}`;
  return d.month ? `${pad(d.month)}/${d.year}` : String(d.year);
}

const START = /\b(start|from|began|begin|joined|joining)\b/;
const END = /\b(end|to|until|till|finish|finished|completion|graduat\w*|left|leaving)\b/;
const isDateQuestion = (q, field) => field.type === 'date' || /\b(date|month|year|period)\b/.test(q) || /^(from|to)$/.test(q);

// Each entry kind: [test, value(entry, q, field)] pairs, first match wins.
const SECTION_RULES = {
  experience: [
    [/current(ly)? (work|working|employed|role|job|position)|i (currently )?work here|present (role|job|position)|still (work|working)/, (e) => Boolean(e.is_current)],
    [(q, f) => isDateQuestion(q, f) && START.test(q), (e, q, f) => formatDate(e.start_date, f, q)],
    [(q, f) => isDateQuestion(q, f) && END.test(q), (e, q, f) => (e.is_current ? undefined : formatDate(e.end_date, f, q))],
    [/\b(description|responsibilit\w*|duties|achievements?|summary|details|what did you do)\b/, (e) => e.highlights],
    [/\b(location|city|place)\b/, (e) => e.location],
    [/\b(title|role|position|designation)\b/, (e) => e.title],
    [/\b(company|employer|organi[sz]ation|firm)\b/, (e) => e.company],
  ],
  education: [
    [/currently (studying|enrolled|attending)|still studying/, (e) => !e.end_year || Number(e.end_year) > new Date().getFullYear()],
    [(q, f) => isDateQuestion(q, f) && START.test(q), (e, q, f) => formatDate(e.start_year, f, q)],
    [(q, f) => isDateQuestion(q, f) && END.test(q), (e, q, f) => formatDate(e.end_year, f, q)],
    [/\b(school|university|college|institution|institute)\b/, (e) => e.school],
    [/\b(field of study|major|discipline|speciali[sz]ation|area of study|subject|course)\b/, (e) => e.field_of_study],
    [/\b(degree|qualification|level of education|diploma)\b/, (e) => e.degree],
    [/\b(c?gpa|grade|percentage|score|marks|result)\b/, (e) => e.grade],
  ],
  project: [
    [(q, f) => isDateQuestion(q, f) && START.test(q), (e, q, f) => formatDate(e.start_date, f, q)],
    [(q, f) => isDateQuestion(q, f) && END.test(q), (e, q, f) => formatDate(e.end_date, f, q)],
    [/\b(url|link|website|repo|repository|github)\b/, (e) => e.url],
    [/\b(technolog\w*|tools|tech stack|skills used|stack)\b/, (e) => (e.technologies ?? []).join(', ')],
    [/\b(description|summary|details|about|what did you (do|build))\b/, (e) => e.description],
    [/\b(your )?role\b/, (e) => e.role],
    [/\b(name|title)\b/, (e) => e.name],
  ],
};

const ENTRIES = { experience: 'experience', education: 'education', project: 'projects' };

/**
 * Answer a field inside a repeating section.
 * @returns {{matched:false} | {matched:true, value:any}} value undefined/'' means "leave it"
 */
export function answerSectionField(field, q, profile) {
  const { kind, index } = field.section ?? {};
  const rules = SECTION_RULES[kind];
  if (!rules || !Number.isInteger(index) || index < 0) return { matched: false };
  if (q.split(' ').length > 8) return { matched: false };
  const rule = rules.find(([test]) => (typeof test === 'function' ? test(q, field) : test.test(q)));
  if (!rule) return { matched: false };
  const entry = (profile[ENTRIES[kind]] ?? [])[index];
  if (!entry) return { matched: true, value: undefined };
  return { matched: true, value: rule[1](entry, q, field) };
}

export function sectionCounts(profile) {
  return Object.fromEntries(
    SECTION_KINDS.map((kind) => [kind, Math.min((profile[ENTRIES[kind]] ?? []).length, SECTION_LIMITS[kind])]),
  );
}

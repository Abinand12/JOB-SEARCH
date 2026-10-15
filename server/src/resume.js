import { extractText, getDocumentProxy } from 'unpdf';
import { ResumeProfileSchema } from './llm/schemas.js';

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

export async function extractResumeText(buffer, mimeType) {
  if (mimeType === 'application/pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await extractText(pdf, { mergePages: true });
    return cleanText(text);
  }
  if (mimeType === 'text/plain') {
    return cleanText(buffer.toString('utf8'));
  }
  throw badRequest('Upload your resume as a PDF');
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function cleanText(text) {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const PARSE_INSTRUCTIONS = `Extract the candidate's details from the resume into the JSON structure.

- Copy facts exactly as written; do not embellish or infer facts that are not in the resume.
- Use "" for unknown text fields, 0 for unknown numbers and [] for empty lists.
- Dates: "YYYY-MM" when the month is known, otherwise "YYYY". end_date is "" for a current role.
- total_years_experience: full-time professional experience in years (one decimal), from the role dates. Do not count overlapping roles twice.
- skills: every technical and professional skill mentioned, each with the years of hands-on use you can support from the role dates (0 if unclear).
- experience: most recent first. highlights: 1-3 sentences summarizing the role's achievements in the resume's own terms.
- education: highest degree first.
- headline: a one-line professional headline, e.g. "Senior Backend Engineer - Go, AWS, Kubernetes".
- summary: 2-3 sentences in first person, based only on the resume.`;

export async function parseResume(llm, resumeText) {
  if (!resumeText || resumeText.length < 50) {
    throw badRequest('Could not read text from this resume. Is it a scanned image? Export a text-based PDF.');
  }
  const { data, usage } = await llm.generateJson({
    system: PARSE_INSTRUCTIONS,
    user: `Resume:\n\n${resumeText}`,
    schema: ResumeProfileSchema,
    maxTokens: 8192,
  });
  return { profile: data, usage };
}

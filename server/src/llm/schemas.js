import { z } from 'zod';

// Unknown values are empty strings / 0 rather than optional fields, so every
// provider (including strict structured-output modes) can produce the same shape.
export const ResumeProfileSchema = z.object({
  personal: z.object({
    first_name: z.string(),
    last_name: z.string(),
    email: z.string(),
    phone: z.string(),
    city: z.string(),
    state: z.string(),
    country: z.string(),
    postal_code: z.string(),
    linkedin_url: z.string(),
    github_url: z.string(),
    portfolio_url: z.string(),
  }),
  headline: z.string(),
  summary: z.string(),
  current_title: z.string(),
  current_company: z.string(),
  total_years_experience: z.number(),
  skills: z.array(z.object({ name: z.string(), years: z.number() })),
  experience: z.array(
    z.object({
      title: z.string(),
      company: z.string(),
      location: z.string(),
      start_date: z.string(),
      end_date: z.string(),
      is_current: z.boolean(),
      highlights: z.string(),
    }),
  ),
  education: z.array(
    z.object({
      degree: z.string(),
      field_of_study: z.string(),
      school: z.string(),
      start_year: z.string(),
      end_year: z.string(),
      grade: z.string(),
    }),
  ),
  projects: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      url: z.string(),
      start_date: z.string(),
      end_date: z.string(),
      technologies: z.array(z.string()),
      description: z.string(),
    }),
  ),
  target_roles: z.array(z.string()),
  certifications: z.array(z.string()),
  languages: z.array(z.object({ language: z.string(), proficiency: z.string() })),
});

export const AnswersSchema = z.object({
  answers: z.array(
    z.object({
      id: z.string(),
      answer: z.string(),
      confidence: z.enum(['high', 'medium', 'low']),
    }),
  ),
});

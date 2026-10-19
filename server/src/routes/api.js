import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { answerFields } from '../answers.js';
import { generateExtensionToken, hashToken, rateLimitPerUser, requireUser } from '../auth.js';
import { DEFAULT_SETTINGS, mergeParsedResume, settingsWithDefaults, withDefaults } from '../profile.js';
import { extractResumeText, MAX_RESUME_BYTES, parseResume } from '../resume.js';
import { matchJob, searchQueries } from '../match.js';
import { SECTION_KINDS, sectionCounts } from '../sections.js';
import { computeStats, METHODS, STATUSES } from '../stats.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_RESUME_BYTES } });

const FieldSchema = z.object({
  id: z.string().max(200),
  label: z.string().max(2000).default(''),
  type: z.enum(['text', 'email', 'tel', 'number', 'url', 'textarea', 'select', 'radio', 'checkbox', 'checkbox_group', 'combobox', 'date', 'file']),
  options: z.array(z.string().max(500)).max(300).optional(),
  required: z.boolean().optional(),
  placeholder: z.string().max(500).optional(),
  name: z.string().max(200).optional(),
  max_length: z.number().int().positive().optional(),
  section: z
    .object({ kind: z.enum(SECTION_KINDS), index: z.number().int().min(0).max(20) })
    .optional(),
});

const JobSchema = z
  .object({
    title: z.string().max(500).optional(),
    company: z.string().max(500).optional(),
    location: z.string().max(500).optional(),
    url: z.string().max(2000).optional(),
    description: z.string().max(60_000).optional(),
  })
  .default({});

const ApplicationSchema = z.object({
  job_url: z.string().min(1).max(2000),
  job_title: z.string().max(500).optional(),
  company: z.string().max(500).optional(),
  location: z.string().max(500).optional(),
  source: z.string().max(50).optional(),
  method: z.enum(METHODS),
  ats: z.string().max(50).optional(),
  status: z.enum(STATUSES).optional(),
  match_score: z.number().int().min(0).max(100).nullable().optional(),
  failure_reason: z.string().max(2000).nullable().optional(),
});

const ApplicationPatchSchema = z.object({
  status: z.enum(STATUSES).optional(),
  failure_reason: z.string().max(2000).nullable().optional(),
  questions_answered: z.number().int().min(0).optional(),
  llm_answers: z.number().int().min(0).optional(),
  ats: z.string().max(50).optional(),
});

const AlertSchema = z.object({
  application_id: z.string().uuid().nullable().optional(),
  kind: z.string().max(50),
  page_url: z.string().max(2000).optional(),
  page_title: z.string().max(500).optional(),
});

function parseBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    const error = new Error(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    error.status = 400;
    throw error;
  }
  return result.data;
}

const toList = (v) =>
  (Array.isArray(v) ? v : String(v ?? '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean)
    .slice(0, 100);

export function sanitizeSettings(input = {}) {
  const out = settingsWithDefaults();
  for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
    if (!(key in input)) continue;
    const value = input[key];
    if (typeof def === 'boolean') out[key] = Boolean(value);
    else if (typeof def === 'number') out[key] = Math.max(0, Number(value) || 0);
    else if (Array.isArray(def)) out[key] = toList(value);
    else out[key] = String(value ?? '').slice(0, 500);
  }
  if (out.max_delay_sec < out.min_delay_sec) out.max_delay_sec = out.min_delay_sec;
  out.min_match_score = Math.min(out.min_match_score, 100);
  return out;
}

function startOfTodayUtc() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export function createApiRouter({ db, llm, config }) {
  const router = express.Router();
  const auth = requireUser(db);
  const answerLimiter = rateLimitPerUser(config.answerRequestsPerMinute);

  router.get('/health', (_req, res) => res.json({ ok: true }));

  router.get('/config', (_req, res) =>
    res.json({ supabaseUrl: config.supabase.url, supabaseAnonKey: config.supabase.anonKey }),
  );

  router.use(auth);

  // --- profile & resume -------------------------------------------------------
  router.get('/me', async (req, res) => {
    const row = await db.getProfile(req.user.id);
    res.json({
      user: { id: req.user.id, email: req.user.email ?? null },
      profile: withDefaults(row?.data),
      settings: settingsWithDefaults(row?.settings),
      resume: row?.resume_path ? { filename: row.resume_filename, updated_at: row.updated_at } : null,
      llm: { provider: llm.name, model: llm.model },
    });
  });

  router.put('/profile', async (req, res) => {
    const body = parseBody(
      z.object({ profile: z.record(z.string(), z.any()).optional(), settings: z.record(z.string(), z.any()).optional() }),
      req.body,
    );
    const patch = {};
    if (body.profile) patch.data = withDefaults(body.profile);
    if (body.settings) patch.settings = sanitizeSettings(body.settings);
    const row = await db.upsertProfile(req.user.id, patch);
    res.json({ profile: withDefaults(row.data), settings: settingsWithDefaults(row.settings) });
  });

  router.post('/resume', upload.single('resume'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Attach a resume file in the "resume" field' });
    const isPdf = req.file.mimetype === 'application/pdf' || /\.pdf$/i.test(req.file.originalname);
    const mimeType = isPdf ? 'application/pdf' : req.file.mimetype;
    const text = await extractResumeText(req.file.buffer, mimeType);
    const { profile: parsed, usage } = await parseResume(llm, text);
    await db.logUsage(req.user.id, {
      provider: llm.name,
      model: llm.model,
      purpose: 'resume_parse',
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
    });

    const { path } = await db.uploadResume(req.user.id, req.file.buffer, { filename: req.file.originalname, mimeType });
    const existing = await db.getProfile(req.user.id);
    const row = await db.upsertProfile(req.user.id, {
      data: mergeParsedResume(existing?.data, parsed),
      resume_text: text,
      resume_path: path,
      resume_filename: req.file.originalname,
      resume_mime: mimeType,
    });
    res.json({ profile: withDefaults(row.data), resume: { filename: row.resume_filename, updated_at: row.updated_at } });
  });

  router.get('/resume/file', async (req, res) => {
    const row = await db.getProfile(req.user.id);
    if (!row?.resume_path) return res.status(404).json({ error: 'Upload a resume in the dashboard first' });
    const buffer = await db.downloadResume(row.resume_path);
    res.set('content-type', row.resume_mime || 'application/pdf');
    res.set('x-filename', encodeURIComponent(row.resume_filename || 'resume.pdf'));
    res.send(buffer);
  });

  // --- extension session ------------------------------------------------------
  router.get('/session', async (req, res) => {
    const row = await db.getProfile(req.user.id);
    const settings = settingsWithDefaults(row?.settings);
    const profile = withDefaults(row?.data);
    res.json({
      settings,
      submitted_today: await db.countSubmittedSince(req.user.id, startOfTodayUtc()),
      has_resume: Boolean(row?.resume_path),
      // What the bot searches for, and how many experience/education/project rows to add on forms.
      search_queries: searchQueries(profile, settings),
      section_counts: sectionCounts(profile),
      name: [profile.personal.first_name, profile.personal.last_name].filter(Boolean).join(' '),
    });
  });

  // --- answering form fields ---------------------------------------------------
  router.post('/answers', answerLimiter, async (req, res) => {
    const body = parseBody(z.object({ fields: z.array(FieldSchema).max(150), job: JobSchema }), req.body);
    const [row, savedRows] = await Promise.all([db.getProfile(req.user.id), db.savedAnswers(req.user.id)]);
    const saved = new Map(savedRows.map((r) => [r.question_key, r]));

    const result = await answerFields({
      fields: body.fields,
      job: body.job,
      profile: row?.data,
      resumeText: row?.resume_text ?? '',
      settings: row?.settings,
      saved,
      llm,
    });

    if (result.usage) {
      await db.logUsage(req.user.id, {
        provider: llm.name,
        model: llm.model,
        purpose: 'answers',
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
      });
    }
    await db.insertSavedAnswers(req.user.id, result.newSaved);
    res.json({ answers: result.answers, missing: result.missing, llm_count: result.llmCount });
  });

  // --- job fit ------------------------------------------------------------------
  // Free and deterministic: no AI call, so the bot can check every job it opens.
  router.post('/match', async (req, res) => {
    const { job } = parseBody(z.object({ job: JobSchema }), req.body);
    const row = await db.getProfile(req.user.id);
    const settings = settingsWithDefaults(row?.settings);
    const result = matchJob(withDefaults(row?.data), job);
    res.json({ ...result, min_score: settings.min_match_score, apply: result.score >= settings.min_match_score });
  });

  // --- applications ------------------------------------------------------------
  router.post('/applications', async (req, res) => {
    const body = parseBody(ApplicationSchema, req.body);
    const existing = await db.findApplicationByUrl(req.user.id, body.job_url);
    if (existing?.status === 'submitted') {
      return res.json({ application: existing, already_applied: true });
    }
    const application = await db.upsertApplication(req.user.id, {
      ...body,
      status: body.status ?? 'in_progress',
      started_at: existing?.started_at ?? new Date().toISOString(),
      failure_reason: body.failure_reason ?? null,
    });
    res.status(existing ? 200 : 201).json({ application, already_applied: false });
  });

  router.patch('/applications/:id', async (req, res) => {
    const body = parseBody(ApplicationPatchSchema, req.body);
    const patch = { ...body };
    if (body.status === 'submitted') patch.submitted_at = new Date().toISOString();
    const application = await db.updateApplication(req.user.id, req.params.id, patch);
    if (!application) return res.status(404).json({ error: 'Application not found' });
    res.json({ application });
  });

  router.get('/applications', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const status = STATUSES.includes(req.query.status) ? req.query.status : undefined;
    const method = METHODS.includes(req.query.method) ? req.query.method : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : undefined;
    res.json(await db.listApplications(req.user.id, { status, method, q, limit, offset }));
  });

  router.get('/stats', async (req, res) => {
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));
    const [applications, usage] = await Promise.all([
      db.applicationsSince(req.user.id, since.toISOString()),
      db.usageSince(req.user.id, since.toISOString()),
    ]);
    const prices = knownPrices(config.llm);
    res.json({ ...computeStats(applications, { days, usage, prices }), llm_model: `${llm.name} / ${llm.model}` });
  });

  // --- verification alerts -----------------------------------------------------
  router.post('/alerts', async (req, res) => {
    const body = parseBody(AlertSchema, req.body);
    const alert = await db.createAlert(req.user.id, body);
    if (body.application_id) {
      await db.updateApplication(req.user.id, body.application_id, { status: 'needs_verification' });
    }
    res.status(201).json({ alert });
  });

  router.patch('/alerts/:id', async (req, res) => {
    const body = parseBody(z.object({ status: z.enum(['resolved', 'expired']) }), req.body);
    const alert = await db.updateAlert(req.user.id, req.params.id, { status: body.status, resolved_at: new Date().toISOString() });
    if (!alert) return res.status(404).json({ error: 'Alert not found' });
    if (alert.application_id && body.status === 'resolved') {
      await db.updateApplication(req.user.id, alert.application_id, { status: 'in_progress' });
    }
    res.json({ alert });
  });

  router.get('/alerts', async (req, res) => {
    const status = ['open', 'resolved', 'expired'].includes(req.query.status) ? req.query.status : undefined;
    res.json({ alerts: await db.listAlerts(req.user.id, { status }) });
  });

  // --- extension tokens ----------------------------------------------------------
  router.get('/tokens', async (req, res) => res.json({ tokens: await db.listTokens(req.user.id) }));

  router.post('/tokens', async (req, res) => {
    if (req.user.via !== 'dashboard') return res.status(403).json({ error: 'Create tokens from the dashboard' });
    const { label } = parseBody(z.object({ label: z.string().max(100).default('Chrome extension') }), req.body ?? {});
    const token = generateExtensionToken();
    const row = await db.createToken(req.user.id, hashToken(token), label);
    res.status(201).json({ token, ...row });
  });

  router.delete('/tokens/:id', async (req, res) => {
    await db.deleteToken(req.user.id, req.params.id);
    res.status(204).end();
  });

  // --- saved answers ---------------------------------------------------------------
  router.get('/saved-answers', async (req, res) => res.json({ answers: await db.savedAnswers(req.user.id) }));

  router.patch('/saved-answers/:id', async (req, res) => {
    const { answer } = parseBody(z.object({ answer: z.string().max(5000) }), req.body);
    const row = await db.updateSavedAnswer(req.user.id, req.params.id, { answer, source: 'user', needs_review: false });
    if (!row) return res.status(404).json({ error: 'Answer not found' });
    res.json({ answer: row });
  });

  router.delete('/saved-answers/:id', async (req, res) => {
    await db.deleteSavedAnswer(req.user.id, req.params.id);
    res.status(204).end();
  });

  return router;
}

// USD per million tokens, for the dashboard's cost estimate. Env vars override.
const PRICES = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
};

function knownPrices(llmConfig) {
  if (llmConfig.priceInputPerMTok !== null && llmConfig.priceOutputPerMTok !== null) {
    return { input: llmConfig.priceInputPerMTok, output: llmConfig.priceOutputPerMTok };
  }
  return PRICES[llmConfig.model] ?? null;
}

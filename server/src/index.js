import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { loadConfig, missingConfig } from './config.js';
import { cors } from './cors.js';
import { createDb } from './db.js';
import { createLlm, LlmError } from './llm/index.js';
import { createApiRouter } from './routes/api.js';
import { findWebDir, mountDashboards } from './web.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const missing = missingConfig(config);
if (missing.length) {
  console.error(`Missing environment variables: ${missing.join(', ')}. See .env.example.`);
  process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // behind Railway's proxy
app.use(express.json({ limit: '1mb' }));
app.use((_req, res, next) => {
  res.set('x-content-type-options', 'nosniff');
  res.set('referrer-policy', 'same-origin');
  next();
});

app.use('/api', cors(config.allowedOrigins));
app.use(
  '/api',
  createApiRouter({
    db: createDb(config.supabase),
    llm: createLlm(config.llm),
    config,
  }),
);
// Front-end libraries are served from node_modules so versions are pinned by package-lock.
const vendor = (file) => (_req, res) => res.sendFile(path.join(here, '..', 'node_modules', file));
app.get('/vendor/supabase.js', vendor('@supabase/supabase-js/dist/umd/supabase.js'));
app.get('/vendor/chart.js', vendor('chart.js/dist/chart.umd.min.js'));
// The built dashboard lives in /app/web in the Docker image, or web/dist/client in the repo.
mountDashboards(app, {
  webDir: findWebDir([process.env.WEB_DIR, path.join(here, '..', 'web'), path.join(here, '..', '..', 'web', 'dist', 'client')]),
  classicDir: path.join(here, '..', 'public'),
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Resume must be under 5 MB' : err.message });
  }
  if (err instanceof LlmError) {
    console.warn('LLM error:', err.message);
    return res.status(err.status).json({ error: err.message });
  }
  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(err);
  return res.status(500).json({ error: 'Something went wrong on the server' });
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`Job Autopilot listening on :${config.port} (LLM: ${config.llm.provider} / ${config.llm.model})`);
});

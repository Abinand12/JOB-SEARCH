// Serves the browser dashboards:
//   /          the main dashboard (built from web/, a single-page app)
//   /classic/  the original lightweight dashboard (server/public), kept as a fallback
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const SHELL_FILES = ['index.html', '_shell.html'];

export function findWebDir(candidates) {
  return candidates.find((dir) => dir && SHELL_FILES.some((f) => fs.existsSync(path.join(dir, f)))) ?? null;
}

export function mountDashboards(app, { webDir, classicDir }) {
  // The classic page uses relative asset paths, so it needs the trailing slash.
  app.use(
    '/classic',
    (req, res, next) => (req.originalUrl.split('?')[0] === '/classic' ? res.redirect(301, '/classic/') : next()),
    express.static(classicDir),
  );

  if (!webDir) {
    // No built SPA (e.g. local dev without building web/): the classic dashboard is the home page.
    app.use(express.static(classicDir));
    return { spa: false };
  }

  const shell = SHELL_FILES.map((f) => path.join(webDir, f)).find((f) => fs.existsSync(f));
  app.use(
    express.static(webDir, {
      index: false,
      setHeaders(res, filePath) {
        // Vite fingerprints everything under assets/, so it can be cached forever.
        if (filePath.includes(`${path.sep}assets${path.sep}`)) res.set('cache-control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  // Client-side routes (/overview, /applications, ...) all load the app shell.
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/') || req.path === '/api' || req.path.startsWith('/vendor/')) return next();
    if (!req.accepts('html')) return next();
    res.set('cache-control', 'no-cache');
    return res.sendFile(shell);
  });
  return { spa: true };
}

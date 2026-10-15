import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import { findWebDir, mountDashboards } from '../src/web.js';

function tempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

async function serve(app, t) {
  const server = app.listen(0);
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}

test('serves the SPA shell for client routes, assets with long cache, classic under /classic/', async (t) => {
  const webDir = tempDir({ '_shell.html': '<html>SPA</html>', 'assets/app-abc123.js': 'console.log(1)' });
  const classicDir = tempDir({ 'index.html': '<html>CLASSIC</html>' });
  assert.equal(findWebDir([undefined, '/nope', webDir]), webDir);

  const app = express();
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  mountDashboards(app, { webDir, classicDir });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));
  const base = await serve(app, t);

  for (const route of ['/', '/overview', '/applications?status=failed']) {
    const res = await fetch(base + route, { headers: { accept: 'text/html' } });
    assert.equal(await res.text(), '<html>SPA</html>', route);
  }
  const asset = await fetch(`${base}/assets/app-abc123.js`);
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.equal(await (await fetch(`${base}/classic/`)).text(), '<html>CLASSIC</html>');
  assert.equal((await fetch(`${base}/classic`, { redirect: 'manual' })).status, 301);
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true });
  const missingApi = await fetch(`${base}/api/nope`, { headers: { accept: 'text/html' } });
  assert.equal(missingApi.status, 404);
});

test('falls back to the classic dashboard at / when the SPA is not built', async (t) => {
  const classicDir = tempDir({ 'index.html': '<html>CLASSIC</html>' });
  const app = express();
  assert.deepEqual(mountDashboards(app, { webDir: null, classicDir }), { spa: false });
  const base = await serve(app, t);
  assert.equal(await (await fetch(`${base}/`)).text(), '<html>CLASSIC</html>');
});

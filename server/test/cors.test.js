import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { cors, DEFAULT_ALLOWED_ORIGINS, originMatcher } from '../src/cors.js';

test('originMatcher treats * as exactly one subdomain label', () => {
  const allowed = originMatcher(DEFAULT_ALLOWED_ORIGINS);
  assert.equal(allowed('https://id-preview--1234.lovable.app'), true);
  assert.equal(allowed('https://abc.lovableproject.com'), true);
  assert.equal(allowed('https://lovable.app'), false);
  assert.equal(allowed('https://evil.com/x.lovable.app'), false);
  assert.equal(allowed('https://a.b.lovable.app'), false);
  assert.equal(allowed('http://abc.lovable.app'), false);
  assert.equal(allowed('https://abc.lovable.app.evil.com'), false);
  assert.equal(allowed(undefined), false);
});

test('cors answers preflight for allowed origins and ignores others', async (t) => {
  const app = express();
  app.use('/api', cors(DEFAULT_ALLOWED_ORIGINS));
  app.get('/api/ping', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const pre = await fetch(`${base}/api/ping`, {
    method: 'OPTIONS',
    headers: { origin: 'https://x.lovable.app', 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://x.lovable.app');
  assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);

  const ok = await fetch(`${base}/api/ping`, { headers: { origin: 'https://x.lovable.app' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://x.lovable.app');

  const other = await fetch(`${base}/api/ping`, { headers: { origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

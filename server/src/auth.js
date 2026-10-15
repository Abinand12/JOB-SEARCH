import crypto from 'node:crypto';

export const TOKEN_PREFIX = 'jap_';

export function generateExtensionToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Dashboard requests carry the Supabase session JWT; the Chrome extension
// carries a long-lived token created in the dashboard.
export function requireUser(db) {
  return async (req, res, next) => {
    const extensionToken = req.get('x-extension-token');
    if (extensionToken) {
      if (!extensionToken.startsWith(TOKEN_PREFIX)) return res.status(401).json({ error: 'Invalid extension token' });
      const userId = await db.userIdForTokenHash(hashToken(extensionToken));
      if (!userId) return res.status(401).json({ error: 'Invalid extension token' });
      req.user = { id: userId, via: 'extension' };
      return next();
    }

    const bearer = req.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!bearer) return res.status(401).json({ error: 'Not signed in' });
    const user = await db.userFromAccessToken(bearer);
    if (!user) return res.status(401).json({ error: 'Session expired, sign in again' });
    req.user = { ...user, via: 'dashboard' };
    return next();
  };
}

// Small in-memory sliding window, per user. Enough for a single Railway instance.
export function rateLimitPerUser(limitPerMinute) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const recent = (hits.get(req.user.id) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limitPerMinute) {
      return res.status(429).json({ error: 'Too many requests, slow down' });
    }
    recent.push(now);
    hits.set(req.user.id, recent);
    return next();
  };
}

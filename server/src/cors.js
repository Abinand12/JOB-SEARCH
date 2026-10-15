// Lets a separately hosted dashboard (e.g. the Lovable app) call this API from the
// browser. The API authenticates with a Bearer token, never cookies, so allowing
// an origin does not let that site act as a user without the user's token.

export const DEFAULT_ALLOWED_ORIGINS = ['https://*.lovable.app', 'https://*.lovableproject.com'];

// "https://*.lovable.app" -> /^https:\/\/[^.]+\.lovable\.app$/ ("*" is one DNS label).
export function originMatcher(patterns) {
  const regexes = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\/]/g, '\\$&').replace(/\*/g, '[^./]+')}$`, 'i'));
  return (origin) => Boolean(origin) && regexes.some((r) => r.test(origin));
}

export function cors(patterns) {
  const allowed = originMatcher(patterns);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (allowed(origin)) {
      res.set('access-control-allow-origin', origin);
      res.vary('Origin');
      if (req.method === 'OPTIONS') {
        res.set('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.set('access-control-allow-headers', 'authorization, content-type');
        res.set('access-control-max-age', '600');
        return res.status(204).end();
      }
    }
    return next();
  };
}

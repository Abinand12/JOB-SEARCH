// Central place for environment configuration. Railway injects these as service variables.

const PROVIDER_DEFAULTS = {
  // Free tier available (Google AI Studio key). The "-latest" alias follows Google's current Flash-Lite.
  gemini: {
    model: 'gemini-flash-lite-latest',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyEnv: 'GEMINI_API_KEY',
  },
  // Free tier available (console.groq.com), rate limited per model.
  groq: {
    model: 'openai/gpt-oss-120b',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
  },
  // Paid, very cheap and accurate: $0.10 / $0.50 per million input / output tokens.
  anthropic: {
    model: 'claude-haiku-5-5',
    keyEnv: 'ANTHROPIC_API_KEY',
  },
  // Any other OpenAI-compatible endpoint: OpenRouter, DeepSeek, a local Ollama, ...
  openai_compatible: {
    model: '',
    baseUrl: '',
    keyEnv: 'LLM_API_KEY',
  },
};

function pickProvider(env) {
  if (env.LLM_PROVIDER) return env.LLM_PROVIDER;
  if (env.GEMINI_API_KEY) return 'gemini';
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.GROQ_API_KEY) return 'groq';
  if (env.LLM_BASE_URL) return 'openai_compatible';
  return 'gemini';
}

export function loadConfig(env = process.env) {
  const provider = pickProvider(env);
  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) {
    throw new Error(
      `Unknown LLM_PROVIDER "${provider}". Use one of: ${Object.keys(PROVIDER_DEFAULTS).join(', ')}`,
    );
  }

  return {
    port: Number(env.PORT) || 3000,
    supabase: {
      url: env.SUPABASE_URL || '',
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY || '',
      anonKey: env.SUPABASE_ANON_KEY || '',
    },
    llm: {
      provider,
      model: env.LLM_MODEL || defaults.model,
      apiKey: env[defaults.keyEnv] || env.LLM_API_KEY || '',
      baseUrl: env.LLM_BASE_URL || defaults.baseUrl || '',
      // Anthropic only: reasoning effort. "low" keeps form-filling fast and cheap.
      effort: env.LLM_EFFORT || 'low',
      // Optional, for the cost estimate on the dashboard (USD per million tokens).
      priceInputPerMTok: numberOrNull(env.LLM_PRICE_INPUT_PER_MTOK),
      priceOutputPerMTok: numberOrNull(env.LLM_PRICE_OUTPUT_PER_MTOK),
    },
    // Guard against a runaway loop burning LLM credits: answer requests per user per minute.
    answerRequestsPerMinute: Number(env.ANSWER_REQUESTS_PER_MINUTE) || 30,
  };
}

function numberOrNull(value) {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function missingConfig(config) {
  const missing = [];
  if (!config.supabase.url) missing.push('SUPABASE_URL');
  if (!config.supabase.serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!config.supabase.anonKey) missing.push('SUPABASE_ANON_KEY');
  if (!config.llm.apiKey && config.llm.provider !== 'openai_compatible') {
    missing.push(PROVIDER_DEFAULTS[config.llm.provider].keyEnv);
  }
  if (config.llm.provider === 'openai_compatible') {
    if (!config.llm.baseUrl) missing.push('LLM_BASE_URL');
    if (!config.llm.model) missing.push('LLM_MODEL');
  }
  return missing;
}

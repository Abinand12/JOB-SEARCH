import { createAnthropicProvider } from './anthropic.js';
import { createOpenAiCompatibleProvider } from './openaiCompatible.js';

export function createLlm(llmConfig) {
  const { provider, model, apiKey, baseUrl, effort } = llmConfig;
  if (provider === 'anthropic') {
    return createAnthropicProvider({ apiKey, model, effort });
  }
  return createOpenAiCompatibleProvider({ name: provider, apiKey, model, baseUrl });
}

export { LlmError } from './errors.js';

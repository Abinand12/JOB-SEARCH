import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LlmError } from './errors.js';

export function createAnthropicProvider({ apiKey, model, effort }) {
  const client = new Anthropic({ apiKey });

  return {
    name: 'anthropic',
    model,
    async generateJson({ system, user, schema, maxTokens = 4096 }) {
      let response;
      try {
        response = await client.messages.parse({
          model,
          max_tokens: maxTokens,
          // The system prompt carries the candidate profile, which is identical for every
          // question during an auto-apply session, so cache it.
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: user }],
          output_config: { effort, format: zodOutputFormat(schema) },
        });
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError) {
          throw new LlmError('LLM rate limit reached, retry shortly', { status: 429, cause: error });
        }
        if (error instanceof Anthropic.AuthenticationError) {
          throw new LlmError('Invalid ANTHROPIC_API_KEY', { status: 500, cause: error });
        }
        if (error instanceof Anthropic.APIError) {
          throw new LlmError(`Anthropic API error ${error.status}: ${error.message}`, { cause: error });
        }
        throw error;
      }

      if (response.stop_reason === 'refusal') {
        throw new LlmError('The model declined this request');
      }
      if (response.stop_reason === 'max_tokens') {
        throw new LlmError('LLM output was cut off (max_tokens); try again');
      }
      if (!response.parsed_output) {
        throw new LlmError('LLM returned output that did not match the schema');
      }
      return {
        data: response.parsed_output,
        usage: {
          inputTokens:
            (response.usage.input_tokens ?? 0) +
            (response.usage.cache_read_input_tokens ?? 0) +
            (response.usage.cache_creation_input_tokens ?? 0),
          outputTokens: response.usage.output_tokens ?? 0,
        },
      };
    },
  };
}

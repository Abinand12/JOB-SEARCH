import { z } from 'zod';
import { LlmError } from './errors.js';

// Gemini, Groq, OpenRouter, DeepSeek and Ollama all expose an OpenAI-style
// /chat/completions endpoint, so one small fetch client covers them.
export function createOpenAiCompatibleProvider({ name, apiKey, model, baseUrl }) {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  return {
    name,
    model,
    async generateJson({ system, user, schema, maxTokens = 4096 }) {
      const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
      const body = {
        model,
        max_tokens: maxTokens,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `${system}\n\nReply with a single JSON object that matches this JSON Schema, and nothing else:\n${jsonSchema}`,
          },
          { role: 'user', content: user },
        ],
      };

      const headers = { 'content-type': 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        });
      } catch (error) {
        throw new LlmError(`Could not reach ${name}: ${error.message}`, { cause: error });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const status = res.status === 429 ? 429 : 502;
        throw new LlmError(`${name} API error ${res.status}: ${text.slice(0, 300)}`, { status });
      }

      const payload = await res.json();
      const content = payload.choices?.[0]?.message?.content ?? '';
      const parsed = schema.safeParse(extractJson(content));
      if (!parsed.success) {
        throw new LlmError(`${name} returned JSON that did not match the schema`);
      }
      return {
        data: parsed.data,
        usage: {
          inputTokens: payload.usage?.prompt_tokens ?? 0,
          outputTokens: payload.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

// Models sometimes wrap JSON in ``` fences or add a sentence before it.
export function extractJson(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      // fall through
    }
  }
  return null;
}

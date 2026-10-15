import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createAnthropicProvider } from '../src/llm/anthropic.js';
import { createOpenAiCompatibleProvider } from '../src/llm/openaiCompatible.js';
import { AnswersSchema } from '../src/llm/schemas.js';

// Local stand-ins for the provider APIs, so the request shape and response
// parsing are tested without network access or API keys.
let server;
let baseUrl;
const requests = [];
const answer = { answers: [{ id: 'f1', answer: 'Yes', confidence: 'high' }] };

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ url: req.url, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      if (req.url.endsWith('/v1/messages')) {
        res.end(
          JSON.stringify({
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [{ type: 'text', text: JSON.stringify(answer) }],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90, cache_creation_input_tokens: 0 },
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\`` } }],
            usage: { prompt_tokens: 120, completion_tokens: 8 },
          }),
        );
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('anthropic provider sends structured-output request and parses it', async (t) => {
  process.env.ANTHROPIC_BASE_URL = baseUrl; // the SDK reads this
  t.after(() => delete process.env.ANTHROPIC_BASE_URL);

  const llm = createAnthropicProvider({ apiKey: 'test-key', model: 'claude-haiku-5-5', effort: 'low' });
  const { data, usage } = await llm.generateJson({ system: 'SYSTEM', user: 'USER', schema: AnswersSchema });

  assert.deepEqual(data, answer);
  assert.deepEqual(usage, { inputTokens: 100, outputTokens: 5 });
  const req = requests.find((r) => r.url.endsWith('/v1/messages'));
  assert.equal(req.headers['x-api-key'], 'test-key');
  assert.equal(req.body.model, 'claude-haiku-5-5');
  assert.equal(req.body.output_config.effort, 'low');
  assert.equal(req.body.output_config.format.type, 'json_schema');
  assert.deepEqual(req.body.system[0].cache_control, { type: 'ephemeral' });
});

test('openai-compatible provider (Gemini/Groq) parses fenced JSON', async () => {
  const llm = createOpenAiCompatibleProvider({ name: 'gemini', apiKey: 'g-key', model: 'gemini-flash-lite-latest', baseUrl: `${baseUrl}/v1beta/openai/` });
  const { data, usage } = await llm.generateJson({ system: 'SYSTEM', user: 'USER', schema: AnswersSchema });

  assert.deepEqual(data, answer);
  assert.deepEqual(usage, { inputTokens: 120, outputTokens: 8 });
  const req = requests.find((r) => r.url === '/v1beta/openai/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer g-key');
  assert.equal(req.body.response_format.type, 'json_object');
  assert.match(req.body.messages[0].content, /JSON Schema/);
});

/**
 * Gemini adapter behaviour with a stubbed client (test boundary only; not live evidence).
 */
import { ApiError } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { ChainProvider, createAiProvider, describeAiError, OpenAiCompatibleProvider, strictOutputSchema } from '../../server/integrations/ai/provider';
import { loadConfig } from '../../server/config';
import { testEnv } from '../helpers/harness';

function provider(model: string, impl: (req: any) => Promise<any>, extra: Record<string, string> = {}) {
  // A short timeout keeps overload retries (1.5 s, 3 s, …) to one pause in these tests.
  const cfg = loadConfig(testEnv({ AI_PROVIDER: 'gemini', AI_MODEL: model, GEMINI_API_KEY: 'test-key-not-real', AI_TIMEOUT_MS: '6000', ...extra }));
  const p = createAiProvider(cfg);
  const calls: any[] = [];
  (p as any).client = { models: { generateContent: async (req: any) => (calls.push(req), impl(req)) } };
  return { p, calls };
}
const ok = { text: '{"ok":true}', usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } };
const req = { system: 's', prompt: 'p', jsonSchema: { type: 'object' } };

describe('Gemini adapter', () => {
  it('uses a low thinking level and no sampling settings on Gemini 3+ models', async () => {
    const { p, calls } = provider('gemini-3.8-flash', async () => ok);
    await p.generateJson(req);
    expect(calls[0].config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
    expect(calls[0].config.temperature).toBeUndefined();
    expect(calls[0].config.responseMimeType).toBe('application/json');
  });

  it('turns thinking off on Gemini 2.5 Flash', async () => {
    const { p, calls } = provider('gemini-2.5-flash', async () => ok);
    await p.generateJson(req);
    expect(calls[0].config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('retries once without optional settings when the model rejects them', async () => {
    let n = 0;
    const { p, calls } = provider('gemini-3.9-pro', async () => {
      if (n++ === 0) throw new ApiError({ message: '{"error":{"code":400,"message":"thinking_level not supported"}}', status: 400 });
      return ok;
    });
    const out = await p.generateJson(req);
    expect(out.text).toBe('{"ok":true}');
    expect(calls).toHaveLength(2);
    expect(calls[1].config.thinkingConfig).toBeUndefined();
  });

  it('explains a retired model in plain words, with Google’s message', async () => {
    const { p } = provider('gemini-2.5-flash', async () => {
      throw new ApiError({ message: '{"error":{"code":404,"message":"This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash","status":"NOT_FOUND"}}', status: 404 });
    });
    await expect(p.generateJson(req)).rejects.toThrow(/AI model "gemini-2.5-flash" is not available.*gemini-3.8-flash/);
  });

  it('classifies key, quota and timeout failures', () => {
    expect(describeAiError(new ApiError({ message: 'API key not valid', status: 400 }), 'm', 8000).kind).toBe('bad_request');
    expect(describeAiError(new ApiError({ message: 'denied', status: 403 }), 'm', 8000).message).toMatch(/API key was refused/);
    expect(describeAiError(new ApiError({ message: 'quota', status: 429 }), 'm', 8000).kind).toBe('quota');
    const t = new Error('signal timed out');
    t.name = 'TimeoutError';
    expect(describeAiError(t, 'm', 8000).message).toBe('The AI model did not answer within 8 seconds.');
  });

  it('retries once when Google is overloaded, then explains it', async () => {
    let n = 0;
    const busy = () => new ApiError({ message: '{"error":{"code":503,"message":"This model is currently experiencing high demand."}}', status: 503 });
    const once = provider('gemini-3.8-flash', async () => {
      if (n++ === 0) throw busy();
      return ok;
    });
    await expect(once.p.generateJson(req)).resolves.toMatchObject({ text: '{"ok":true}' });
    expect(once.calls).toHaveLength(2);
    const always = provider('gemini-3.8-flash', async () => {
      throw busy();
    });
    await expect(always.p.generateJson(req)).rejects.toThrow(/overloaded right now/);
    expect(always.calls).toHaveLength(2);
  });

  it('switches to the owner-configured backup model when the first is overloaded or over quota', async () => {
    const busy = new ApiError({ message: '{"error":{"code":503,"message":"high demand"}}', status: 503 });
    const quota = new ApiError({ message: '{"error":{"code":429,"message":"Quota exceeded"}}', status: 429 });
    for (const failure of [busy, quota]) {
      const { p, calls } = provider('gemini-3.8-flash', async (r) => {
        if (r.model === 'gemini-3.8-flash') throw failure;
        return ok;
      }, { AI_FALLBACK_MODEL: 'backup-model' });
      const out = await p.generateJson(req);
      expect(out.model).toBe('backup-model');
      expect(calls.at(-1).model).toBe('backup-model');
    }
  }, 15_000);

  it('gives the backup model the rest of the time when the main model does not answer', async () => {
    const stalled = (r: any) =>
      new Promise((_, reject) => r.config.abortSignal.addEventListener('abort', () => reject(r.config.abortSignal.reason)));
    const { p, calls } = provider('gemini-3.8-flash', async (r) => (r.model === 'gemini-3.8-flash' ? stalled(r) : ok), { AI_FALLBACK_MODEL: 'backup-model', AI_TIMEOUT_MS: '20000' });
    expect((p as any).primaryMs).toBe(12_000);
    (p as any).primaryMs = 300; // keep the test fast; the split itself is checked above
    const out = await p.generateJson({ ...req, maxOutputTokens: 4096 });
    expect(out.model).toBe('backup-model');
    expect(calls.map((c) => c.model)).toEqual(['gemini-3.8-flash', 'backup-model']);
    expect(calls[0].config.maxOutputTokens).toBe(4096);
  });

  it('does not switch models for a bad request, and reports both failures when the backup fails too', async () => {
    const bad = provider('gemini-3.8-flash', async () => {
      throw new ApiError({ message: 'API key not valid', status: 403 });
    }, { AI_FALLBACK_MODEL: 'backup-model' });
    await expect(bad.p.generateJson(req)).rejects.toThrow(/API key was refused/);
    expect(bad.calls.every((c) => c.model === 'gemini-3.8-flash')).toBe(true);
    const both = provider('gemini-3.8-flash', async () => {
      throw new ApiError({ message: '{"error":{"code":429,"message":"Quota exceeded"}}', status: 429 });
    }, { AI_FALLBACK_MODEL: 'backup-model' });
    await expect(both.p.generateJson(req)).rejects.toThrow(/backup model "backup-model" also failed/);
  });

  it('explains the free-tier request limit with the wait time', () => {
    const e = describeAiError(
      new ApiError({ message: '{"error":{"code":429,"message":"You exceeded your current quota. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3.8-flash\\nPlease retry in 25.478017s."}}', status: 429 }),
      'gemini-3.8-flash',
      9000
    );
    expect(e.kind).toBe('quota');
    expect(e.message).toBe("Gemini's usage limit was reached (free tier: 5 requests per minute for gemini-3.8-flash). Try again in about 26 seconds, or enable billing for this key in Google AI Studio for higher limits.");
  });

  it('treats an empty answer as a failure', async () => {
    const { p } = provider('gemini-3.8-flash', async () => ({ text: '' }));
    await expect(p.generateJson(req)).rejects.toThrow(/empty answer/);
  });
});

describe('NVIDIA (OpenAI-compatible) adapter and Gemini → NVIDIA backup', () => {
  const answer = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 5, completion_tokens: 3 } }), { status: 200 });
  it('enforces strategy schemas for OpenAI without mutating the original schema', async () => {
    const sent: any[] = [];
    const p = new OpenAiCompatibleProvider('openai', 'gpt-4o-mini', 'test', 'https://openai.example/v1', 6000, 2000, async (_url, init) => {
      sent.push(JSON.parse(String(init!.body))); return answer('{"ok":true}');
    });
    const schema = { type: 'object', properties: { plans: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } } };
    await p.generateJson({ ...req, jsonSchema: schema, enforceSchema: true });
    const format = sent[0].response_format;
    expect(format.type).toBe('json_schema');
    expect(format.json_schema.strict).toBe(true);
    expect(format.json_schema.schema.required).toEqual(['plans']);
    expect(format.json_schema.schema.properties.plans.items.additionalProperties).toBe(false);
    expect(schema).not.toHaveProperty('additionalProperties');
    expect(strictOutputSchema({ type: 'string' })).toEqual({ type: 'string' });
  });
  it('falls back to JSON mode when a compatible endpoint does not support schemas', async () => {
    const sent: any[] = [];
    const p = new OpenAiCompatibleProvider('openai', 'gpt-4o-mini', 'test', 'https://openai.example/v1', 6000, 2000, async (_url, init) => {
      sent.push(JSON.parse(String(init!.body)));
      return sent.length === 1 ? new Response('{"error":"json_schema unsupported"}', { status: 400 }) : answer('{"ok":true}');
    });
    await p.generateJson({ ...req, enforceSchema: true });
    expect(sent[0].response_format.type).toBe('json_schema');
    expect(sent[1].response_format.type).toBe('json_object');
  });

  it('sends the schema in the prompt, drops JSON mode if refused, and extracts the JSON', async () => {
    const sent: any[] = [];
    const p = new OpenAiCompatibleProvider('nvidia', 'meta/llama-test-instruct', 'nvapi-test', 'https://nvidia.example/v1/', 6000, 2000, async (url, init) => {
      sent.push({ url, body: JSON.parse(String(init!.body)), auth: (init!.headers as Record<string, string>).Authorization });
      if (sent.length === 1) return new Response('{"error":"response_format not supported"}', { status: 400 });
      return answer('<think>plan</think>```json\n{"ok":true}\n```');
    });
    const out = await p.generateJson(req);
    expect(out).toMatchObject({ text: '{"ok":true}', model: 'meta/llama-test-instruct', inputTokens: 5 });
    expect(sent[0].url).toBe('https://nvidia.example/v1/chat/completions');
    expect(sent[0].auth).toBe('Bearer nvapi-test');
    expect(sent[0].body.response_format).toEqual({ type: 'json_object' });
    expect(sent[1].body.response_format).toBeUndefined();
    expect(sent[0].body.messages[0].content).toContain('JSON Schema');
  });

  it('explains a refused key and an unknown model', async () => {
    const auth = new OpenAiCompatibleProvider('nvidia', 'm', 'bad', 'https://nvidia.example/v1', 6000, 2000, async () => new Response('{"detail":"Unauthorized"}', { status: 401 }));
    await expect(auth.generateJson(req)).rejects.toThrow(/NVIDIA API key was refused/);
    const missing = new OpenAiCompatibleProvider('nvidia', 'nope', 'k', 'https://nvidia.example/v1', 6000, 2000, async () => new Response('{"detail":"Not found"}', { status: 404 }));
    await expect(missing.generateJson(req)).rejects.toThrow(/model "nope" is not available.*NVIDIA_MODEL/);
  });

  it('uses NVIDIA when Gemini is overloaded, and not for other Gemini errors', async () => {
    const nvidia = new OpenAiCompatibleProvider('nvidia', 'meta/llama-test-instruct', 'k', 'https://nvidia.example/v1', 6000, 2000, async () => answer('{"ok":true}'));
    const busyGemini = { name: 'gemini' as const, model: 'gemini-3.8-flash', enabled: true, generateJson: async () => { throw describeAiError(new ApiError({ message: 'high demand', status: 503 }), 'gemini-3.8-flash', 6000); } };
    const chain = new ChainProvider(busyGemini, nvidia, 6000);
    expect(chain.name).toBe('gemini');
    await expect(chain.generateJson(req)).resolves.toMatchObject({ model: 'meta/llama-test-instruct' });
    const badKeyGemini = { ...busyGemini, generateJson: async () => { throw describeAiError(new ApiError({ message: 'denied', status: 403 }), 'gemini-3.8-flash', 6000); } };
    await expect(new ChainProvider(badKeyGemini, nvidia, 6000).generateJson(req)).rejects.toThrow(/API key was refused/);
  });

  it('builds Gemini with NVIDIA as backup, or NVIDIA alone, from configuration', () => {
    const both = createAiProvider(loadConfig(testEnv({ AI_PROVIDER: 'gemini', AI_MODEL: 'gemini-3.8-flash', GEMINI_API_KEY: 'g', NVIDIA_API_KEY: 'n', NVIDIA_MODEL: 'meta/llama-test-instruct' })));
    expect(both).toBeInstanceOf(ChainProvider);
    const alone = createAiProvider(loadConfig(testEnv({ AI_PROVIDER: 'nvidia', NVIDIA_API_KEY: 'n', NVIDIA_MODEL: 'meta/llama-test-instruct' })));
    expect(alone).toBeInstanceOf(OpenAiCompatibleProvider);
    expect(() => loadConfig(testEnv({ AI_PROVIDER: 'nvidia' }))).toThrow(/requires NVIDIA_MODEL and NVIDIA_API_KEY/);
  });

  it('supports OpenAI/ChatGPT as a first-class AI provider', () => {
    const openai = createAiProvider(loadConfig(testEnv({ AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k', OPENAI_MODEL: 'gpt-4o-mini' })));
    expect(openai).toBeInstanceOf(OpenAiCompatibleProvider);
    expect((openai as OpenAiCompatibleProvider).model).toBe('gpt-4o-mini');
    expect(() => loadConfig(testEnv({ AI_PROVIDER: 'openai' }))).toThrow(/requires OPENAI_MODEL and OPENAI_API_KEY/);
  });
});

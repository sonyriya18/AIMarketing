/**
 * AI provider interface (decision D11). Core analytics never depend on it.
 * - `none`  : AI disabled; callers return deterministic output with aiStatus "disabled".
 * - `gemini`: @google/genai with the configured model only (no hidden fallback list),
 *             JSON-schema structured output, a real abort signal for timeouts.
 */
import { ApiError as GenAiApiError, GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { AppConfig } from '../../config';

export interface AiResult {
  text: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AiRequest {
  system: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  signal?: AbortSignal;
  /** Lower output cap for short answers (default AI_MAX_OUTPUT_TOKENS). */
  maxOutputTokens?: number;
  /** Require schema-shaped output where the provider supports it. Local evidence checks still apply. */
  enforceSchema?: boolean;
}

export interface AiProvider {
  readonly name: 'none' | 'gemini' | 'nvidia' | 'openai' | 'test';
  readonly model: string | null;
  readonly enabled: boolean;
  generateJson(req: AiRequest): Promise<AiResult>;
}

export class AiDisabledError extends Error {}

export const noneProvider: AiProvider = {
  name: 'none',
  model: null,
  enabled: false,
  async generateJson() {
    throw new AiDisabledError('AI is not configured for this deployment');
  },
};

/**
 * A provider failure in plain words, safe to show to signed-in users and to log: it carries the
 * provider's status and message (never the key or the prompt).
 */
export class AiCallError extends Error {
  constructor(
    message: string,
    readonly kind: 'model_unavailable' | 'auth' | 'quota' | 'busy' | 'timeout' | 'bad_request' | 'unavailable',
    readonly providerStatus: number | null
  ) {
    super(message);
  }
}

function providerMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    /* not JSON */
  }
  return raw;
}

export function describeAiError(e: unknown, model: string, timeoutMs: number): AiCallError {
  if (e instanceof AiCallError) return e;
  const status = e instanceof GenAiApiError ? e.status : null;
  const msg = providerMessage(e).replace(/key=[^&\s]+/gi, 'key=…').slice(0, 400);
  const name = e instanceof Error ? e.name : '';
  if (name === 'TimeoutError' || name === 'AbortError' || /aborted|timed? ?out/i.test(msg)) {
    return new AiCallError(`The AI model did not answer within ${Math.round(timeoutMs / 1000)} seconds.`, 'timeout', status);
  }
  if (status === 404) return new AiCallError(`The AI model "${model}" is not available to this API key. Set AI_MODEL to a current model. Google says: ${msg}`, 'model_unavailable', status);
  if (status === 401 || status === 403) return new AiCallError(`The Gemini API key was refused. Check GEMINI_API_KEY. Google says: ${msg}`, 'auth', status);
  if (status === 429) {
    const wait = msg.match(/retry in ([\d.]+)\s*s/i);
    const perMinute = msg.match(/free_tier_requests, limit: (\d+)/i);
    return new AiCallError(
      `Gemini's usage limit was reached${perMinute ? ` (free tier: ${perMinute[1]} requests per minute for ${model})` : ''}. ${wait ? `Try again in about ${Math.ceil(Number(wait[1]))} seconds` : 'Try again in a minute'}, or enable billing for this key in Google AI Studio for higher limits.`,
      'quota',
      status
    );
  }
  if (status === 503 || status === 500 || /high demand|overloaded/i.test(msg)) {
    return new AiCallError('Google’s Gemini service is overloaded right now (high demand). This is temporary — try again in a minute.', 'busy', status);
  }
  if (status === 400) return new AiCallError(`Google rejected the request. Google says: ${msg}`, 'bad_request', status);
  return new AiCallError(`The AI service is unavailable. ${msg}`, 'unavailable', status);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Model-specific options. These answers only rephrase supplied facts, so reasoning is kept low:
 * Gemini 3+ takes a thinking level (and no sampling settings); 2.5 Flash takes a zero budget.
 * Unknown models get no optional settings.
 */
export function tuningFor(model: string): Record<string, unknown> {
  if (/^gemini-([3-9]|\d{2,})/.test(model)) return { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } };
  if (/^gemini-2\.5-flash/.test(model)) return { temperature: 0.2, thinkingConfig: { thinkingBudget: 0 } };
  if (/^gemini-2/.test(model)) return { temperature: 0.2 };
  return {};
}

class GeminiProvider implements AiProvider {
  readonly name = 'gemini' as const;
  readonly enabled = true;
  private readonly client: GoogleGenAI;

  constructor(
    readonly model: string,
    apiKey: string,
    private readonly timeoutMs: number,
    private readonly maxOutputTokens: number,
    /** Owner-configured second model (AI_FALLBACK_MODEL), used only when the first is busy, over quota or unavailable. */
    private readonly fallbackModel: string | null = null,
    /** Fewer overload retries when another provider is configured to take over. */
    private readonly maxBusyRetries = 3
  ) {
    this.client = new GoogleGenAI({ apiKey });
    // With a backup model and a long limit, the main model gets 60% of the time, so a stalled answer
    // still leaves time for the backup to answer within the same overall limit.
    this.primaryMs = fallbackModel && timeoutMs >= 20_000 ? Math.round(timeoutMs * 0.6) : timeoutMs;
  }
  private readonly primaryMs: number;

  private async call(model: string, req: AiRequest, signal: AbortSignal, tuned: boolean) {
    return this.client.models.generateContent({
      model,
      contents: req.prompt,
      config: {
        systemInstruction: req.system,
        responseMimeType: 'application/json',
        responseJsonSchema: req.jsonSchema,
        maxOutputTokens: Math.min(req.maxOutputTokens ?? this.maxOutputTokens, this.maxOutputTokens),
        ...(tuned ? tuningFor(model) : {}),
        abortSignal: signal,
      },
    });
  }

  /** One model, with retries: without optional settings on 400, after a pause on 500/503 (overload). */
  private async tryModel(model: string, req: AiRequest, signal: AbortSignal, deadline: number, limitMs: number) {
    let tuned = true;
    let busyRetries = 0;
    for (;;) {
      try {
        return await this.call(model, req, signal, tuned);
      } catch (e) {
        const status = e instanceof GenAiApiError ? e.status : null;
        const left = deadline - Date.now();
        if (signal.aborted) throw describeAiError(e, model, limitMs);
        if (status === 400 && tuned) {
          tuned = false;
          continue;
        }
        if ((status === 500 || status === 503) && busyRetries < this.maxBusyRetries) {
          const pause = 1500 * 2 ** busyRetries;
          if (left > pause + 3000) {
            busyRetries++;
            await sleep(pause);
            continue;
          }
        }
        throw describeAiError(e, model, limitMs);
      }
    }
  }

  async generateJson(req: AiRequest): Promise<AiResult> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const deadline = Date.now() + this.timeoutMs;
    const firstMs = this.primaryMs;
    const firstSignal = firstMs < this.timeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(firstMs)]) : signal;
    let model = this.model;
    let res;
    try {
      res = await this.tryModel(model, req, firstSignal, Math.min(deadline, Date.now() + firstMs), firstMs);
    } catch (e) {
      const err = e as AiCallError;
      const switchable = err.kind === 'busy' || err.kind === 'quota' || err.kind === 'model_unavailable' || err.kind === 'timeout';
      if (!this.fallbackModel || !switchable || signal.aborted || deadline - Date.now() < 2500) throw err;
      model = this.fallbackModel;
      try {
        res = await this.tryModel(model, req, signal, deadline, deadline - Date.now());
      } catch (e2) {
        const err2 = e2 as AiCallError;
        throw new AiCallError(`${err.message} The backup model "${model}" also failed: ${err2.message}`, err2.kind, err2.providerStatus);
      }
    }
    const text = res.text ?? '';
    if (!text.trim()) throw new AiCallError('The AI model returned an empty answer.', 'unavailable', null);
    return {
      text,
      model,
      inputTokens: res.usageMetadata?.promptTokenCount ?? null,
      outputTokens: res.usageMetadata?.candidatesTokenCount ?? null,
    };
  }
}

/** Extracts the JSON object from a chat answer (markdown fences or reasoning text around it). */
export function extractJson(text: string): string {
  const t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    JSON.parse(t);
    return t;
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    return a >= 0 && b > a ? t.slice(a, b + 1) : t;
  }
}

function describeHttpError(status: number, body: string, label: string, model: string, keyVar: string, modelVar: string): AiCallError {
  let msg = body;
  try {
    const j = JSON.parse(body) as { error?: { message?: string } | string; detail?: string; message?: string };
    msg = (typeof j.error === 'string' ? j.error : j.error?.message) ?? j.detail ?? j.message ?? body;
  } catch {
    /* not JSON */
  }
  msg = String(msg).slice(0, 300);
  if (status === 401 || status === 403) return new AiCallError(`The ${label} API key was refused. Check ${keyVar}. ${label} says: ${msg}`, 'auth', status);
  if (status === 404) return new AiCallError(`The ${label} model "${model}" is not available to this key. Set ${modelVar} to a listed model (npm run ai:models -- --nvidia). ${label} says: ${msg}`, 'model_unavailable', status);
  if (status === 429) return new AiCallError(`${label}'s usage limit was reached. Try again in a minute. ${label} says: ${msg}`, 'quota', status);
  if (status >= 500) return new AiCallError(`${label}'s service is overloaded or unavailable right now. Try again in a minute.`, 'busy', status);
  return new AiCallError(`${label} rejected the request. ${label} says: ${msg}`, 'bad_request', status);
}

/**
 * OpenAI-compatible chat completions — used for NVIDIA's API catalog (NVIDIA_BASE_URL). The JSON
 * shape is requested in the system message (JSON mode is tried first and dropped if refused); the
 * answer is extracted and then validated by the caller exactly like a Gemini answer.
 */
/** Structured Outputs requires closed objects and every declared property in required. */
export function strictOutputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strictOutputSchema);
  if (!value || typeof value !== 'object') return value;
  const schema = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, strictOutputSchema(child)]));
  if (schema.type === 'object' && schema.properties && typeof schema.properties === 'object') {
    schema.additionalProperties = false;
    schema.required = Object.keys(schema.properties);
  }
  return schema;
}

export class OpenAiCompatibleProvider implements AiProvider {
  readonly enabled = true;
  constructor(
    readonly name: 'nvidia' | 'openai',
    readonly model: string,
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
    private readonly maxOutputTokens: number,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)
  ) {}

  private label() {
    return this.name === 'openai' ? 'OpenAI' : 'NVIDIA';
  }

  async generateJson(req: AiRequest): Promise<AiResult> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
    const deadline = Date.now() + this.timeoutMs;
    const system = `${req.system}\n\nAnswer with exactly one JSON object and nothing else (no markdown), matching this JSON Schema:\n${JSON.stringify(req.jsonSchema)}`;
    let jsonMode = true;
    let schemaMode = this.name === 'openai' && req.enforceSchema === true;
    let busyRetries = 0;
    for (;;) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: req.prompt },
            ],
            max_tokens: Math.min(req.maxOutputTokens ?? this.maxOutputTokens, this.maxOutputTokens, 4096),
            temperature: 0.2,
            ...(schemaMode ? { response_format: { type: 'json_schema', json_schema: { name: 'campaign_strategy', strict: true, schema: strictOutputSchema(req.jsonSchema) } } } : jsonMode ? { response_format: { type: 'json_object' } } : {}),
          }),
          signal,
        });
      } catch (e) {
        if (signal.aborted) throw new AiCallError(`${this.label()} did not answer within ${Math.round(this.timeoutMs / 1000)} seconds.`, 'timeout', null);
        throw new AiCallError(`${this.label()} could not be reached: ${(e as Error).message}`, 'unavailable', null);
      }
      if (res.ok) {
        const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        const content = body.choices?.[0]?.message?.content ?? '';
        if (!content.trim()) throw new AiCallError(`${this.label()} returned an empty answer.`, 'unavailable', null);
        return { text: extractJson(content), model: this.model, inputTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null };
      }
      const text = await res.text().catch(() => '');
      if ((res.status === 400 || res.status === 422) && jsonMode) {
        if (schemaMode) { schemaMode = false; continue; }
        jsonMode = false; // some models do not support JSON mode; the schema is in the prompt anyway
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && busyRetries < 2 && deadline - Date.now() > 4000) {
        busyRetries++;
        await sleep(1500 * busyRetries);
        continue;
      }
      const keyVar = this.name === 'openai' ? 'OPENAI_API_KEY' : 'NVIDIA_API_KEY';
      const modelVar = this.name === 'openai' ? 'OPENAI_MODEL' : 'NVIDIA_MODEL';
      throw describeHttpError(res.status, text, this.label(), this.model, keyVar, modelVar);
    }
  }
}

/**
 * Main provider with an owner-configured backup provider (Gemini → NVIDIA). The backup is used only
 * when the main one is busy, over quota, unavailable or too slow, and only within the same time budget.
 */
export class ChainProvider implements AiProvider {
  readonly enabled = true;
  constructor(
    private readonly primary: AiProvider,
    private readonly backup: AiProvider,
    private readonly timeoutMs: number
  ) {}
  get name() {
    return this.primary.name;
  }
  get model() {
    return this.primary.model;
  }
  async generateJson(req: AiRequest): Promise<AiResult> {
    const started = Date.now();
    try {
      return await this.primary.generateJson(req);
    } catch (e) {
      const err = e instanceof AiCallError ? e : null;
      const left = this.timeoutMs - (Date.now() - started);
      if (!err || !['busy', 'quota', 'model_unavailable', 'timeout', 'unavailable'].includes(err.kind) || left < 2500 || req.signal?.aborted) throw e;
      const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(left)]) : AbortSignal.timeout(left);
      try {
        return await this.backup.generateJson({ ...req, signal });
      } catch (e2) {
        throw new AiCallError(`${err.message} The backup (${this.backup.name}: ${this.backup.model}) also failed: ${(e2 as Error).message}`, e2 instanceof AiCallError ? e2.kind : 'unavailable', e2 instanceof AiCallError ? e2.providerStatus : null);
      }
    }
  }
}

export function createAiProvider(cfg: AppConfig): AiProvider {
  const openai =
    cfg.OPENAI_API_KEY && cfg.OPENAI_MODEL
      ? new OpenAiCompatibleProvider('openai', cfg.OPENAI_MODEL, cfg.OPENAI_API_KEY, cfg.OPENAI_BASE_URL, cfg.AI_TIMEOUT_MS, cfg.AI_MAX_OUTPUT_TOKENS)
      : null;
  const nvidia =
    cfg.NVIDIA_API_KEY && cfg.NVIDIA_MODEL
      ? new OpenAiCompatibleProvider('nvidia', cfg.NVIDIA_MODEL, cfg.NVIDIA_API_KEY, cfg.NVIDIA_BASE_URL, cfg.AI_TIMEOUT_MS, cfg.AI_MAX_OUTPUT_TOKENS)
      : null;
  if (cfg.AI_PROVIDER === 'gemini') {
    const gemini = new GeminiProvider(cfg.AI_MODEL, cfg.GEMINI_API_KEY, cfg.AI_TIMEOUT_MS, cfg.AI_MAX_OUTPUT_TOKENS, cfg.AI_FALLBACK_MODEL || null, nvidia ? 1 : 3);
    return nvidia ? new ChainProvider(gemini, nvidia, cfg.AI_TIMEOUT_MS) : gemini;
  }
  if (cfg.AI_PROVIDER === 'openai' && openai) return openai;
  if (cfg.AI_PROVIDER === 'nvidia' && nvidia) return nvidia;
  return noneProvider;
}

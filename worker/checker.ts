import { decryptSecret } from './crypto';
import type { CheckOutcome, Env, ErrorType, ModelRow, MonitorStatus, ProviderRow } from './types';

type ModelProvider = ModelRow & ProviderRow & { provider_name?: string };
type SecretBundle = { apiKey?: string; sensitiveHeaders?: Record<string, string> };
const BODY_LIMIT = 256_000;

function asObject(value: string | null | undefined): Record<string, string> {
  try { return JSON.parse(value || '{}') as Record<string, string>; } catch { return {}; }
}

function sanitize(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets) if (secret.length > 2) result = result.replaceAll(secret, '[redacted]');
  return result.slice(0, 4000);
}

function getPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  return path.replaceAll('[', '.').replaceAll(']', '').split('.').filter(Boolean).reduce<unknown>((current, key) => {
    if (current && typeof current === 'object') return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

function extractText(json: unknown, apiType: string, responsePath = ''): string | null {
  if (responsePath) {
    const parsed = getPath(json, responsePath);
    if (typeof parsed === 'string' && parsed.trim()) return parsed;
  }
  if (!json || typeof json !== 'object') return null;
  const root = json as Record<string, unknown>;
  const choices = root.choices as Array<Record<string, unknown>> | undefined;
  const choice = choices?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  if (typeof message?.content === 'string') return message.content;
  if (Array.isArray(message?.content)) {
    const text = (message.content as Array<Record<string, unknown>>).map((part) => typeof part.text === 'string' ? part.text : '').join('');
    if (text) return text;
  }
  if (typeof choice?.text === 'string') return choice.text;
  if (typeof root.output_text === 'string') return root.output_text;
  if (Array.isArray(root.output)) {
    const outputText = (root.output as Array<Record<string, unknown>>).flatMap((item) => Array.isArray(item.content) ? item.content : [])
      .map((part) => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string' ? (part as Record<string, string>).text : '').join('');
    if (outputText) return outputText;
  }
  if (typeof root.content === 'string') return root.content;
  const candidates = root.candidates as Array<Record<string, unknown>> | undefined;
  const parts = (candidates?.[0]?.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined;
  const candidateText = parts?.map((part) => typeof part.text === 'string' ? part.text : '').join('');
  if (candidateText) return candidateText;
  if (apiType === 'anthropic' && Array.isArray(root.content)) {
    const text = (root.content as Array<Record<string, unknown>>).map((part) => typeof part.text === 'string' ? part.text : '').join('');
    if (text) return text;
  }
  return null;
}

function streamText(json: unknown): string {
  if (!json || typeof json !== 'object') return '';
  const root = json as Record<string, unknown>;
  if (typeof root.delta === 'string' && String(root.type ?? '').includes('output_text')) return root.delta;
  const choice = (root.choices as Array<Record<string, unknown>> | undefined)?.[0];
  const delta = choice?.delta as Record<string, unknown> | undefined;
  if (typeof delta?.content === 'string') return delta.content;
  if (typeof choice?.text === 'string') return choice.text;
  const anthropicDelta = root.delta as Record<string, unknown> | undefined;
  if (typeof anthropicDelta?.text === 'string') return anthropicDelta.text;
  const candidates = root.candidates as Array<Record<string, unknown>> | undefined;
  const parts = (candidates?.[0]?.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined;
  return parts?.map((part) => typeof part.text === 'string' ? part.text : '').join('') ?? '';
}

function classifyHttp(status: number): ErrorType {
  if (status === 401 || status === 403) return 'AUTH_ERROR';
  if (status === 404) return 'MODEL_NOT_FOUND';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'SERVER_ERROR';
  if (status === 400 || status === 422) return 'INVALID_REQUEST';
  return 'PROVIDER_ERROR';
}

function errorMessage(body: string, fallback: string): string {
  try {
    const json = JSON.parse(body) as Record<string, unknown>;
    const error = json.error as Record<string, unknown> | string | undefined;
    if (typeof error === 'string') return error;
    if (error && typeof error.message === 'string') return error.message;
    if (typeof json.message === 'string') return json.message;
  } catch { /* use response excerpt */ }
  return body.trim().slice(0, 1000) || fallback;
}

function sanitizedHeaders(headers: Headers, secrets: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers.entries()) {
    if (/authorization|api[-_]?key|token|secret|cookie|set-cookie|password|session|auth/i.test(name)) continue;
    result[name] = sanitize(value, secrets).slice(0, 500);
  }
  return result;
}

async function readResponse(response: Response, streaming: boolean, started: number): Promise<{ text: string; size: number; ttft: number | null; output: string }> {
  if (!response.body) return { text: '', size: 0, ttft: null, output: '' };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  let ttft: number | null = null;
  let buffer = '';
  let output = '';
  try {
    while (size < BODY_LIMIT) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      const chunkText = decoder.decode(part.value, { stream: true });
      text += chunkText;
      if (streaming) {
        buffer += chunkText;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const fragment = streamText(JSON.parse(data) as unknown);
            if (fragment) {
              if (ttft === null) ttft = Math.round(performance.now() - started);
              output += fragment;
            }
          } catch { /* ignore incomplete or non-JSON SSE payloads */ }
        }
      }
    }
  } finally {
    if (size >= BODY_LIMIT) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { text, size, ttft, output };
}

function buildRequest(provider: ModelProvider, model: ModelRow, secrets: SecretBundle): { url: URL; method: string; headers: Headers; body: string | null; streaming: boolean } {
  const type = provider.api_type;
  const format = provider.request_format ?? (type === 'anthropic' ? 'anthropic_messages' : type === 'gemini' ? 'gemini_generate' : 'openai_chat');
  let base = provider.base_url.replace(/\/+$/, '');
  const headers = new Headers(asObject(provider.headers_json));
  for (const [key, value] of Object.entries(secrets.sensitiveHeaders ?? {})) headers.set(key, value);
  let url: URL | null = null;
  let method = 'POST';
  let body: Record<string, unknown> | string | null = null;
  let streaming = false;
  if (type === 'custom') {
    method = (provider.custom_method || 'POST').toUpperCase();
    url = new URL(`${base}${provider.custom_path.startsWith('/') || !provider.custom_path ? '' : '/'}${provider.custom_path}`);
    if (secrets.apiKey && !headers.has('authorization') && !headers.has('x-api-key')) headers.set('Authorization', `Bearer ${secrets.apiKey}`);
    const template = provider.custom_body || JSON.stringify({ model: model.name, messages: [{ role: 'user', content: model.prompt }], max_tokens: model.max_tokens });
    body = method === 'GET' ? null : template.replaceAll('{{model}}', model.name).replaceAll('{{prompt}}', model.prompt).replaceAll('{{max_tokens}}', String(model.max_tokens));
  } else if (format === 'openai_chat') {
    if (!/\/v1$/i.test(new URL(base).pathname)) base += '/v1';
    url = new URL(`${base}/chat/completions`);
    if (secrets.apiKey && !headers.has('authorization')) headers.set('Authorization', `Bearer ${secrets.apiKey}`);
    body = { model: model.name, messages: [{ role: 'user', content: model.prompt }], max_tokens: model.max_tokens, stream: true };
    streaming = true;
  } else if (format === 'openai_responses') {
    if (!/\/v1$/i.test(new URL(base).pathname)) base += '/v1';
    url = new URL(`${base}/responses`);
    if (secrets.apiKey && !headers.has('authorization')) headers.set('Authorization', `Bearer ${secrets.apiKey}`);
    body = { model: model.name, input: model.prompt, max_output_tokens: model.max_tokens, stream: true };
    streaming = true;
  } else if (format === 'anthropic_messages') {
    const basePath = new URL(base).pathname.replace(/\/+$/, '');
    const endpoint = /\/v1$/i.test(basePath) ? '/messages' : '/v1/messages';
    url = new URL(`${base}${endpoint}`);
    if (secrets.apiKey && !headers.has('x-api-key')) headers.set('x-api-key', secrets.apiKey);
    headers.set('anthropic-version', headers.get('anthropic-version') ?? '2023-06-01');
    body = { model: model.name, max_tokens: model.max_tokens, messages: [{ role: 'user', content: model.prompt }], stream: true };
    streaming = true;
  } else if (format === 'gemini_generate') {
    if (!/\/v1beta$/i.test(new URL(base).pathname)) base += '/v1beta';
    url = new URL(`${base}/models/${encodeURIComponent(model.name)}:generateContent`);
    if (secrets.apiKey && !headers.has('x-goog-api-key')) headers.set('x-goog-api-key', secrets.apiKey);
    body = { contents: [{ role: 'user', parts: [{ text: model.prompt }] }], generationConfig: { maxOutputTokens: model.max_tokens, temperature: model.temperature } };
  }
  if (body !== null && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (!url) throw new Error('No request could be built for the selected format.');
  return { url, method, headers, body: typeof body === 'string' ? body : body ? JSON.stringify(body) : null, streaming };
}

function checkResult(status: number, start: number, checkedAt: string, details: Partial<CheckOutcome>): CheckOutcome {
  return {
    available: details.available !== undefined ? details.available : false,
    status: details.status ?? (details.timedOut ? 'TIMEOUT' : status >= 500 ? 'DOWN' : 'ERROR'),
    statusCode: status || null,
    latency: Math.max(0, Math.round(performance.now() - start)),
    ttft: details.ttft ?? null,
    error: details.error ?? null,
    errorType: details.errorType ?? null,
    errorHeaders: details.errorHeaders ?? null,
    errorBody: details.errorBody ?? null,
    responseSize: details.responseSize ?? 0,
    timedOut: details.timedOut ?? false,
    responsePreview: details.responsePreview ?? null,
    checkedAt,
  };
}

export async function performCheck(env: Env, provider: ModelProvider, model: ModelRow): Promise<CheckOutcome> {
  const started = performance.now();
  const checkedAt = new Date().toISOString();
  const apiKeyBundle = await decryptSecret(env, provider.api_key_cipher);
  const headerBundle = await decryptSecret(env, provider.secret_headers_cipher);
  const privateBody = await decryptSecret(env, provider.custom_body_cipher);
  const requestProvider = privateBody ? { ...provider, custom_body: privateBody } : provider;
  const secrets: SecretBundle = {
    ...(apiKeyBundle ? JSON.parse(apiKeyBundle) as SecretBundle : {}),
    ...(headerBundle ? { sensitiveHeaders: { ...(JSON.parse(headerBundle) as Record<string, string>) } } : {}),
  };
  const allSecrets = [secrets.apiKey ?? '', ...Object.values(secrets.sensitiveHeaders ?? {})];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), model.timeout_ms);
  try {
    const request = model.actual_call ? buildRequest(requestProvider, model, secrets) : {
      url: new URL(provider.base_url), method: 'GET', headers: new Headers(asObject(provider.headers_json)), body: null, streaming: false,
    };
    if (!model.actual_call) {
      for (const [key, value] of Object.entries(secrets.sensitiveHeaders ?? {})) request.headers.set(key, value);
      if (secrets.apiKey && !request.headers.has('authorization') && provider.api_type !== 'gemini') request.headers.set('Authorization', `Bearer ${secrets.apiKey}`);
      if (secrets.apiKey && provider.api_type === 'gemini') request.headers.set('x-goog-api-key', secrets.apiKey);
    }
    const response = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body, signal: controller.signal, redirect: 'manual' });
    const expected: number[] = JSON.parse(provider.expected_status_json || '[200]') as number[];
    const validHttp = model.actual_call && provider.api_type === 'custom' ? expected.includes(response.status) : response.status >= 200 && response.status < 300;
    const stream = request.streaming && (response.headers.get('content-type')?.includes('text/event-stream') ?? false);
    const responseContent = await readResponse(response, stream, started);
    const safeBody = sanitize(responseContent.text, allSecrets);
    if (!validHttp) {
      const type = classifyHttp(response.status);
      const message = sanitize(errorMessage(safeBody, `Provider returned HTTP ${response.status}.`), allSecrets);
      return checkResult(response.status, started, checkedAt, {
        status: type === 'TIMEOUT' ? 'TIMEOUT' : 'ERROR', available: false, errorType: type, error: message,
        errorHeaders: sanitizedHeaders(response.headers, allSecrets), errorBody: safeBody, responseSize: responseContent.size,
      });
    }
    if (!model.actual_call) return checkResult(response.status, started, checkedAt, { status: 'UP', available: true, responseSize: responseContent.size });
    let text = responseContent.output;
    if (!stream) {
      try { text = extractText(JSON.parse(responseContent.text) as unknown, provider.api_type, provider.response_path) ?? ''; } catch { text = ''; }
    }
    if (!text.trim()) {
      return checkResult(response.status, started, checkedAt, {
        status: 'UNKNOWN_RESPONSE', available: null, responseSize: responseContent.size,
        responsePreview: safeBody.slice(0, 1000), error: 'HTTP request succeeded, but a text response could not be parsed.',
      });
    }
    const latency = Math.max(0, Math.round(performance.now() - started));
    return { ...checkResult(response.status, started, checkedAt, { status: 'UP', available: true, ttft: stream ? responseContent.ttft : null, responseSize: responseContent.size, responsePreview: sanitize(text, allSecrets).slice(0, 500) }), latency };
  } catch (error) {
    const timedOut = controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError');
    const errorType: ErrorType = timedOut ? 'TIMEOUT' : 'NETWORK_ERROR';
    const message = timedOut ? `Request timed out after ${model.timeout_ms} ms.` : sanitize(error instanceof Error ? error.message : 'Network request failed.', allSecrets);
    return checkResult(0, started, checkedAt, { status: timedOut ? 'TIMEOUT' : 'ERROR', available: false, errorType, error: message, timedOut });
  } finally { clearTimeout(timer); }
}

export function calculateLatencyStatus(latency: number, model: ModelRow, baseline: number | null): MonitorStatus {
  if (latency > model.critical_latency_ms) return 'DOWN';
  if (latency > model.warning_latency_ms) return 'SLOW';
  if (model.floating_enabled && baseline !== null && latency > baseline * (1 + model.floating_percent / 100)) return 'SLOW';
  return 'UP';
}

export function calculateBaseline(samples: number[], method: string): number | null {
  if (!samples.length) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  if (method === 'median') return percentile(sorted, 50);
  if (method === 'p95') return percentile(sorted, 95);
  if (method === 'trimmed_average') {
    const trim = Math.floor(sorted.length * 0.1);
    const trimmed = sorted.slice(trim, Math.max(trim + 1, sorted.length - trim));
    return trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
  }
  return sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
}

function percentile(sorted: number[], percent: number): number {
  const index = Math.max(0, Math.ceil(sorted.length * percent / 100) - 1);
  return sorted[index] ?? 0;
}

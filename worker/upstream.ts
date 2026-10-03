import { decryptSecret } from './crypto';
import type { Env, ProviderRow, RequestFormat } from './types';

export interface UpstreamModel {
  id: string;
  label: string;
  contextLength: number | null;
}

export interface DiscoveryInput {
  requestFormat: RequestFormat;
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string>;
  timeoutMs?: number;
}

const DISCOVERY_TIMEOUT_MS = 12_000;

const formatApiType: Record<RequestFormat, ProviderRow['api_type']> = {
  openai_chat: 'openai', openai_responses: 'openai', anthropic_messages: 'anthropic', gemini_generate: 'gemini',
};

export class DiscoveryError extends Error {
  constructor(public code: string, message: string, public suggestion: string, public status = 502) { super(message); }
}

function withSuffix(base: string, suffix: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return trimmed.toLowerCase().endsWith(suffix.toLowerCase()) ? trimmed : `${trimmed}${suffix}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function dedupe(models: UpstreamModel[]): UpstreamModel[] {
  const seen = new Set<string>();
  const result: UpstreamModel[] = [];
  for (const model of models) {
    const key = model.id.toLowerCase();
    if (!model.id || seen.has(key)) continue;
    seen.add(key);
    result.push(model);
  }
  return result.sort((a, b) => a.id.localeCompare(b.id, 'en', { sensitivity: 'base' }));
}

function classify(status: number): { code: string; message: string; suggestion: string } {
  if (status === 401 || status === 403) return {
    code: 'AUTH_ERROR', message: 'The upstream service rejected the credentials.',
    suggestion: 'Check that the API key is correct and allowed to list models, then try again.',
  };
  if (status === 404) return {
    code: 'MODELS_ENDPOINT_NOT_FOUND', message: 'The upstream service does not expose a model list at this address.',
    suggestion: 'Confirm the base URL is correct for this provider, or add model names manually.',
  };
  if (status === 429) return {
    code: 'RATE_LIMIT', message: 'The upstream service is rate limiting model lookups right now.',
    suggestion: 'Wait a minute and try again, or add model names manually.',
  };
  if (status >= 500) return {
    code: 'UPSTREAM_ERROR', message: 'The upstream service reported a server error while listing models.',
    suggestion: 'Try again shortly. If it keeps failing, add model names manually.',
  };
  return {
    code: 'UPSTREAM_REJECTED', message: 'The upstream service rejected the model list request.',
    suggestion: 'Check the base URL and API key, or add model names manually.',
  };
}

function errorFromResponse(status: number, body: string): DiscoveryError {
  const info = classify(status);
  console.error('upstream model discovery failed', status, body.slice(0, 500));
  return new DiscoveryError(info.code, info.message, info.suggestion, 502);
}

async function fetchJson(url: string, headers: Headers, signal: AbortSignal): Promise<{ status: number; body: unknown; raw: string }> {
  const response = await fetch(url, { method: 'GET', headers, signal, redirect: 'manual' });
  const raw = await response.text();
  let body: unknown;
  try { body = JSON.parse(raw) as unknown; } catch { body = null; }
  return { status: response.status, body, raw: raw.slice(0, 1000) };
}

function parseOpenAiModels(body: unknown): UpstreamModel[] {
  const root = asRecord(body);
  const data = readArray(root?.data);
  return data.map((entry) => {
    const record = asRecord(entry);
    const id = typeof record?.id === 'string' ? record.id.trim() : '';
    return { id, label: id, contextLength: typeof record?.context_length === 'number' ? record.context_length : null };
  }).filter((model) => model.id);
}

function parseAnthropicModels(body: unknown): UpstreamModel[] {
  const root = asRecord(body);
  const data = readArray(root?.data);
  return data.map((entry) => {
    const record = asRecord(entry);
    const id = typeof record?.id === 'string' ? record.id.trim() : '';
    const label = typeof record?.display_name === 'string' && record.display_name.trim() ? record.display_name.trim() : id;
    return { id, label, contextLength: typeof record?.context_window === 'number' ? record.context_window : null };
  }).filter((model) => model.id);
}

function parseGeminiModels(body: unknown): UpstreamModel[] {
  const root = asRecord(body);
  const data = readArray(root?.models);
  const models: UpstreamModel[] = [];
  for (const entry of data) {
    const record = asRecord(entry);
    const rawName = typeof record?.name === 'string' ? record.name.trim() : '';
    const id = rawName.replace(/^models\//, '');
    if (!id) continue;
    const methods = readArray(record?.supportedGenerationMethods).filter((value): value is string => typeof value === 'string');
    if (methods.length && !methods.some((method) => method.toLowerCase() === 'generatecontent')) continue;
    const label = typeof record?.displayName === 'string' && record.displayName.trim() ? record.displayName.trim() : id;
    models.push({ id, label, contextLength: typeof record?.inputTokenLimit === 'number' ? record.inputTokenLimit : null });
  }
  return models;
}

export async function discoverUpstreamModels(input: DiscoveryInput): Promise<UpstreamModel[]> {
  const apiType = formatApiType[input.requestFormat];
  if (!apiType) throw new DiscoveryError('INVALID_FORMAT', 'Choose a supported request format first.', 'Select one of the supported request formats.', 400);
  const headers = new Headers(input.headers);
  const apiKey = input.apiKey?.trim() || '';
  let url: string;
  let parser: (body: unknown) => UpstreamModel[];
  if (apiType === 'anthropic') {
    url = `${withSuffix(input.baseUrl, '/v1')}/models`;
    if (apiKey && !headers.has('x-api-key')) headers.set('x-api-key', apiKey);
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
    parser = parseAnthropicModels;
  } else if (apiType === 'gemini') {
    url = `${withSuffix(input.baseUrl, '/v1beta')}/models`;
    if (apiKey && !headers.has('x-goog-api-key')) headers.set('x-goog-api-key', apiKey);
    parser = parseGeminiModels;
  } else {
    url = `${withSuffix(input.baseUrl, '/v1')}/models`;
    if (apiKey && !headers.has('authorization')) headers.set('Authorization', `Bearer ${apiKey}`);
    parser = parseOpenAiModels;
  }
  headers.set('accept', 'application/json');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? DISCOVERY_TIMEOUT_MS);
  try {
    const { status, body, raw } = await fetchJson(url, headers, controller.signal);
    if (status < 200 || status >= 300) throw errorFromResponse(status, raw);
    return dedupe(parser(body));
  } catch (error) {
    if (error instanceof DiscoveryError) throw error;
    const timedOut = controller.signal.aborted;
    const detail = error instanceof Error ? error.message : 'Unknown network error.';
    console.error('upstream model discovery network error', detail);
    if (timedOut) throw new DiscoveryError('TIMEOUT', 'The upstream service did not respond in time.', 'Check the base URL and network access, then try again.');
    throw new DiscoveryError('NETWORK_ERROR', 'The upstream service could not be reached.', 'Check the base URL, DNS and network access, then try again.');
  } finally {
    clearTimeout(timer);
  }
}

export async function providerDiscoveryInput(env: Env, provider: ProviderRow, apiKeyOverride: string | null): Promise<DiscoveryInput> {
  let storedKey = '';
  if (provider.api_key_cipher) {
    try {
      const bundle = JSON.parse((await decryptSecret(env, provider.api_key_cipher)) ?? '{}') as { apiKey?: string };
      storedKey = bundle.apiKey ?? '';
    } catch { storedKey = ''; }
  }
  const override = apiKeyOverride?.trim() ?? '';
  const headers: Record<string, string> = {};
  try { Object.assign(headers, JSON.parse(provider.headers_json || '{}') as Record<string, string>); } catch { /* ignore malformed header json */ }
  if (provider.secret_headers_cipher) {
    try {
      const hidden = JSON.parse((await decryptSecret(env, provider.secret_headers_cipher)) ?? '{}') as Record<string, string>;
      Object.assign(headers, hidden);
    } catch { /* keep visible headers when secrets cannot be read */ }
  }
  return {
    requestFormat: provider.request_format,
    baseUrl: provider.base_url,
    apiKey: override ? override : storedKey,
    headers,
  };
}

import { constantTimeTextEqual, cookieValue, decryptSecret, encryptSecret, randomId, signSession, verifySession } from './crypto';
import { performCheck } from './checker';
import { getJoinedModel, runModelCheck, testModel } from './monitor';
import { allIncidents, dashboardStats, history, modelIncidents, modelStats } from './stats';
import { DiscoveryError, discoverUpstreamModels, providerDiscoveryInput } from './upstream';
import type { Env, ModelRow, ProviderRow, RequestFormat } from './types';

const DEFAULT_PROMPT = 'Reply with exactly: OK';
const failureChoices = new Set([1, 2, 3, 5, 10]);
const secretHeaderPattern = /authorization|api[-_]?key|token|secret|cookie|password|session|auth/i;
const requestFormats = new Set<RequestFormat>(['openai_chat', 'openai_responses', 'anthropic_messages', 'gemini_generate']);
const formatApiTypes: Record<RequestFormat, ProviderRow['api_type']> = {
  openai_chat: 'openai', openai_responses: 'openai', anthropic_messages: 'anthropic', gemini_generate: 'gemini',
};
type JsonObject = Record<string, unknown>;

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...Object.fromEntries(new Headers(headers).entries()) } });
}

function success(data: unknown, status = 200): Response { return json({ success: true, data }, status); }
function failure(code: string, message: string, status: number): Response { return json({ success: false, error: { code, message } }, status); }

async function bodyJson(request: Request): Promise<JsonObject> {
  try {
    const length = Number(request.headers.get('content-length') ?? '0');
    if (length > 1_000_000) throw new Error('Request body is too large.');
    const value: unknown = await request.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object.');
    return value as JsonObject;
  } catch (error) { throw new ApiError('INVALID_JSON', error instanceof Error ? error.message : 'Invalid JSON body.', 400); }
}

class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

function asString(value: unknown, fallback = ''): string { return typeof value === 'string' ? value.trim() : fallback; }
function asNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function asBoolean(value: unknown, fallback: boolean): boolean { return typeof value === 'boolean' ? value : value === 0 || value === 1 ? value === 1 : fallback; }
function parseObject(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function validateUrl(value: string, label: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError('INVALID_URL', `${label} must be a valid URL.`, 400); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const localHost = ['localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(hostname);
  const octets = hostname.split('.').map(Number);
  const isIpv4 = octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
  const [a = 0, b = 0] = octets;
  const privateV4 = isIpv4 && (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224);
  const blockedName = hostname.endsWith('.local') || hostname.endsWith('.internal') || ['metadata.google.internal', 'metadata', 'instance-data'].includes(hostname);
  const privateV6 = hostname.includes(':') && hostname !== '::1';
  const localDevelopmentUrl = url.protocol === 'http:' && localHost;
  if (!['https:', 'http:'].includes(url.protocol) || (url.protocol === 'http:' && !localHost) || (url.protocol === 'https:' && localHost) ||
    url.username || url.password || url.hash || ((privateV4 || privateV6) && !localDevelopmentUrl) || blockedName) {
    throw new ApiError('INVALID_URL', `${label} must use HTTPS and a public host. Local HTTP is allowed only during development.`, 400);
  }
  if (url.searchParams.has('key') || [...url.searchParams.keys()].some((key) => /api[-_]?key|token|secret|password/i.test(key))) {
    throw new ApiError('INVALID_URL', `${label} must not contain credentials in its query string.`, 400);
  }
  return url;
}

async function readSession(request: Request, env: Env): Promise<Record<string, unknown> | null> {
  const secureCookie = new URL(request.url).protocol === 'https:';
  const token = cookieValue(request, secureCookie ? '__Host-monitor_session' : 'monitor_session');
  return token ? verifySession(env, token) : null;
}

function originAllowed(request: Request, env: Env): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return request.method === 'GET' || request.method === 'HEAD';
  const own = new URL(request.url).origin;
  return origin === own || (Boolean(env.APP_ORIGIN) && origin === env.APP_ORIGIN);
}

function cookieHeader(request: Request, token: string | null, maxAge: number): string {
  const secure = new URL(request.url).protocol === 'https:';
  const name = secure ? '__Host-monitor_session' : 'monitor_session';
  return `${name}=${token ?? ''}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

async function login(request: Request, env: Env): Promise<Response> {
  if (!originAllowed(request, env)) return failure('FORBIDDEN_ORIGIN', 'Request origin is not allowed.', 403);
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || !env.SESSION_SECRET || env.SESSION_SECRET.length < 24) {
    return failure('AUTH_NOT_CONFIGURED', 'Set ADMIN_USERNAME, ADMIN_PASSWORD, and a SESSION_SECRET of at least 24 characters.', 503);
  }
  const clientIp = request.headers.get('CF-Connecting-IP') ?? 'local';
  const ipDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientIp)));
  const ipHash = Array.from(ipDigest.slice(0, 12), (value) => value.toString(16).padStart(2, '0')).join('');
  const rateKey = `login:${ipHash}`;
  const count = Number(await env.CACHE.get(rateKey) ?? '0');
  if (count >= 10) return failure('LOGIN_RATE_LIMITED', 'Too many login attempts. Try again in 15 minutes.', 429);
  const input = await bodyJson(request);
  const user = asString(input.username);
  const pass = typeof input.password === 'string' ? input.password : '';
  const [userOkay, passOkay] = await Promise.all([
    constantTimeTextEqual(user, env.ADMIN_USERNAME), constantTimeTextEqual(pass, env.ADMIN_PASSWORD),
  ]);
  if (!userOkay || !passOkay) {
    await env.CACHE.put(rateKey, String(count + 1), { expirationTtl: 900 });
    return failure('INVALID_CREDENTIALS', 'Username or password is incorrect.', 401);
  }
  await env.CACHE.delete(rateKey);
  const csrf = randomId();
  const token = await signSession(env, { sub: env.ADMIN_USERNAME, csrf, exp: Date.now() + 12 * 60 * 60_000 });
  return json({ success: true, data: { username: env.ADMIN_USERNAME, csrf, expiresIn: 43200 } }, 200, { 'set-cookie': cookieHeader(request, token, 43200) });
}

async function auth(request: Request, env: Env): Promise<{ session: Record<string, unknown> | null; error: Response | null }> {
  const session = await readSession(request, env);
  if (!session) return { session: null, error: failure('UNAUTHORIZED', 'Please sign in to continue.', 401) };
  if (!originAllowed(request, env)) return { session, error: failure('FORBIDDEN_ORIGIN', 'Request origin is not allowed.', 403) };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    if (!request.headers.get('Origin')) return { session, error: failure('FORBIDDEN_ORIGIN', 'Origin header is required.', 403) };
    if (!request.headers.get('X-CSRF-Token') || request.headers.get('X-CSRF-Token') !== session.csrf) return { session, error: failure('CSRF_INVALID', 'Session verification failed. Refresh and retry.', 403) };
  }
  return { session, error: null };
}

function sensitiveHeaders(headers: Record<string, string>): { visible: Record<string, string>; secret: Record<string, string> } {
  const visible: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(value)) throw new ApiError('INVALID_HEADER', 'Header names and values must be valid single-line HTTP header values.', 400);
    (secretHeaderPattern.test(name) ? secret : visible)[name] = value;
  }
  return { visible, secret };
}

function normalizedModel(input: JsonObject, prior?: ModelRow) {
  const interval = asNumber(input.intervalSeconds ?? input.interval_seconds, prior?.interval_seconds ?? 300);
  const timeout = asNumber(input.timeoutMs ?? input.timeout_ms, prior?.timeout_ms ?? 15000);
  const warning = asNumber(input.warningLatencyMs ?? input.warning_latency_ms, prior?.warning_latency_ms ?? 3000);
  const critical = asNumber(input.criticalLatencyMs ?? input.critical_latency_ms, prior?.critical_latency_ms ?? 8000);
  const failureThreshold = asNumber(input.failureThreshold ?? input.failure_threshold, prior?.failure_threshold ?? 3);
  const recoveryThreshold = asNumber(input.recoveryThreshold ?? input.recovery_threshold, prior?.recovery_threshold ?? 2);
  const samples = asNumber(input.baselineSamples ?? input.baseline_samples, prior?.baseline_samples ?? 20);
  const tokens = asNumber(input.maxTokens ?? input.max_tokens, prior?.max_tokens ?? 5);
  const jitter = asNumber(input.jitterSeconds ?? input.jitter_seconds, prior?.jitter_seconds ?? 0);
  const temperature = asNumber(input.temperature, prior?.temperature ?? 0);
  const floatingPercent = asNumber(input.floatingPercent ?? input.floating_percent, prior?.floating_percent ?? 50);
  if (!asString(input.model ?? input.modelName ?? input.name, prior?.name ?? '')) throw new ApiError('INVALID_MODEL', 'Model name is required.', 400);
  if (interval < 60 || interval > 86400 || !Number.isInteger(interval)) throw new ApiError('INVALID_INTERVAL', 'Interval must be an integer from 60 seconds to 24 hours.', 400);
  if (jitter < 0 || jitter > interval / 2) throw new ApiError('INVALID_JITTER', 'Jitter must be between 0 and half the detection interval.', 400);
  if (timeout < 1000 || timeout > 120000) throw new ApiError('INVALID_TIMEOUT', 'Timeout must be between 1000 and 120000 ms.', 400);
  if (warning < 1 || critical <= warning) throw new ApiError('INVALID_LATENCY_THRESHOLDS', 'Critical latency must be greater than the warning threshold.', 400);
  if (!failureChoices.has(failureThreshold) || !failureChoices.has(recoveryThreshold)) throw new ApiError('INVALID_FAILURE_THRESHOLD', 'Failure and recovery thresholds must be 1, 2, 3, 5, or 10.', 400);
  if (samples < 5 || samples > 500 || tokens < 1 || tokens > 4096 || temperature < 0 || temperature > 2 || floatingPercent < 1 || floatingPercent > 1000) {
    throw new ApiError('INVALID_MODEL_CONFIG', 'Model sampling, token, temperature, or floating-threshold values are out of range.', 400);
  }
  const method = asString(input.baselineMethod ?? input.baseline_method, prior?.baseline_method ?? 'trimmed_average');
  if (!['rolling_average', 'trimmed_average', 'median', 'p95'].includes(method)) throw new ApiError('INVALID_BASELINE_METHOD', 'Baseline method is invalid.', 400);
  return {
    name: asString(input.model ?? input.modelName ?? input.name, prior?.name ?? ''),
    enabled: asBoolean(input.enabled, prior ? prior.enabled === 1 : true) ? 1 : 0,
    actual_call: asBoolean(input.actualCall ?? input.actual_call, prior ? prior.actual_call === 1 : true) ? 1 : 0,
    interval_seconds: interval, jitter_seconds: jitter, timeout_ms: timeout,
    prompt: asString(input.prompt, prior?.prompt ?? DEFAULT_PROMPT).slice(0, 4000), max_tokens: tokens, temperature,
    warning_latency_ms: warning, critical_latency_ms: critical,
    floating_enabled: asBoolean(input.floatingEnabled ?? input.floating_enabled, prior ? prior.floating_enabled === 1 : false) ? 1 : 0,
    floating_percent: floatingPercent, baseline_method: method, baseline_samples: samples,
    failure_threshold: failureThreshold, recovery_threshold: recoveryThreshold,
  };
}

async function existingModelForProvider(env: Env, providerId: string): Promise<ModelRow | null> {
  return env.DB.prepare('SELECT * FROM models WHERE provider_id=? ORDER BY created_at,id LIMIT 1').bind(providerId).first<ModelRow>();
}

async function saveProvider(env: Env, input: JsonObject, providerId?: string): Promise<{ id: string }> {
  const priorProvider = providerId ? await env.DB.prepare('SELECT * FROM providers WHERE id=?').bind(providerId).first<ProviderRow>() : null;
  if (providerId && !priorProvider) throw new ApiError('PROVIDER_NOT_FOUND', 'Provider was not found.', 404);
  const name = asString(input.name);
  const suppliedFormat = asString(input.requestFormat ?? input.request_format);
  const legacyType = asString(input.apiType ?? input.api_type, priorProvider?.api_type ?? 'openai') as ProviderRow['api_type'];
  const legacyFormat: RequestFormat = legacyType === 'anthropic' ? 'anthropic_messages' : legacyType === 'gemini' ? 'gemini_generate' : 'openai_chat';
  const requestFormat = (suppliedFormat || priorProvider?.request_format || legacyFormat) as RequestFormat;
  const type = suppliedFormat ? formatApiTypes[requestFormat] : legacyType;
  const baseUrl = asString(input.baseUrl ?? input.base_url);
  if (!name || name.length > 100) throw new ApiError('INVALID_PROVIDER', 'Provider name is required and must be under 100 characters.', 400);
  if (!['openai', 'gemini', 'anthropic', 'custom'].includes(type) || !requestFormats.has(requestFormat)) throw new ApiError('INVALID_API_TYPE', 'Choose a supported AI request format.', 400);
  validateUrl(baseUrl, 'API Base URL');
  const incomingHeaders = input.headers === undefined && priorProvider ? parseObject(priorProvider.headers_json) : parseObject(input.headers);
  const headerSplit = sensitiveHeaders(incomingHeaders);
  const customMethod = asString(input.method ?? input.customMethod ?? input.custom_method, 'POST').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'PATCH'].includes(customMethod)) throw new ApiError('INVALID_METHOD', 'Custom method must be GET, POST, PUT, or PATCH.', 400);
  const customPath = asString(input.path ?? input.customPath ?? input.custom_path).slice(0, 1000);
  if (customPath.includes('://') || customPath.startsWith('//') || customPath.includes('#')) throw new ApiError('INVALID_PATH', 'Custom path must be relative to the provider base URL.', 400);
  const customQuery = new URLSearchParams(customPath.split('?')[1] ?? '');
  if ([...customQuery.keys()].some((key) => /api[-_]?key|token|secret|password|auth/i.test(key))) throw new ApiError('INVALID_PATH', 'Custom path must not contain credentials in its query string.', 400);
  const expectedInput = input.expectedStatus ?? input.expected_status;
  let expected = [200];
  if (Array.isArray(expectedInput)) expected = expectedInput.map(Number).filter((value) => Number.isInteger(value) && value >= 100 && value <= 599);
  else if (typeof expectedInput === 'string') expected = expectedInput.split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value >= 100 && value <= 599);
  if (!expected.length) throw new ApiError('INVALID_EXPECTED_STATUS', 'At least one expected HTTP status is required.', 400);
  const modelPrior = providerId ? await existingModelForProvider(env, providerId) : undefined;
  const modelName = asString(input.model ?? input.modelName);
  const shouldSaveModel = !providerId || Boolean(modelName);
  const defaults = shouldSaveModel && !providerId ? await getSettings(env) : null;
  const model = shouldSaveModel ? normalizedModel({
    failureThreshold: defaults?.defaultFailureThreshold ?? 3,
    recoveryThreshold: defaults?.defaultRecoveryThreshold ?? 2,
    ...input,
  }, providerId ? modelPrior ?? undefined : undefined) : null;
  const now = new Date().toISOString();
  const id = providerId ?? randomId();
  const modelId = modelPrior?.id ?? randomId();
  let priorSecrets: Record<string, string> = {};
  if (priorProvider?.secret_headers_cipher) {
    try { priorSecrets = JSON.parse((await decryptSecret(env, priorProvider.secret_headers_cipher)) ?? '{}') as Record<string, string>; } catch { priorSecrets = {}; }
  }
  const mergedSecrets: Record<string, string> = {};
  for (const [header, value] of Object.entries(headerSplit.secret)) {
    mergedSecrets[header] = value.includes('••') && priorSecrets[header] ? priorSecrets[header] : value;
  }
  const apiKeyInput = asString(input.apiKey ?? input.api_key);
  const apiKey = apiKeyInput && !apiKeyInput.includes('••') ? apiKeyInput : null;
  const apiKeyCipher = apiKey ? await encryptSecret(env, JSON.stringify({ apiKey })) : priorProvider?.api_key_cipher ?? null;
  const secretHeadersCipher = input.headers === undefined && priorProvider ? priorProvider.secret_headers_cipher
    : Object.keys(mergedSecrets).length ? await encryptSecret(env, JSON.stringify(mergedSecrets)) : null;
  const bodyInput = asString(input.body ?? input.customBody ?? input.custom_body).slice(0, 20000);
  const customBodyCipher = bodyInput ? await encryptSecret(env, bodyInput) : priorProvider?.custom_body_cipher ?? null;
  const provider = {
    id, name, api_type: type, request_format: requestFormat, base_url: baseUrl, api_key_cipher: apiKeyCipher, secret_headers_cipher: secretHeadersCipher,
    headers_json: JSON.stringify(headerSplit.visible), custom_method: customMethod, custom_path: customPath,
    custom_body: '', custom_body_cipher: customBodyCipher,
    expected_status_json: JSON.stringify(expected), response_path: asString(input.responsePath ?? input.response_path, priorProvider?.response_path ?? '').slice(0, 300),
  };
  const modelColumns = `name=?,enabled=?,actual_call=?,interval_seconds=?,jitter_seconds=?,timeout_ms=?,prompt=?,max_tokens=?,temperature=?,
    warning_latency_ms=?,critical_latency_ms=?,floating_enabled=?,floating_percent=?,baseline_method=?,baseline_samples=?,failure_threshold=?,recovery_threshold=?,updated_at=?`;
  const modelValues = model ? [model.name, model.enabled, model.actual_call, model.interval_seconds, model.jitter_seconds, model.timeout_ms, model.prompt,
    model.max_tokens, model.temperature, model.warning_latency_ms, model.critical_latency_ms, model.floating_enabled, model.floating_percent,
    model.baseline_method, model.baseline_samples, model.failure_threshold, model.recovery_threshold, now] : [];
  if (priorProvider) {
    const statements = [env.DB.prepare(`UPDATE providers SET name=?,api_type=?,request_format=?,base_url=?,api_key_cipher=?,secret_headers_cipher=?,headers_json=?,custom_method=?,
      custom_path=?,custom_body=?,custom_body_cipher=?,expected_status_json=?,response_path=?,updated_at=? WHERE id=?`)
      .bind(provider.name, provider.api_type, provider.request_format, provider.base_url, provider.api_key_cipher, provider.secret_headers_cipher, provider.headers_json,
        provider.custom_method, provider.custom_path, provider.custom_body, provider.custom_body_cipher, provider.expected_status_json, provider.response_path, now, id)];
    if (model && modelPrior) statements.push(env.DB.prepare(`UPDATE models SET ${modelColumns} WHERE id=?`).bind(...modelValues, modelId));
    if (model && !modelPrior) statements.push(modelInsert(env, id, modelId, model, now));
    await env.DB.batch(statements);
  } else {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO providers (id,name,api_type,request_format,base_url,api_key_cipher,secret_headers_cipher,headers_json,custom_method,custom_path,
        custom_body,custom_body_cipher,expected_status_json,response_path,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(provider.id, provider.name, provider.api_type, provider.request_format, provider.base_url, provider.api_key_cipher, provider.secret_headers_cipher, provider.headers_json,
          provider.custom_method, provider.custom_path, provider.custom_body, provider.custom_body_cipher, provider.expected_status_json, provider.response_path, now, now),
      modelInsert(env, id, modelId, model!, now),
    ]);
  }
  return { id };
}

function modelInsert(env: Env, providerId: string, modelId: string, model: ReturnType<typeof normalizedModel>, now: string): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO models (id,provider_id,name,enabled,actual_call,interval_seconds,jitter_seconds,timeout_ms,prompt,max_tokens,temperature,
    warning_latency_ms,critical_latency_ms,floating_enabled,floating_percent,baseline_method,baseline_samples,failure_threshold,recovery_threshold,
    next_check_at,current_status,raw_status,consecutive_failures,consecutive_successes,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(modelId, providerId, model.name, model.enabled, model.actual_call, model.interval_seconds, model.jitter_seconds, model.timeout_ms, model.prompt,
      model.max_tokens, model.temperature, model.warning_latency_ms, model.critical_latency_ms, model.floating_enabled, model.floating_percent,
      model.baseline_method, model.baseline_samples, model.failure_threshold, model.recovery_threshold, now, 'UNKNOWN', 'UNKNOWN', 0, 0, now, now);
}

async function addProviderModel(env: Env, providerId: string, input: JsonObject): Promise<{ id: string }> {
  const provider = await env.DB.prepare('SELECT id FROM providers WHERE id=?').bind(providerId).first<{ id: string }>();
  if (!provider) throw new ApiError('PROVIDER_NOT_FOUND', 'Provider was not found.', 404);
  const name = asString(input.model ?? input.modelName ?? input.name);
  if (!name || name.length > 200) throw new ApiError('INVALID_MODEL', 'Enter a model name under 200 characters.', 400);
  const duplicate = await env.DB.prepare('SELECT id FROM models WHERE provider_id=? AND name=? COLLATE NOCASE').bind(providerId, name).first();
  if (duplicate) throw new ApiError('MODEL_ALREADY_EXISTS', 'This model is already added to the provider.', 409);
  const settings = await getSettings(env);
  const model = normalizedModel({ failureThreshold: settings.defaultFailureThreshold, recoveryThreshold: settings.defaultRecoveryThreshold, ...input, model: name });
  const id = randomId();
  const now = new Date().toISOString();
  await modelInsert(env, providerId, id, model, now).run();
  return { id };
}

async function addProviderModels(env: Env, providerId: string, input: JsonObject): Promise<{ added: number; skipped: string[]; ids: string[] }> {
  const provider = await env.DB.prepare('SELECT id FROM providers WHERE id=?').bind(providerId).first<{ id: string }>();
  if (!provider) throw new ApiError('PROVIDER_NOT_FOUND', 'Provider was not found.', 404);
  const rawModels = Array.isArray(input.models) ? input.models : [];
  if (!rawModels.length) throw new ApiError('NO_MODELS_SELECTED', 'Select at least one model to add.', 400);
  if (rawModels.length > 200) throw new ApiError('TOO_MANY_MODELS', 'Add up to 200 models at a time.', 400);
  const settings = await getSettings(env);
  const now = new Date().toISOString();
  const existing = await env.DB.prepare('SELECT name FROM models WHERE provider_id=?').bind(providerId).all<{ name: string }>();
  const known = new Set(existing.results.map((row) => row.name.trim().toLowerCase()));
  const statements: D1PreparedStatement[] = [];
  const ids: string[] = [];
  const skipped: string[] = [];
  const invalid: string[] = [];
  for (const entry of rawModels) {
    const item: JsonObject = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as JsonObject : { model: entry };
    const name = asString(item.model ?? item.modelName ?? item.name);
    if (!name) { invalid.push('(empty)'); continue; }
    if (name.length > 200) { invalid.push(name.slice(0, 40)); continue; }
    const key = name.toLowerCase();
    if (known.has(key)) { skipped.push(name); continue; }
    known.add(key);
    const model = normalizedModel({
      failureThreshold: settings.defaultFailureThreshold, recoveryThreshold: settings.defaultRecoveryThreshold,
      ...item, model: name, enabled: item.enabled === undefined ? true : item.enabled,
    });
    const id = randomId();
    ids.push(id);
    statements.push(modelInsert(env, providerId, id, model, now));
  }
  if (invalid.length) throw new ApiError('INVALID_MODEL', `Some model names are not valid: ${invalid.slice(0, 5).join(', ')}.`, 400);
  if (statements.length) await env.DB.batch(statements);
  return { added: ids.length, skipped, ids };
}

function discoveryFormat(input: JsonObject, fallback?: RequestFormat): RequestFormat {
  const supplied = asString(input.requestFormat ?? input.request_format);
  const legacyType = asString(input.apiType ?? input.api_type);
  const legacy = legacyType === 'anthropic' ? 'anthropic_messages' : legacyType === 'gemini' ? 'gemini_generate' : 'openai_chat';
  const format = (supplied || fallback || legacy) as RequestFormat;
  if (!requestFormats.has(format)) throw new ApiError('INVALID_API_TYPE', 'Choose a supported AI request format.', 400);
  return format;
}

async function discoverModels(env: Env, input: JsonObject) {
  const providerId = asString(input.providerId ?? input.provider_id);
  const rawKey = asString(input.apiKey ?? input.api_key);
  const suppliedKey = rawKey && !rawKey.includes('\u2022') ? rawKey : null;
  let config: { requestFormat: RequestFormat; baseUrl: string; apiKey: string | null; headers: Record<string, string> };
  if (providerId) {
    const provider = await env.DB.prepare('SELECT * FROM providers WHERE id=?').bind(providerId).first<ProviderRow>();
    if (!provider) throw new ApiError('PROVIDER_NOT_FOUND', 'Provider was not found.', 404);
    const baseUrl = asString(input.baseUrl ?? input.base_url, provider.base_url);
    validateUrl(baseUrl, 'API Base URL');
    const stored = await providerDiscoveryInput(env, provider, suppliedKey);
    config = {
      requestFormat: discoveryFormat(input, provider.request_format), baseUrl,
      apiKey: suppliedKey ?? stored.apiKey, headers: { ...stored.headers, ...parseObject(input.headers) },
    };
  } else {
    const baseUrl = asString(input.baseUrl ?? input.base_url);
    validateUrl(baseUrl, 'API Base URL');
    config = { requestFormat: discoveryFormat(input), baseUrl, apiKey: suppliedKey, headers: parseObject(input.headers) };
  }
  const models = await discoverUpstreamModels({ requestFormat: config.requestFormat, baseUrl: config.baseUrl, apiKey: config.apiKey, headers: config.headers });
  return { models, count: models.length };
}

async function listProviders(env: Env) {
  const providers = await env.DB.prepare('SELECT * FROM providers ORDER BY name').all<ProviderRow>();
  const result = [];
  for (const provider of providers.results) {
    const models = await env.DB.prepare('SELECT * FROM models WHERE provider_id=? ORDER BY created_at,id').bind(provider.id).all<ModelRow>();
    const apiKeySet = Boolean(provider.api_key_cipher);
    let keyHint = '';
    if (provider.api_key_cipher) {
      try {
        const bundle = JSON.parse((await decryptSecret(env, provider.api_key_cipher)) ?? '{}') as { apiKey?: string };
        keyHint = bundle.apiKey ? `••••${bundle.apiKey.slice(-4)}` : '••••';
      } catch { keyHint = '••••'; }
    }
    const headerValues = parseObject(provider.headers_json);
    if (provider.secret_headers_cipher) {
      try {
        const hidden = JSON.parse((await decryptSecret(env, provider.secret_headers_cipher)) ?? '{}') as Record<string, string>;
        for (const [header, value] of Object.entries(hidden)) headerValues[header] = `••••${value.slice(-4)}`;
      } catch { /* show stored header names only when ciphertext cannot be read */ }
    }
    result.push({ ...provider, api_key_cipher: undefined, secret_headers_cipher: undefined, custom_body_cipher: undefined,
      custom_body: '', customBodySet: Boolean(provider.custom_body_cipher), apiKeySet, keyHint, headers: headerValues,
      models: models.results.map((model) => ({ ...model, provider_name: provider.name, api_type: provider.api_type, request_format: provider.request_format })) });
  }
  return result;
}

function defaultSettings(env: Env) {
  return { retentionDays: Number(env.DEFAULT_RETENTION_DAYS) || 14, aggregateRetentionDays: 180, publicStatus: true, defaultFailureThreshold: 3, defaultRecoveryThreshold: 2 };
}

async function getSettings(env: Env) {
  const result = await env.DB.prepare('SELECT key,value FROM settings').all<{ key: string; value: string }>();
  const values: Record<string, unknown> = { ...defaultSettings(env) };
  for (const row of result.results) values[row.key] = row.value === 'true' ? true : row.value === 'false' ? false : Number.isNaN(Number(row.value)) ? row.value : Number(row.value);
  return values;
}

async function saveSettings(env: Env, input: JsonObject) {
  const prior = await getSettings(env);
  const next = {
    retentionDays: asNumber(input.retentionDays, Number(prior.retentionDays)),
    aggregateRetentionDays: asNumber(input.aggregateRetentionDays, Number(prior.aggregateRetentionDays)),
    publicStatus: asBoolean(input.publicStatus, Boolean(prior.publicStatus)),
    defaultFailureThreshold: asNumber(input.defaultFailureThreshold, Number(prior.defaultFailureThreshold)),
    defaultRecoveryThreshold: asNumber(input.defaultRecoveryThreshold, Number(prior.defaultRecoveryThreshold)),
  };
  if (next.retentionDays < 7 || next.retentionDays > 30 || next.aggregateRetentionDays < 90 || next.aggregateRetentionDays > 180 ||
    !failureChoices.has(next.defaultFailureThreshold) || !failureChoices.has(next.defaultRecoveryThreshold)) {
    throw new ApiError('INVALID_SETTINGS', 'Retention must be 7–30 detailed days, 90–180 aggregate days, and thresholds 1, 2, 3, 5, or 10.', 400);
  }
  const now = new Date().toISOString();
  await env.DB.batch(Object.entries(next).map(([key, value]) => env.DB.prepare(`INSERT INTO settings (key,value,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).bind(key, String(value), now)));
  return next;
}

async function publicStatus(env: Env, authorized: boolean) {
  const settings = await getSettings(env);
  if (!authorized && !settings.publicStatus) throw new ApiError('STATUS_PRIVATE', 'The public status page is disabled.', 404);
  const dashboard = await dashboardStats(env);
  const groups = new Map<string, { provider: string; status: string; models: number; down: number; slow: number }>();
  for (const model of dashboard.models) {
    const item = groups.get(model.provider_name) ?? { provider: model.provider_name, status: 'UP', models: 0, down: 0, slow: 0 };
    item.models++;
    if (!model.enabled) continue;
    if (['DOWN', 'ERROR', 'TIMEOUT'].includes(model.current_status)) { item.down++; item.status = 'DOWN'; }
    else if (model.current_status === 'SLOW') { item.slow++; if (item.status !== 'DOWN') item.status = 'SLOW'; }
    else if (['UNKNOWN', 'UNKNOWN_RESPONSE', 'DEGRADED', 'RECOVERING'].includes(model.current_status) && item.status === 'UP') item.status = 'UNKNOWN';
    groups.set(model.provider_name, item);
  }
  const incidents = await allIncidents(env);
  return { status: [...groups.values()], summary: dashboard.summary, models: dashboard.models.map((model) => ({
    provider: model.provider_name,
    model: model.name,
    status: model.enabled ? model.current_status : 'DISABLED',
    latency: model.last_latency_ms,
    checkedAt: model.last_checked_at,
    enabled: Boolean(model.enabled),
  })), incidents: incidents.slice(0, 50).map((item) => ({
    id: item.id, provider_name: item.provider_name, model_name: item.model_name, status: item.status, started_at: item.started_at,
    resolved_at: item.resolved_at, title: item.title,
  })) };
}

async function saveNotification(env: Env, input: JsonObject, notificationId?: string) {
  const name = asString(input.name);
  const kind = asString(input.kind);
  const events = Array.isArray(input.events) ? input.events.map(String).filter((event) => ['DOWN', 'RECOVERED', 'SLOW', 'HIGH_LATENCY', 'AUTH_ERROR', 'RATE_LIMIT'].includes(event)) : ['DOWN', 'RECOVERED', 'SLOW', 'HIGH_LATENCY', 'AUTH_ERROR', 'RATE_LIMIT'];
  const cooldown = asNumber(input.cooldownMinutes ?? input.cooldown_minutes, 15);
  if (!name || name.length > 100 || !['webhook', 'discord', 'telegram', 'email_webhook'].includes(kind) || cooldown < 5 || cooldown > 1440) {
    throw new ApiError('INVALID_NOTIFICATION', 'Name, supported notification type, and a 5–1440 minute cooldown are required.', 400);
  }
  const existing = notificationId ? await env.DB.prepare('SELECT * FROM notifications WHERE id=?').bind(notificationId).first<{ id: string; config_cipher: string }>() : null;
  if (notificationId && !existing) throw new ApiError('NOTIFICATION_NOT_FOUND', 'Notification was not found.', 404);
  const prior = existing ? JSON.parse((await decryptSecret(env, existing.config_cipher)) ?? '{}') as JsonObject : {};
  const config = { ...prior, ...parseObject(input.config) } as JsonObject;
  for (const key of ['url', 'botToken', 'chatId', 'to', 'subject']) {
    const val = input[key];
    if (typeof val === 'string' && !val.includes('••')) config[key] = val;
  }
  const urlValue = asString(config.url);
  if (kind !== 'telegram') {
    if (!urlValue) throw new ApiError('NOTIFICATION_TARGET_REQUIRED', 'A webhook URL is required.', 400);
    validateUrl(urlValue, 'Webhook URL');
  } else if (!asString(config.botToken) || !asString(config.chatId)) throw new ApiError('NOTIFICATION_TARGET_REQUIRED', 'Telegram bot token and chat ID are required.', 400);
  const id = notificationId ?? randomId();
  const now = new Date().toISOString();
  const cipher = await encryptSecret(env, JSON.stringify(config));
  if (existing) await env.DB.prepare(`UPDATE notifications SET name=?,kind=?,config_cipher=?,events_json=?,cooldown_minutes=?,enabled=?,updated_at=? WHERE id=?`)
    .bind(name, kind, cipher, JSON.stringify(events), cooldown, asBoolean(input.enabled, true) ? 1 : 0, now, id).run();
  else await env.DB.prepare(`INSERT INTO notifications (id,name,kind,config_cipher,events_json,cooldown_minutes,enabled,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`).bind(id, name, kind, cipher, JSON.stringify(events), cooldown, asBoolean(input.enabled, true) ? 1 : 0, now, now).run();
  return { id };
}

async function listNotifications(env: Env) {
  const rows = await env.DB.prepare('SELECT * FROM notifications ORDER BY created_at DESC').all<{
    id: string; name: string; kind: string; config_cipher: string; events_json: string; cooldown_minutes: number; enabled: number; last_sent_at: string | null;
  }>();
  return Promise.all(rows.results.map(async (item) => {
    const configured = await decryptSecret(env, item.config_cipher).then(Boolean).catch(() => true);
    return { ...item, config_cipher: undefined, events: JSON.parse(item.events_json), configured };
  }));
}

async function checkProviderNow(env: Env, input: JsonObject) {
  const name = asString(input.name, 'Connection test');
  const existingProviderId = asString(input.providerId);
  const priorModel = existingProviderId ? await existingModelForProvider(env, existingProviderId) : null;
  const prior = priorModel ? await getJoinedModel(env, priorModel.id) : null;
  if (input.providerId && !prior) throw new ApiError('PROVIDER_NOT_FOUND', 'Provider was not found.', 404);
  const suppliedFormat = asString(input.requestFormat ?? input.request_format);
  const legacyType = asString(input.apiType ?? input.api_type, prior?.api_type ?? '') as ProviderRow['api_type'];
  const format = (suppliedFormat || prior?.request_format || (legacyType === 'anthropic' ? 'anthropic_messages' : legacyType === 'gemini' ? 'gemini_generate' : 'openai_chat')) as RequestFormat;
  const type = suppliedFormat ? formatApiTypes[format] : legacyType;
  const baseUrl = asString(input.baseUrl ?? input.base_url, prior?.base_url ?? '');
  if (!['openai', 'gemini', 'anthropic', 'custom'].includes(type) || !requestFormats.has(format)) throw new ApiError('INVALID_API_TYPE', 'Choose a supported AI request format.', 400);
  validateUrl(baseUrl, 'API Base URL');
  const split = sensitiveHeaders(parseObject(input.headers));
  const oldSecretHeaders = prior?.secret_headers_cipher ? JSON.parse((await decryptSecret(env, prior.secret_headers_cipher)) ?? '{}') as Record<string, string> : {};
  const secretHeaders = Object.fromEntries(Object.entries(split.secret).map(([key, value]) => [key, value.includes('••') && oldSecretHeaders[key] ? oldSecretHeaders[key] : value]));
  const apiKey = asString(input.apiKey ?? input.api_key);
  const apiKeyCipher = apiKey && !apiKey.includes('••') ? await encryptSecret(env, JSON.stringify({ apiKey })) : prior?.api_key_cipher ?? null;
  const bodyInput = asString(input.body);
  const provider: ProviderRow = {
    id: prior?.provider_id ?? randomId(), name, api_type: type, request_format: format, base_url: baseUrl,
    api_key_cipher: apiKeyCipher,
    secret_headers_cipher: Object.keys(secretHeaders).length ? await encryptSecret(env, JSON.stringify(secretHeaders)) : null,
    headers_json: JSON.stringify(split.visible), custom_method: asString(input.method, prior?.custom_method ?? 'POST'), custom_path: asString(input.path, prior?.custom_path ?? ''),
    custom_body: bodyInput, custom_body_cipher: bodyInput ? await encryptSecret(env, bodyInput) : prior?.custom_body_cipher ?? null,
    expected_status_json: JSON.stringify(Array.isArray(input.expectedStatus) ? input.expectedStatus : JSON.parse(prior?.expected_status_json ?? '[200]')),
    response_path: asString(input.responsePath, prior?.response_path ?? ''),
  };
  const modelData = normalizedModel(input, prior ?? undefined);
  const model = { ...prior, id: prior?.id ?? randomId(), provider_id: provider.id, ...modelData } as ModelRow;
  const result = await performCheck(env, { ...provider, provider_name: name, ...model } as ProviderRow & ModelRow & { provider_name: string }, model);
  return { ...result, status: result.status, success: result.available === true, response: result.responsePreview };
}

async function batchModels(env: Env, input: JsonObject) {
  const ids = Array.isArray(input.ids) ? [...new Set(input.ids.filter((id): id is string => typeof id === 'string'))].slice(0, 50) : [];
  const action = asString(input.action);
  if (!ids.length || !['enable', 'disable', 'delete', 'check'].includes(action)) throw new ApiError('INVALID_BATCH', 'Choose up to 50 models and a supported batch action.', 400);
  if (action === 'check') {
    let cursor = 0;
    let checked = 0;
    const worker = async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        if (id) { await runModelCheck(env, id); checked++; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(5, ids.length) }, worker));
    return { action, affected: checked };
  }
  const now = new Date().toISOString();
  const status = action === 'enable' ? 'UNKNOWN' : 'DISABLED';
  const statements: D1PreparedStatement[] = [];
  for (const id of ids) {
    if (action === 'delete') statements.push(env.DB.prepare('DELETE FROM models WHERE id=?').bind(id));
    else {
      statements.push(env.DB.prepare(`UPDATE models SET enabled=?, current_status=?, consecutive_failures=0, consecutive_successes=0,
        next_check_at=?, updated_at=? WHERE id=?`).bind(action === 'enable' ? 1 : 0, status, action === 'enable' ? now : null, now, id));
      if (action === 'disable') statements.push(env.DB.prepare('UPDATE incidents SET resolved_at=?,updated_at=? WHERE model_id=? AND resolved_at IS NULL').bind(now, now, id));
    }
  }
  for (let index = 0; index < statements.length; index += 50) await env.DB.batch(statements.slice(index, index + 50));
  return { action, affected: ids.length };
}

export async function handleApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (request.method === 'OPTIONS') {
    if (!originAllowed(request, env)) return failure('FORBIDDEN_ORIGIN', 'Request origin is not allowed.', 403);
    return new Response(null, { status: 204, headers: { 'access-control-allow-origin': request.headers.get('Origin') ?? '', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type, x-csrf-token' } });
  }
  if (path === '/api/auth/login' && request.method === 'POST') return login(request, env);
  if (path === '/api/auth/logout' && request.method === 'POST') {
    const check = await auth(request, env);
    if (check.error) return check.error;
    return json({ success: true, data: { loggedOut: true } }, 200, { 'set-cookie': cookieHeader(request, null, 0) });
  }
  if (path === '/api/auth/me' && request.method === 'GET') {
    const check = await auth(request, env);
    return check.error ? check.error : success({ username: check.session?.sub, csrf: check.session?.csrf });
  }
  const statusPublic = path === '/api/status' && request.method === 'GET';
  let authorized = false;
  if (!statusPublic) {
    const check = await auth(request, env);
    if (check.error) return check.error;
    authorized = true;
  } else if (await readSession(request, env)) authorized = true;
  try {
    if (statusPublic) return success(await publicStatus(env, authorized));
    if (path === '/api/dashboard' && request.method === 'GET') return success(await dashboardStats(env));
    if (path === '/api/providers' && request.method === 'GET') return success(await listProviders(env));
    if (path === '/api/providers' && request.method === 'POST') return success(await saveProvider(env, await bodyJson(request)), 201);
    if (path === '/api/providers/test' && request.method === 'POST') return success(await checkProviderNow(env, await bodyJson(request)));
    if (path === '/api/providers/discover' && request.method === 'POST') return success(await discoverModels(env, await bodyJson(request)));
    const providerModelsMatch = path.match(/^\/api\/providers\/([^/]+)\/models$/);
    if (providerModelsMatch && request.method === 'POST') return success(await addProviderModel(env, providerModelsMatch[1], await bodyJson(request)), 201);
    const providerModelsBatchMatch = path.match(/^\/api\/providers\/([^/]+)\/models\/batch$/);
    if (providerModelsBatchMatch && request.method === 'POST') return success(await addProviderModels(env, providerModelsBatchMatch[1], await bodyJson(request)), 201);
    const providerMatch = path.match(/^\/api\/providers\/([^/]+)$/);
    if (providerMatch && request.method === 'PUT') return success(await saveProvider(env, await bodyJson(request), providerMatch[1]));
    if (providerMatch && request.method === 'DELETE') {
      const result = await env.DB.prepare('DELETE FROM providers WHERE id=?').bind(providerMatch[1]).run();
      if (!result.meta.changes) throw new ApiError('PROVIDER_NOT_FOUND', 'Provider was not found.', 404);
      return success({ deleted: true });
    }
    if (path === '/api/models' && request.method === 'GET') return success((await dashboardStats(env)).models);
    if (path === '/api/models/batch' && request.method === 'POST') return success(await batchModels(env, await bodyJson(request)));
    const modelMatch = path.match(/^\/api\/models\/([^/]+)(?:\/(check|history|incidents))?$/);
    if (modelMatch) {
      const [, id, action] = modelMatch;
      if (!action && request.method === 'GET') {
        const dashboard = await dashboardStats(env);
        const model = dashboard.models.find((entry) => entry.id === id);
        if (!model) throw new ApiError('MODEL_NOT_FOUND', 'Model was not found.', 404);
        const detail = await env.DB.prepare('SELECT m.*, p.name AS provider_name, p.api_type FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=?').bind(id).first();
        return success({ ...detail, ...model, stats: await modelStats(env, id), incidents: await modelIncidents(env, id), settings: await getSettings(env) });
      }
      if (action === 'check' && request.method === 'POST') {
        const result = await runModelCheck(env, id);
        if (!result) throw new ApiError('MODEL_NOT_FOUND', 'Model was not found.', 404);
        return success({ ...result.outcome, status: result.status, transition: result.transition });
      }
      if (action === 'history' && request.method === 'GET') {
        const exists = await env.DB.prepare('SELECT id FROM models WHERE id=?').bind(id).first();
        if (!exists) throw new ApiError('MODEL_NOT_FOUND', 'Model was not found.', 404);
        const range = url.searchParams.get('range') ?? '24h';
        return success({ range, checks: await history(env, id, range), stats: (await modelStats(env, id)).stats });
      }
      if (action === 'incidents' && request.method === 'GET') return success(await modelIncidents(env, id));
      if (!action && request.method === 'PUT') {
        const input = await bodyJson(request);
        const model = await env.DB.prepare('SELECT * FROM models WHERE id=?').bind(id).first<ModelRow>();
        if (!model) throw new ApiError('MODEL_NOT_FOUND', 'Model was not found.', 404);
        const normalized = normalizedModel(input, model);
        const now = new Date().toISOString();
        const enabledChanged = normalized.enabled !== model.enabled;
        const nextStatus = normalized.enabled ? enabledChanged ? 'UNKNOWN' : model.current_status : 'DISABLED';
        await env.DB.prepare(`UPDATE models SET name=?,enabled=?,actual_call=?,interval_seconds=?,jitter_seconds=?,timeout_ms=?,prompt=?,max_tokens=?,temperature=?,
          warning_latency_ms=?,critical_latency_ms=?,floating_enabled=?,floating_percent=?,baseline_method=?,baseline_samples=?,failure_threshold=?,recovery_threshold=?,
          current_status=?,consecutive_failures=?,consecutive_successes=?,next_check_at=?,updated_at=? WHERE id=?`).bind(normalized.name, normalized.enabled, normalized.actual_call, normalized.interval_seconds,
          normalized.jitter_seconds, normalized.timeout_ms, normalized.prompt, normalized.max_tokens, normalized.temperature, normalized.warning_latency_ms,
          normalized.critical_latency_ms, normalized.floating_enabled, normalized.floating_percent, normalized.baseline_method, normalized.baseline_samples,
          normalized.failure_threshold, normalized.recovery_threshold, nextStatus, enabledChanged ? 0 : model.consecutive_failures,
          enabledChanged ? 0 : model.consecutive_successes, normalized.enabled ? now : null, now, id).run();
        if (!normalized.enabled) await env.DB.prepare('UPDATE incidents SET resolved_at=?,updated_at=? WHERE model_id=? AND resolved_at IS NULL')
          .bind(now, now, id).run();
        return success({ id });
      }
      if (!action && request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM models WHERE id=?').bind(id).run();
        return success({ deleted: true });
      }
    }
    if (path === '/api/incidents' && request.method === 'GET') return success(await allIncidents(env));
    if (path === '/api/settings' && request.method === 'GET') return success(await getSettings(env));
    if (path === '/api/settings' && request.method === 'PUT') return success(await saveSettings(env, await bodyJson(request)));
    if (path === '/api/notifications' && request.method === 'GET') return success(await listNotifications(env));
    if (path === '/api/notifications' && request.method === 'POST') return success(await saveNotification(env, await bodyJson(request)), 201);
    const notificationMatch = path.match(/^\/api\/notifications\/([^/]+)$/);
    if (notificationMatch && request.method === 'PUT') return success(await saveNotification(env, await bodyJson(request), notificationMatch[1]));
    if (notificationMatch && request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM notifications WHERE id=?').bind(notificationMatch[1]).run();
      return success({ deleted: true });
    }
    return failure('NOT_FOUND', 'API endpoint was not found.', 404);
  } catch (error) {
    if (error instanceof ApiError) return failure(error.code, error.message, error.status);
    if (error instanceof DiscoveryError) return json({ success: false, error: { code: error.code, message: error.message, suggestion: error.suggestion } }, error.status);
    const message = error instanceof Error ? error.message.replace(/(?:sk-|key=)[^\s&]+/gi, '[redacted]') : 'Unexpected server error.';
    console.error('api request failed', request.method, path, message);
    return failure('INTERNAL_ERROR', 'The request could not be completed. Check the server configuration and try again.', 500);
  }
}

export function apiRequestPath(request: Request): boolean {
  return new URL(request.url).pathname.startsWith('/api/');
}

export async function testSavedModel(env: Env, id: string) {
  const result = await testModel(env, id);
  return result;
}


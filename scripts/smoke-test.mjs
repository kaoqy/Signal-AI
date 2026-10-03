import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const appOrigin = process.env.MONITOR_URL ?? 'http://127.0.0.1:8787';
const browserOrigin = 'http://localhost:5173';
const apiKey = 'sk-smoke-primary-never-persist-91F3';
const echoedKey = 'sk-smoke-error-never-return-48C2';
const headerKey = 'header-smoke-secret-never-store-17DD';
const passwordHeaderKey = 'password-header-smoke-secret-never-store-25DA';
const customBodyMarker = 'custom-body-smoke-never-store-81AA';
const mockPort = 9911;
let cookie = '';
let csrf = '';
let primaryId = '';
let failingId = '';
let notificationId = '';
let originalSettings = {};

async function devCredentials() {
  const source = await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
  return Object.fromEntries(source.split(/\r?\n/).filter((line) => line.includes('=')).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index), line.slice(index + 1)];
  }));
}

const provider = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ health: 'OK' }));
    return;
  }
  let requestBody = '';
  for await (const chunk of request) requestBody += chunk;
  let model = '';
  try { model = JSON.parse(requestBody).model ?? ''; } catch { /* test the HTTP adapter's error path below */ }
  if (model === 'smoke-auth-error') {
    response.writeHead(401, { 'content-type': 'application/json', 'x-provider-request': 'smoke-safe-header' });
    response.end(JSON.stringify({ error: { message: `Invalid API key ${echoedKey}; access denied` } }));
    return;
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  response.write('data: {"choices":[{"delta":{"content":"O"}}]}\n\n');
  setTimeout(() => {
    response.write('data: {"choices":[{"delta":{"content":"K"}}]}\n\n');
    response.end('data: [DONE]\n\n');
  }, 35);
});

function listen() {
  return new Promise((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(mockPort, '127.0.0.1', resolve);
  });
}

async function request(path, { method = 'GET', body, authorized = true, token = true, origin = browserOrigin } = {}) {
  const headers = { accept: 'application/json' };
  if (origin) headers.origin = origin;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (authorized && cookie) headers.cookie = cookie;
  if (token && csrf && !['GET', 'HEAD', 'OPTIONS'].includes(method)) headers['x-csrf-token'] = csrf;
  const response = await fetch(new URL(path, appOrigin), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  return { response, result };
}

function data(result) {
  assert.equal(result.success, true, result.error?.message ?? 'API request failed');
  return result.data;
}

async function updateSettings(value) {
  return data((await request('/api/settings', { method: 'PUT', body: value })).result);
}

try {
  await listen();
  const credentials = await devCredentials();

  const unauthenticated = await request('/api/auth/me', { authorized: false });
  assert.equal(unauthenticated.response.status, 401, 'management API should require a session');
  const originReject = await request('/api/auth/login', { method: 'POST', authorized: false, token: false, origin: 'https://invalid.example', body: { username: credentials.ADMIN_USERNAME, password: credentials.ADMIN_PASSWORD } });
  assert.equal(originReject.response.status, 403, 'login should reject a cross-site origin');
  const login = await request('/api/auth/login', { method: 'POST', authorized: false, token: false, body: { username: credentials.ADMIN_USERNAME, password: credentials.ADMIN_PASSWORD } });
  assert.equal(login.response.status, 200, login.result.error?.message ?? 'local login failed');
  cookie = (login.response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  csrf = login.result.data.csrf;
  assert.ok(cookie && csrf, 'login should set a session cookie and return its CSRF token');
  const session = data((await request('/api/auth/me')).result);
  assert.equal(session.username, credentials.ADMIN_USERNAME);
  assert.equal(session.csrf, csrf);

  const blockedWrite = await request('/api/providers', { method: 'POST', token: false, body: { name: 'blocked' } });
  assert.equal(blockedWrite.response.status, 403, 'writes should require a CSRF token');
  const blockedCors = await request('/api/providers', { method: 'OPTIONS', authorized: false, token: false, origin: 'https://invalid.example' });
  assert.equal(blockedCors.response.status, 403, 'preflight should reject an untrusted origin');

  const prior = data((await request('/api/settings')).result);
  originalSettings = { ...prior };
  const defaultPublicStatus = await request('/api/status', { authorized: false, token: false, origin: null });
  assert.equal(defaultPublicStatus.response.status, 200, 'the public status page should be enabled by default');
  assert.equal(defaultPublicStatus.result.success, true);
  const create = await request('/api/providers', { method: 'POST', body: {
    name: 'Local smoke provider', apiType: 'openai', baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey,
    model: 'smoke-model', intervalSeconds: 300, timeoutMs: 5000, prompt: 'Reply with exactly: OK',
    maxTokens: 5, failureThreshold: 3, recoveryThreshold: 2, headers: { 'X-API-Key': headerKey, 'X-Password': passwordHeaderKey },
    body: `{"marker":"${customBodyMarker}"}`,
  } });
  assert.equal(create.response.status, 201, create.result.error?.message ?? 'provider create failed');
  primaryId = create.result.data.id;

  let providers = data((await request('/api/providers')).result);
  const first = providers.find((item) => item.id === primaryId);
  assert.ok(first?.model?.id, 'creating a provider should create its first model');
  assert.equal(first.apiKeySet, true);
  assert.ok(!JSON.stringify(first).includes(apiKey), 'provider API response must not expose the API Key');
  assert.ok(!JSON.stringify(first).includes(headerKey), 'provider API response must not expose sensitive header values');
  assert.ok(!JSON.stringify(first).includes(passwordHeaderKey), 'password headers must also be masked');
  assert.equal(first.customBodySet, true);
  const providerModelId = first.model.id;

  const wrangler = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const sql = spawnSync(process.execPath, [wrangler, 'd1', 'execute', 'model-monitor', '--local', '--command',
    `SELECT api_key_cipher, secret_headers_cipher, custom_body_cipher FROM providers WHERE id='${primaryId}'`, '--json'],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 30000 });
  assert.equal(sql.status, 0, sql.stderr || 'Could not inspect local D1 secret storage');
  const secretColumns = JSON.parse(sql.stdout)[0].results[0];
  assert.ok(secretColumns.api_key_cipher.startsWith('v1.') && !secretColumns.api_key_cipher.includes(apiKey), 'API Key should be AES-GCM ciphertext in D1');
  assert.ok(secretColumns.secret_headers_cipher.startsWith('v1.') && !secretColumns.secret_headers_cipher.includes(headerKey), 'sensitive headers should be encrypted in D1');
  assert.ok(!secretColumns.secret_headers_cipher.includes(passwordHeaderKey), 'password header should be encrypted in D1');
  assert.ok(secretColumns.custom_body_cipher.startsWith('v1.') && !secretColumns.custom_body_cipher.includes(customBodyMarker), 'custom request bodies should be encrypted in D1');

  const scheduler = await fetch(new URL('/cdn-cgi/local/scheduled', appOrigin));
  assert.equal(scheduler.status, 200, 'the configured local Cron scheduler should run');

  const test = data((await request('/api/providers/test', { method: 'POST', body: {
    providerId: primaryId, name: first.name, apiType: first.api_type, baseUrl: first.base_url, apiKey: '', model: first.model.name,
    intervalSeconds: first.model.interval_seconds, timeoutMs: first.model.timeout_ms, prompt: first.model.prompt,
    maxTokens: first.model.max_tokens, failureThreshold: first.model.failure_threshold, recoveryThreshold: first.model.recovery_threshold,
    headers: first.headers,
  } })).result);
  assert.equal(test.available, true, test.error ?? 'OpenAI-compatible streaming probe should succeed');
  assert.equal(test.statusCode, 200);
  assert.equal(test.responsePreview, 'OK');
  assert.ok(test.ttft > 0, 'streaming probe should capture TTFT');

  const customGet = data((await request('/api/providers/test', { method: 'POST', body: {
    name: 'GET custom smoke', apiType: 'custom', baseUrl: `http://127.0.0.1:${mockPort}`, method: 'GET', path: '/health',
    expectedStatus: [200], responsePath: 'health', model: 'smoke-get-model', timeoutMs: 5000, maxTokens: 5,
  } })).result);
  assert.equal(customGet.success, true, customGet.error ?? 'Custom GET health request should parse its response');
  assert.equal(customGet.response, 'OK');

  const edited = await request(`/api/providers/${primaryId}`, { method: 'PUT', body: {
    name: 'Updated local smoke provider', apiType: first.api_type, baseUrl: first.base_url, apiKey: '', model: first.model.name,
    intervalSeconds: first.model.interval_seconds, timeoutMs: first.model.timeout_ms, prompt: first.model.prompt,
    maxTokens: first.model.max_tokens, failureThreshold: first.model.failure_threshold, recoveryThreshold: first.model.recovery_threshold,
    headers: first.headers, body: '',
  } });
  assert.equal(edited.response.status, 200, edited.result.error?.message ?? 'provider update failed');
  providers = data((await request('/api/providers')).result);
  assert.equal(providers.find((item) => item.id === primaryId).customBodySet, true, 'an empty replacement should retain the encrypted custom body');

  const check = data((await request(`/api/models/${providerModelId}/check`, { method: 'POST', body: {} })).result);
  assert.equal(check.available, true);
  assert.equal(check.status, 'UP');
  assert.equal(check.statusCode, 200);
  await request(`/api/models/${providerModelId}`, { method: 'PUT', body: { prompt: 'Still OK', intervalSeconds: 300 } });
  const detail = data((await request(`/api/models/${providerModelId}`)).result);
  assert.equal(detail.stats.stats['24h'].requests, 2);
  assert.equal(detail.stats.stats['24h'].uptime, 100);
  assert.equal(detail.stats.stats['1h'].averageTtft > 0, true);
  assert.ok(!JSON.stringify(detail).includes(apiKey), 'model details must not expose provider secrets');
  assert.equal(data((await request(`/api/models/${providerModelId}/history?range=1h`)).result).checks.length, 2);
  assert.equal(data((await request(`/api/models/${providerModelId}/incidents`)).result).length, 0);

  const failing = await request('/api/providers', { method: 'POST', body: {
    name: 'Local auth error smoke', apiType: 'openai', baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: echoedKey,
    model: 'smoke-auth-error', intervalSeconds: 300, timeoutMs: 5000, failureThreshold: 1, recoveryThreshold: 1,
  } });
  assert.equal(failing.response.status, 201, failing.result.error?.message ?? 'second provider create failed');
  failingId = failing.result.data.id;
  const failingModel = data((await request('/api/providers')).result).find((item) => item.id === failingId).model;
  const failedCheck = data((await request(`/api/models/${failingModel.id}/check`, { method: 'POST', body: {} })).result);
  assert.equal(failedCheck.statusCode, 401);
  assert.equal(failedCheck.errorType, 'AUTH_ERROR');
  assert.equal(failedCheck.status, 'DOWN');
  assert.ok(!JSON.stringify(failedCheck).includes(echoedKey), 'provider error responses must redact API Keys');
  const errorHistory = data((await request(`/api/models/${failingModel.id}/history?range=1h`)).result).checks;
  assert.ok(!JSON.stringify(errorHistory).includes(echoedKey), 'stored error detail must redact API Keys');
  assert.equal(data((await request('/api/incidents')).result).length, 1);
  const failingDetail = data((await request(`/api/models/${failingModel.id}`)).result);
  assert.equal(typeof failingDetail.stats.stats['24h'].downtimeMs, 'number');

  await request('/api/models/batch', { method: 'POST', body: { action: 'disable', ids: [failingModel.id] } });
  assert.ok(data((await request('/api/incidents')).result)[0].resolved_at, 'disabling a model should resolve its open incident');
  await request('/api/models/batch', { method: 'POST', body: { action: 'enable', ids: [failingModel.id] } });
  assert.equal(data((await request(`/api/models/${failingModel.id}`)).result).current_status, 'UNKNOWN');
  await request(`/api/models/${failingModel.id}/check`, { method: 'POST', body: {} });
  await request(`/api/models/${failingModel.id}`, { method: 'PUT', body: { enabled: false } });
  assert.equal(data((await request(`/api/models/${failingModel.id}`)).result).current_status, 'DISABLED');
  assert.ok(data((await request('/api/incidents')).result)[0].resolved_at, 'model updates should resolve open incidents when disabling');

  await request('/api/models/batch', { method: 'POST', body: { action: 'disable', ids: [providerModelId] } });
  assert.equal(data((await request(`/api/models/${providerModelId}`)).result).current_status, 'DISABLED');
  await request('/api/models/batch', { method: 'POST', body: { action: 'enable', ids: [providerModelId] } });
  assert.equal(data((await request(`/api/models/${providerModelId}`)).result).current_status, 'UNKNOWN');
  await request(`/api/models/${providerModelId}`, { method: 'PUT', body: { enabled: false } });
  assert.equal(data((await request(`/api/models/${providerModelId}`)).result).current_status, 'DISABLED');
  await request(`/api/models/${providerModelId}`, { method: 'PUT', body: { enabled: true } });
  assert.equal(data((await request(`/api/models/${providerModelId}`)).result).current_status, 'UNKNOWN');

  await updateSettings({ ...prior, publicStatus: true });
  const publicPage = await request('/api/status', { authorized: false, token: false, origin: null });
  assert.equal(publicPage.response.status, 200, publicPage.result.error?.message ?? 'public status page should be available');
  assert.equal(publicPage.result.success, true);
  assert.ok(!JSON.stringify(publicPage.result).includes(apiKey));
  const publicModel = publicPage.result.data.models.find((item) => item.model === 'smoke-model');
  assert.ok(publicModel, 'the anonymous status API should include public model availability');
  assert.deepEqual(Object.keys(publicModel).sort(), ['checkedAt', 'enabled', 'latency', 'model', 'provider', 'status'].sort(), 'public model data should contain only allow-listed fields');
  const notificationCreate = await request('/api/notifications', { method: 'POST', body: { name: 'Smoke notification', kind: 'webhook', url: 'https://alerts.invalid/private-smoke-token', events: ['DOWN'], cooldownMinutes: 15 } });
  assert.equal(notificationCreate.response.status, 201);
  const notificationList = data((await request('/api/notifications')).result);
  assert.equal(notificationList.length, 1);
  notificationId = notificationList[0].id;
  assert.ok(!JSON.stringify(notificationList).includes('private-smoke-token'), 'notification targets must not be returned');
  const notificationEdit = await request(`/api/notifications/${notificationId}`, { method: 'PUT', body: { name: 'Updated smoke notification', kind: 'webhook', events: ['DOWN', 'RECOVERED'], cooldownMinutes: 20 } });
  assert.equal(notificationEdit.response.status, 200, notificationEdit.result.error?.message ?? 'notification update failed');
  assert.equal(data((await request('/api/dashboard')).result).summary.totalModels, 2);

  await request(`/api/notifications/${notificationId}`, { method: 'DELETE' });
  await request(`/api/providers/${primaryId}`, { method: 'DELETE' });
  await request(`/api/providers/${failingId}`, { method: 'DELETE' });
  primaryId = ''; failingId = ''; notificationId = '';
  await updateSettings({ ...prior, publicStatus: originalSettings.publicStatus });
  await request('/api/auth/logout', { method: 'POST', body: {} });
  cookie = '';

  console.log('Smoke verification passed: auth/CSRF, provider CRUD, AES-GCM secret storage, custom GET parsing, streaming TTFT, check history, incident classification, batch actions, public status and notification redaction.');
} finally {
  if (cookie && csrf) {
    for (const id of [notificationId].filter(Boolean)) await request(`/api/notifications/${id}`, { method: 'DELETE' }).catch(() => undefined);
    for (const id of [primaryId, failingId].filter(Boolean)) await request(`/api/providers/${id}`, { method: 'DELETE' }).catch(() => undefined);
    await updateSettings(originalSettings).catch(() => undefined);
    await request('/api/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
  }
  if (provider.listening) await new Promise((resolve) => provider.close(resolve));
}

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const appUrl = process.env.MONITOR_WEB_URL ?? 'http://localhost:5173';
const apiUrl = process.env.MONITOR_API_URL ?? 'http://127.0.0.1:8787';
const browserOrigin = new URL(appUrl).origin;
const profile = await mkdtemp(path.join(tmpdir(), 'signal-ai-visual-'));
const screenshots = path.join(fileURLToPath(new URL('../', import.meta.url)), '.visual-smoke');
await import('node:fs/promises').then(({ mkdir }) => mkdir(screenshots, { recursive: true }));
let edge;
let cookie = '';
let csrf = '';
let priorSettings = {};
let websocket;
let mockProviderId = '';
let mockModelId;
const errorSecret = 'sk-ui-detail-secret-must-not-leak-62C7';
const upstream = createServer((request, response) => {
  request.resume();
  response.writeHead(401, { 'content-type': 'application/json', 'x-provider-request': 'ui-smoke-safe-header' });
  response.end(JSON.stringify({ error: { message: `Invalid API key ${errorSecret}` } }));
});

async function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function api(pathname, { method = 'GET', body } = {}) {
  const headers = { accept: 'application/json', origin: browserOrigin };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
  const response = await fetch(new URL(pathname, apiUrl), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(result.error?.message ?? `${pathname} returned ${response.status}`);
  return { response, data: result.data };
}

class DevTools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.events = new Map();
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result);
      } else {
        for (const listener of this.events.get(message.method) ?? []) listener(message.params);
      }
    });
  }
  command(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`DevTools command timed out: ${method}`)); } }, 10000);
    });
  }
  once(method, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const listeners = this.events.get(method) ?? [];
      const handler = (value) => { this.events.set(method, listeners.filter((item) => item !== handler)); resolve(value); };
      listeners.push(handler);
      this.events.set(method, listeners);
      setTimeout(() => reject(new Error(`DevTools event timed out: ${method}`)), timeout);
    });
  }
  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', { expression: `JSON.stringify((${expression}), (key, value) => typeof value === 'object' && value instanceof Element ? undefined : value)`, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 1200));
    return result.result?.value == null ? result.result?.value : JSON.parse(result.result.value);
  }
}

async function devtoolsPage() {
  const version = await fetch('http://127.0.0.1:9225/json/version').then((response) => response.json());
  const pages = await fetch('http://127.0.0.1:9225/json/list').then((response) => response.json());
  const target = pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl && page.url.startsWith(browserOrigin))
    ?? pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl);
  assert.ok(target, 'Edge did not create a debuggable page');
  websocket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { websocket.addEventListener('open', resolve, { once: true }); websocket.addEventListener('error', reject, { once: true }); });
  const client = new DevTools(websocket);
  return { client, browserVersion: version.Browser };
}

async function navigate(client, route, theme, width, height, language = 'en-US') {
  await client.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await client.evaluate(`localStorage.setItem('monitor-theme', ${JSON.stringify(theme)})`);
  await client.evaluate(`localStorage.setItem('monitor-language', ${JSON.stringify(language)})`);
  const target = new URL(route, appUrl);
  target.searchParams.set('__visual', `${theme}-${Date.now()}`);
  const loaded = client.once('Page.loadEventFired');
  await client.command('Page.navigate', { url: target.href });
  await loaded;
  await wait(900);
  if (route.startsWith('/admin/models/')) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await client.evaluate(`document.querySelectorAll('.history-entry').length > 0`)) break;
      await wait(200);
    }
  }
  const metrics = await client.evaluate(`({ route: location.pathname, theme: document.documentElement.dataset.theme, storedTheme: localStorage.getItem('monitor-theme'), viewport: innerWidth, contentWidth: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, pageTitle: document.querySelector('h1')?.textContent?.trim() || '' })`);
  const shot = await client.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
  const filename = `${route.replaceAll('/', '_') || 'home'}-${width}-${theme}.png`;
  await writeFile(path.join(screenshots, filename), Buffer.from(shot.data, 'base64'));
  assert.equal(metrics.theme, theme, `${route} should render ${theme} mode`);
  assert.ok(metrics.documentWidth <= metrics.contentWidth, `${route} ${width}px ${theme} layout has horizontal overflow`);
  assert.ok(metrics.bodyWidth <= metrics.contentWidth, `${route} body overflows at ${width}px ${theme}`);
  return { ...metrics, screenshot: path.join(screenshots, filename) };
}

try {
  const envSource = await readFile(new URL('../.dev.vars', import.meta.url), 'utf8');
  const env = Object.fromEntries(envSource.split(/\r?\n/).filter((line) => line.includes('=')).map((line) => {
    const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
  }));
  const login = await api('/api/auth/login', { method: 'POST', body: { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD } });
  cookie = (login.response.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  csrf = login.data.csrf;
  priorSettings = (await api('/api/settings')).data;
  await api('/api/settings', { method: 'PUT', body: { ...priorSettings, publicStatus: true } });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const mockPort = upstream.address().port;
  const created = await api('/api/providers', { method: 'POST', body: {
    name: 'UI error detail check', requestFormat: 'openai_chat', baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: errorSecret,
    model: 'ui-error-detail-model', intervalSeconds: 300, timeoutMs: 5000, failureThreshold: 1, recoveryThreshold: 1,
  } });
  mockProviderId = created.data.id;
  const providerList = (await api('/api/providers')).data;
  mockModelId = providerList.find((item) => item.id === mockProviderId).models[0].id;
  const failedCheck = await api(`/api/models/${mockModelId}/check`, { method: 'POST', body: {} });
  assert.equal(failedCheck.data.errorType, 'AUTH_ERROR');
  assert.equal(failedCheck.data.status, 'DOWN');

  edge = spawn(edgePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=9225', `--user-data-dir=${profile}`, new URL('/', appUrl).href], { stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + 15000;
  let connected = false;
  while (Date.now() < deadline) {
    try { await fetch('http://127.0.0.1:9225/json/version'); connected = true; break; } catch { await wait(200); }
  }
  assert.ok(connected, 'Headless Edge did not start');
  const { client, browserVersion } = await devtoolsPage();
  await client.command('Page.enable');
  await client.command('Runtime.enable');
  await client.command('Network.enable');
  const anonymousLoad = client.once('Page.loadEventFired');
  await client.command('Page.navigate', { url: new URL('/', appUrl).href });
  await anonymousLoad;
  await wait(1200);
  const observations = [];
  await wait(900);
  const anonymousHome = await client.evaluate(`({ url: location.href, readyState: document.readyState, loggedOut: !document.querySelector('.login-layout'), hasModelAvailability: document.body.innerText.includes('模型可用性'), bodyText: document.body.innerText.slice(0, 400), html: document.documentElement.outerHTML.slice(0, 1800) })`);
  assert.equal(anonymousHome.loggedOut, true, `the public homepage should not require a login: ${JSON.stringify(anonymousHome)}`);
  assert.equal(anonymousHome.hasModelAvailability, true, `the Chinese homepage should show model availability: ${JSON.stringify(anonymousHome)}`);
  await client.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const chineseHomeMetrics = await client.evaluate(`({ route: location.pathname, theme: document.documentElement.dataset.theme, viewport: innerWidth, contentWidth: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, pageTitle: document.querySelector('h1')?.textContent?.trim() || '' })`);
  const chineseHomeShot = await client.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
  const chineseHomePath = path.join(screenshots, 'public-home-390-zh-CN-dark.png');
  await writeFile(chineseHomePath, Buffer.from(chineseHomeShot.data, 'base64'));
  observations.push({ ...chineseHomeMetrics, screenshot: chineseHomePath });
  await client.command('Network.setCookie', { name: 'monitor_session', value: cookie.split('=')[1], url: appUrl, path: '/', httpOnly: true, sameSite: 'Strict', secure: false });
  observations.push(await navigate(client, '/admin', 'dark', 390, 844, 'zh-CN'));
  assert.ok(await client.evaluate(`document.querySelector('h1')?.textContent?.includes('系统概览')`), 'the Chinese management overview should be localized');
  const mobileRoutes = (process.env.VISUAL_ROUTES ?? '/,/admin,/admin/models,/admin/incidents,/admin/providers,/admin/settings,/status').split(',');
  for (const route of mobileRoutes) {
    for (const theme of ['dark', 'light']) observations.push(await navigate(client, route, theme, 390, 844));
  }
  await navigate(client, '/admin/providers', 'dark', 390, 844);
  await client.evaluate(`Array.from(document.querySelectorAll('button')).find((button) => button.textContent?.includes('Add provider'))?.click()`);
  const editorDeadline = Date.now() + 5000;
  while (Date.now() < editorDeadline && !await client.evaluate(`Boolean(document.querySelector('.provider-editor'))`)) await wait(100);
  assert.ok(await client.evaluate(`Boolean(document.querySelector('.provider-editor'))`), 'provider editor should open on mobile');
  assert.ok(await client.evaluate(`Boolean(document.querySelector('.provider-editor')?.innerText.includes('OpenAI Chat Completions'))`), 'provider editor should expose selectable request formats');
  assert.ok(await client.evaluate(`Boolean(document.querySelector('.provider-editor form'))`), 'provider editor should render its form');
  await client.evaluate(`(() => { const button = Array.from(document.querySelectorAll('.provider-editor button')).find((item) => item.textContent?.includes('Save changes')); if (button) button.click(); return Boolean(button); })()`);
  await wait(700);
  const editorMetrics = await client.evaluate(`({ route: '/providers/editor', theme: document.documentElement.dataset.theme, viewport: innerWidth, contentWidth: document.documentElement.clientWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, pageTitle: 'Provider editor' })`);
  assert.ok(editorMetrics.documentWidth <= editorMetrics.contentWidth && editorMetrics.bodyWidth <= editorMetrics.contentWidth, 'provider editor overflows on mobile');
  const editorShot = await client.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
  const editorPath = path.join(screenshots, 'provider-editor-390-dark.png');
  await writeFile(editorPath, Buffer.from(editorShot.data, 'base64'));
  observations.push({ ...editorMetrics, screenshot: editorPath });
  await client.evaluate(`document.querySelector('.provider-editor [aria-label="Close"]')?.click()`);
  const detailView = await navigate(client, `/admin/models/${mockModelId}`, 'dark', 390, 844);
  const detailEntries = await client.evaluate(`document.querySelectorAll('.history-entry').length`);
  assert.ok(detailEntries > 0, 'model details should show the failed check');
  await client.evaluate(`(document.querySelector('.history-entry')?.setAttribute('open', 'true'), document.querySelector('.history-technical')?.setAttribute('open', 'true'))`);
  const detailContent = await client.evaluate(`document.querySelector('.detail-history')?.innerText ?? ''`);
  assert.match(detailContent, /Authentication failed/i);
  assert.match(detailContent, /Response headers/i);
  assert.match(detailContent, /Response body/i);
  assert.ok(!detailContent.includes(errorSecret), 'the model details UI must not expose the API key echoed by the provider');
  const detailHeight = await client.evaluate(`document.querySelector('.history-detail-grid')?.scrollHeight ?? 0`);
  assert.ok(detailHeight > 0, 'check details disclosure should expand');
  const detailShot = await client.command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true });
  const detailPath = path.join(screenshots, 'model-error-details-390-dark.png');
  await writeFile(detailPath, Buffer.from(detailShot.data, 'base64'));
  observations.push({ ...detailView, detailFields: ['Authentication failed', 'Response headers', 'Response body'], screenshot: detailPath });
  for (const route of ['/admin/models', '/admin/providers', '/admin/settings', '/status', `/admin/models/${mockModelId}`]) {
    observations.push(await navigate(client, route, 'dark', 320, 800));
  }
  for (const route of ['/', '/admin/settings']) observations.push(await navigate(client, route, 'dark', 1440, 960));
  console.log(JSON.stringify({ browserVersion, testedViews: observations.length, viewportWidths: [...new Set(observations.map((item) => item.viewport))], routes: [...new Set(observations.map((item) => item.route))], noHorizontalOverflow: observations.every((item) => item.documentWidth <= item.contentWidth && item.bodyWidth <= item.contentWidth), errorDetailsRedacted: true }, null, 2));
} finally {
  if (csrf && cookie) {
    if (mockProviderId) await api(`/api/providers/${mockProviderId}`, { method: 'DELETE' }).catch(() => undefined);
    await api('/api/settings', { method: 'PUT', body: priorSettings }).catch(() => undefined);
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
  }
  if (upstream.listening) await new Promise((resolve) => upstream.close(resolve));
  websocket?.close();
  if (edge && edge.exitCode === null) {
    const pid = edge.pid;
    if (pid) spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    edge.kill();
    await Promise.race([new Promise((resolve) => edge.once('exit', resolve)), wait(2500)]);
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

import { randomId, decryptSecret } from './crypto';
import { calculateBaseline, calculateLatencyStatus, performCheck } from './checker';
import type { CheckOutcome, Env, ModelRow, MonitorStatus, ProviderRow } from './types';

type Joined = ModelRow & ProviderRow & { provider_name: string };
const outageStates = new Set<MonitorStatus>(['DOWN', 'TIMEOUT', 'ERROR', 'SLOW']);

export async function getJoinedModel(env: Env, modelId: string): Promise<Joined | null> {
  return env.DB.prepare(`SELECT m.*, p.name AS provider_name, p.api_type, p.base_url, p.api_key_cipher,
    p.secret_headers_cipher, p.headers_json, p.custom_method, p.custom_path, p.custom_body, p.custom_body_cipher,
    p.expected_status_json, p.response_path FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.id=?`)
    .bind(modelId).first<Joined>();
}

async function getBaseline(env: Env, model: ModelRow): Promise<number | null> {
  const rows = await env.DB.prepare(`SELECT latency_ms FROM checks WHERE model_id=? AND available=1 AND latency_ms IS NOT NULL
    AND checked_at >= datetime('now', '-7 days') ORDER BY checked_at DESC LIMIT ?`)
    .bind(model.id, model.baseline_samples).all<{ latency_ms: number }>();
  return calculateBaseline(rows.results.map((row) => row.latency_ms), model.baseline_method);
}

function adjustedStatus(outcome: CheckOutcome, model: ModelRow, baseline: number | null): MonitorStatus {
  if (outcome.available === true) return calculateLatencyStatus(outcome.latency, model, baseline);
  if (outcome.status === 'UNKNOWN_RESPONSE') return 'UNKNOWN_RESPONSE';
  return outcome.status;
}

function stateAfterCheck(model: ModelRow, raw: MonitorStatus, outcome: CheckOutcome): { status: MonitorStatus; failures: number; successes: number; available: boolean | null; message: string | null } {
  if (raw === 'UNKNOWN_RESPONSE') return { status: 'UNKNOWN_RESPONSE', failures: model.consecutive_failures, successes: model.consecutive_successes, available: null, message: outcome.error };
  if (raw === 'UP' || raw === 'SLOW') {
    const failures = 0;
    const successes = model.consecutive_successes + 1;
    const wasUnhealthy = ['DOWN', 'TIMEOUT', 'ERROR', 'DEGRADED', 'RECOVERING'].includes(model.current_status);
    const status = wasUnhealthy && successes < model.recovery_threshold ? 'RECOVERING' : raw;
    return { status, failures, successes, available: true, message: outcome.error };
  }
  const failures = model.consecutive_failures + 1;
  const successes = 0;
  const failureMessage = raw === 'DOWN' && outcome.available === true
    ? `Latency exceeded critical threshold (${model.critical_latency_ms} ms).`
    : outcome.error;
  if (failures < model.failure_threshold) {
    const status = ['UP', 'SLOW', 'UNKNOWN', 'UNKNOWN_RESPONSE'].includes(model.current_status) ? 'DEGRADED' : model.current_status;
    return { status, failures, successes, available: false, message: failureMessage };
  }
  return { status: raw === 'TIMEOUT' ? 'TIMEOUT' : 'DOWN', failures, successes, available: false, message: failureMessage };
}

function nextCheckAt(model: ModelRow): string {
  const spread = model.jitter_seconds ? Math.floor((Math.random() * 2 - 1) * model.jitter_seconds) : 0;
  const delay = Math.max(60, model.interval_seconds + spread);
  return new Date(Date.now() + delay * 1000).toISOString();
}

export async function recordCheck(env: Env, joined: Joined, outcome: CheckOutcome): Promise<{ currentStatus: MonitorStatus; previousStatus: MonitorStatus; rawStatus: MonitorStatus; transition: string | null }> {
  const baseline = await getBaseline(env, joined);
  const rawStatus = adjustedStatus(outcome, joined, baseline);
  const state = stateAfterCheck(joined, rawStatus, outcome);
  const now = outcome.checkedAt;
  const incident = await env.DB.prepare('SELECT id, status FROM incidents WHERE model_id=? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .bind(joined.id).first<{ id: string; status: string }>();
  const previousStatus = joined.current_status;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`INSERT INTO checks (id, model_id, checked_at, available, status, status_code, latency_ms, ttft_ms,
      error_type, error_message, error_headers_json, error_body, response_size, timed_out, response_preview)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(randomId(), joined.id, now, state.available === null ? null : state.available ? 1 : 0, rawStatus, outcome.statusCode,
        outcome.latency, outcome.ttft, outcome.errorType, state.message, outcome.errorHeaders ? JSON.stringify(outcome.errorHeaders) : null,
        outcome.errorBody, outcome.responseSize, outcome.timedOut ? 1 : 0, outcome.responsePreview),
    env.DB.prepare(`UPDATE models SET current_status=?, raw_status=?, consecutive_failures=?, consecutive_successes=?,
      last_checked_at=?, last_latency_ms=?, next_check_at=?, updated_at=? WHERE id=?`)
      .bind(state.status, rawStatus, state.failures, state.successes, now, outcome.latency, nextCheckAt(joined), now, joined.id),
  ];
  if (outageStates.has(state.status)) {
    if (!incident) {
      statements.push(env.DB.prepare(`INSERT INTO incidents (id, model_id, status, started_at, resolved_at, title, error_type,
        error_message, status_code, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`)
        .bind(randomId(), joined.id, state.status, now, `${joined.provider_name} / ${joined.name} ${state.status}`, outcome.errorType, state.message, outcome.statusCode, now, now));
    } else {
      statements.push(env.DB.prepare('UPDATE incidents SET status=?, error_type=?, error_message=?, status_code=?, updated_at=? WHERE id=?')
        .bind(state.status, outcome.errorType, state.message, outcome.statusCode, now, incident.id));
    }
  } else if (incident && ['UP', 'RECOVERING', 'UNKNOWN_RESPONSE'].includes(state.status)) {
    if (state.status !== 'RECOVERING') statements.push(env.DB.prepare('UPDATE incidents SET resolved_at=?, updated_at=? WHERE id=?').bind(now, now, incident.id));
  }
  await env.DB.batch(statements);
  let transition: string | null = null;
  if (state.status === 'DOWN' || state.status === 'TIMEOUT' || state.status === 'ERROR') {
    if (state.status !== previousStatus) transition = 'DOWN';
  } else if (state.status === 'SLOW' && previousStatus !== 'SLOW') transition = 'SLOW';
  else if (state.status === 'UP' && ['DOWN', 'TIMEOUT', 'ERROR', 'RECOVERING', 'DEGRADED'].includes(previousStatus)) transition = 'RECOVERED';
  if (transition) await dispatchNotifications(env, joined, transition, outcome, incident?.id ?? `${joined.id}:${transition}:${Math.floor(Date.now() / 60000)}`);
  if (outcome.errorType === 'AUTH_ERROR' || outcome.errorType === 'RATE_LIMIT') {
    await dispatchNotifications(env, joined, outcome.errorType, outcome, incident?.id ?? `${joined.id}:${outcome.errorType}:${Math.floor(Date.now() / 900000)}`);
  }
  return { currentStatus: state.status, previousStatus, rawStatus, transition };
}

type NotificationConfig = { url?: string; botToken?: string; chatId?: string; to?: string; subject?: string };

async function dispatchNotifications(env: Env, model: Joined, event: string, outcome: CheckOutcome, eventKey: string): Promise<void> {
  const notifications = await env.DB.prepare('SELECT * FROM notifications WHERE enabled=1').all<{
    id: string; name: string; kind: string; config_cipher: string; events_json: string; cooldown_minutes: number; last_sent_at: string | null;
  }>();
  for (const notification of notifications.results) {
    const events = JSON.parse(notification.events_json || '[]') as string[];
    const isLatencyEvent = event === 'SLOW' && (events.includes('SLOW') || events.includes('HIGH_LATENCY'));
    if (!isLatencyEvent && !events.includes(event)) continue;
    const cooldownKey = `notify:${notification.id}`;
    const last = await env.CACHE.get(cooldownKey);
    if (last && Date.now() - Number(last) < notification.cooldown_minutes * 60_000) continue;
    const eventType = isLatencyEvent && !events.includes('SLOW') ? 'HIGH_LATENCY' : event;
    const id = randomId();
    const insert = await env.DB.prepare(`INSERT OR IGNORE INTO notification_events (id, notification_id, model_id, event_type, incident_key, sent_at)
      VALUES (?, ?, ?, ?, ?, ?)`).bind(id, notification.id, model.id, eventType, eventKey, new Date().toISOString()).run();
    if (!insert.meta.changes) continue;
    try {
      const raw = await decryptSecret(env, notification.config_cipher);
      const config = JSON.parse(raw ?? '{}') as NotificationConfig;
      await sendNotification(notification.kind, config, { event: eventType, provider: model.provider_name, model: model.name, status: event, latency: outcome.latency, error: outcome.error, checkedAt: outcome.checkedAt });
      await env.CACHE.put(cooldownKey, String(Date.now()), { expirationTtl: notification.cooldown_minutes * 60 });
      await env.DB.prepare('UPDATE notifications SET last_sent_at=?, last_event_key=?, updated_at=? WHERE id=?')
        .bind(new Date().toISOString(), eventKey, new Date().toISOString(), notification.id).run();
    } catch (error) {
      await env.CACHE.put(cooldownKey, String(Date.now()), { expirationTtl: notification.cooldown_minutes * 60 }).catch(() => undefined);
      await env.DB.prepare('DELETE FROM notification_events WHERE id=?').bind(id).run();
      console.error('notification delivery failed', notification.id, error instanceof Error ? error.message : 'unknown');
    }
  }
}

async function sendNotification(kind: string, config: NotificationConfig, data: Record<string, unknown>): Promise<void> {
  let url = config.url;
  let body: Record<string, unknown>;
  if (kind === 'discord') body = { content: `**${String(data.event)}** · ${String(data.provider)} / ${String(data.model)} · ${String(data.status)}${data.error ? ` · ${String(data.error)}` : ''}` };
  else if (kind === 'telegram') {
    if (!config.botToken || !config.chatId) throw new Error('Telegram bot token and chat ID are required.');
    url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
    body = { chat_id: config.chatId, text: `${String(data.event)} · ${String(data.provider)} / ${String(data.model)} · ${String(data.status)}${data.error ? ` · ${String(data.error)}` : ''}` };
  } else body = { text: `${String(data.event)} · ${String(data.provider)} / ${String(data.model)} · ${String(data.status)}`, ...data };
  if (!url) throw new Error('Notification destination URL is required.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new Error(`Destination returned HTTP ${response.status}.`);
  } finally { clearTimeout(timer); }
}

export async function testModel(env: Env, modelId: string): Promise<{ outcome: CheckOutcome; status: MonitorStatus } | null> {
  const joined = await getJoinedModel(env, modelId);
  if (!joined) return null;
  const outcome = await performCheck(env, joined, joined);
  const baseline = await getBaseline(env, joined);
  return { outcome, status: adjustedStatus(outcome, joined, baseline) };
}

export async function runModelCheck(env: Env, modelId: string): Promise<{ outcome: CheckOutcome; status: MonitorStatus; transition: string | null } | null> {
  const joined = await getJoinedModel(env, modelId);
  if (!joined) return null;
  const outcome = await performCheck(env, joined, joined);
  const recorded = await recordCheck(env, joined, outcome);
  return { outcome, status: recorded.currentStatus, transition: recorded.transition };
}

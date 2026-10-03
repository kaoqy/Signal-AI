import type { Env, MonitorStatus } from './types';

export const RANGE_MS: Record<string, number> = {
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '30d': 30 * 24 * 60 * 60_000,
};

function percentile(values: number[], percentileValue: number): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.max(0, Math.ceil(values.length * percentileValue / 100) - 1)] ?? null;
}

type DetailedCheck = {
  available: number | null; latency_ms: number | null; checked_at: string; status: string; status_code: number | null;
  ttft_ms: number | null; error_type: string | null; error_message: string | null; error_headers_json: string | null;
  error_body: string | null; response_size: number; timed_out: number; response_preview: string | null; id: string;
};
type AggregateBucket = {
  model_id: string; bucket_start: string; request_count: number; known_count: number; success_count: number; failure_count: number;
  latency_count: number; average_latency_ms: number | null; median_latency_ms: number | null; p95_latency_ms: number | null; p99_latency_ms: number | null;
  minimum_latency_ms: number | null; maximum_latency_ms: number | null; ttft_count: number; average_ttft_ms: number | null;
};

function rollChecksToHours(rows: DetailedCheck[], modelId: string): AggregateBucket[] {
  const grouped = new Map<string, DetailedCheck[]>();
  for (const row of rows) {
    const bucket = new Date(Math.floor(Date.parse(row.checked_at) / 3_600_000) * 3_600_000).toISOString();
    const list = grouped.get(bucket) ?? [];
    list.push(row);
    grouped.set(bucket, list);
  }
  return [...grouped].map(([bucket_start, checks]) => {
    const latency = checks.map((row) => row.latency_ms).filter((value): value is number => value !== null);
    const ttft = checks.map((row) => row.ttft_ms).filter((value): value is number => value !== null);
    const known = checks.filter((row) => row.available !== null);
    const success_count = known.filter((row) => row.available === 1).length;
    return {
      model_id: modelId, bucket_start, request_count: checks.length, known_count: known.length, success_count,
      failure_count: known.length - success_count, latency_count: latency.length,
      average_latency_ms: latency.length ? latency.reduce((sum, value) => sum + value, 0) / latency.length : null,
      median_latency_ms: percentile([...latency], 50), p95_latency_ms: percentile([...latency], 95), p99_latency_ms: percentile([...latency], 99),
      minimum_latency_ms: latency.length ? Math.min(...latency) : null, maximum_latency_ms: latency.length ? Math.max(...latency) : null,
      ttft_count: ttft.length, average_ttft_ms: ttft.length ? ttft.reduce((sum, value) => sum + value, 0) / ttft.length : null,
    };
  });
}

function aggregate(rows: DetailedCheck[], buckets: AggregateBucket[] = []) {
  const known = rows.filter((row) => row.available !== null).length + buckets.reduce((sum, row) => sum + row.known_count, 0);
  const successes = rows.filter((row) => row.available === 1).length + buckets.reduce((sum, row) => sum + row.success_count, 0);
  const failures = rows.filter((row) => row.available === 0).length + buckets.reduce((sum, row) => sum + row.failure_count, 0);
  const latency = rows.map((row) => row.latency_ms).filter((value): value is number => value !== null);
  const latencyCount = latency.length + buckets.reduce((sum, row) => sum + row.latency_count, 0);
  const latencyTotal = latency.reduce((sum, value) => sum + value, 0) + buckets.reduce((sum, row) => sum + (row.average_latency_ms ?? 0) * row.latency_count, 0);
  const percentileSamples = (key: 'median_latency_ms' | 'p95_latency_ms' | 'p99_latency_ms') => [...latency, ...buckets.map((bucket) => bucket[key]).filter((value): value is number => value !== null)];
  const minimum = [...latency, ...buckets.map((bucket) => bucket.minimum_latency_ms).filter((value): value is number => value !== null)];
  const maximum = [...latency, ...buckets.map((bucket) => bucket.maximum_latency_ms).filter((value): value is number => value !== null)];
  const detailedTtft = rows.map((row) => row.ttft_ms).filter((value): value is number => value !== null);
  const ttftCount = detailedTtft.length + buckets.reduce((sum, row) => sum + row.ttft_count, 0);
  const ttftTotal = detailedTtft.reduce((sum, value) => sum + value, 0) + buckets.reduce((sum, row) => sum + (row.average_ttft_ms ?? 0) * row.ttft_count, 0);
  const requests = rows.length + buckets.reduce((sum, row) => sum + row.request_count, 0);
  return {
    uptime: known ? successes / known * 100 : null,
    requests,
    success: successes,
    failed: failures,
    errorRate: known ? failures / known * 100 : null,
    averageLatency: latencyCount ? latencyTotal / latencyCount : null,
    medianLatency: percentile(percentileSamples('median_latency_ms'), 50),
    p95Latency: buckets.length ? percentile(percentileSamples('p95_latency_ms'), 95) : percentile(latency, 95),
    p99Latency: buckets.length ? percentile(percentileSamples('p99_latency_ms'), 99) : percentile(latency, 99),
    maxLatency: maximum.length ? Math.max(...maximum) : null,
    minLatency: minimum.length ? Math.min(...minimum) : null,
    averageTtft: ttftCount ? ttftTotal / ttftCount : null,
  };
}

export async function modelStats(env: Env, modelId: string) {
  const since = new Date(Date.now() - RANGE_MS['30d']).toISOString();
  const retention = await env.DB.prepare("SELECT value FROM settings WHERE key='retentionDays'").first<{ value: string }>();
  const retentionDays = Math.max(7, Math.min(30, Number(retention?.value) || Number(env.DEFAULT_RETENTION_DAYS) || 14));
  const detailCutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const rows = await env.DB.prepare(`SELECT id, available, latency_ms, checked_at, status, status_code, ttft_ms, error_type,
    error_message, error_headers_json, error_body, response_size, timed_out, response_preview FROM checks
    WHERE model_id=? AND checked_at>=? ORDER BY checked_at ASC LIMIT 50000`).bind(modelId, since).all<DetailedCheck>();
  const bucketRows = await env.DB.prepare(`SELECT * FROM check_aggregates WHERE model_id=? AND bucket_start>=? AND bucket_start<? ORDER BY bucket_start ASC`)
    .bind(modelId, since, detailCutoff).all<AggregateBucket>();
  const incidentRows = await env.DB.prepare(`SELECT status,started_at,resolved_at FROM incidents WHERE model_id=?
    AND status IN ('DOWN','TIMEOUT','ERROR') AND started_at<=? AND (resolved_at IS NULL OR resolved_at>=?) ORDER BY started_at DESC LIMIT 5000`)
    .bind(modelId, new Date().toISOString(), since).all<{ status: string; started_at: string; resolved_at: string | null }>();
  const checks = rows.results;
  const buckets = bucketRows.results;
  const now = Date.now();
  const windowStats = (duration: number) => {
    const lowerBound = now - duration;
    const detailed = checks.filter((check) => Date.parse(check.checked_at) >= lowerBound);
    const compact = buckets.filter((bucket) => Date.parse(bucket.bucket_start) >= lowerBound);
    const stats = compact.length ? aggregate([], [...compact, ...rollChecksToHours(detailed, modelId)]) : aggregate(detailed);
    const downtimeMs = incidentRows.results.reduce((total, incident) => {
      const start = Math.max(lowerBound, Date.parse(incident.started_at));
      const end = Math.min(now, incident.resolved_at ? Date.parse(incident.resolved_at) : now);
      return total + Math.max(0, end - start);
    }, 0);
    return { ...stats, downtimeMs: Math.min(duration, downtimeMs) };
  };
  const stats = {
    '1h': windowStats(RANGE_MS['1h']),
    '6h': windowStats(RANGE_MS['6h']),
    '24h': windowStats(RANGE_MS['24h']),
    '7d': windowStats(RANGE_MS['7d']),
    '30d': windowStats(RANGE_MS['30d']),
  };
  const recent = checks.slice(-2000);
  return {
    stats,
    checks: recent,
  };
}

export async function dashboardStats(env: Env) {
  const models = await env.DB.prepare(`SELECT m.id, m.provider_id, p.name AS provider_name, p.api_type, p.request_format, m.name, m.enabled,
    m.current_status, m.raw_status, m.last_checked_at, m.last_latency_ms, m.consecutive_failures, m.consecutive_successes,
    m.warning_latency_ms, m.critical_latency_ms FROM models m JOIN providers p ON p.id=m.provider_id ORDER BY p.name, m.name`).all<{
      id: string; provider_id: string; provider_name: string; api_type: string; request_format: string; name: string; enabled: number;
      current_status: MonitorStatus; raw_status: MonitorStatus; last_checked_at: string | null; last_latency_ms: number | null;
      consecutive_failures: number; consecutive_successes: number; warning_latency_ms: number; critical_latency_ms: number;
    }>();
  const since = new Date(Date.now() - RANGE_MS['24h']).toISOString();
  const checks = await env.DB.prepare(`SELECT COUNT(*) AS requests, SUM(CASE WHEN available IS NOT NULL THEN 1 ELSE 0 END) AS known,
    SUM(CASE WHEN available=1 THEN 1 ELSE 0 END) AS successes, SUM(CASE WHEN available=0 THEN 1 ELSE 0 END) AS failures,
    AVG(latency_ms) AS average_latency FROM checks WHERE checked_at>=?`).bind(since).first<{
      requests: number; known: number | null; successes: number | null; failures: number | null; average_latency: number | null;
    }>();
  const known = checks?.known ?? 0;
  const success = checks?.successes ?? 0;
  const statusCounts: Record<string, number> = {};
  for (const model of models.results) statusCounts[model.enabled ? model.current_status : 'DISABLED'] = (statusCounts[model.enabled ? model.current_status : 'DISABLED'] ?? 0) + 1;
  const active = models.results.filter((model) => model.enabled);
  const operational = active.filter((model) => model.current_status === 'UP' || model.current_status === 'SLOW').length;
  return {
    models: models.results,
    summary: {
      totalModels: models.results.length,
      up: statusCounts.UP ?? 0,
      slow: statusCounts.SLOW ?? 0,
      down: (statusCounts.DOWN ?? 0) + (statusCounts.TIMEOUT ?? 0),
      error: statusCounts.ERROR ?? 0,
      unknown: (statusCounts.UNKNOWN ?? 0) + (statusCounts.UNKNOWN_RESPONSE ?? 0) + (statusCounts.DEGRADED ?? 0) + (statusCounts.RECOVERING ?? 0),
      disabled: statusCounts.DISABLED ?? 0,
      averageLatency: checks?.average_latency ?? null,
      uptime24h: known ? success / known * 100 : null,
      operationalPercent: active.length ? operational / active.length * 100 : null,
      requests24h: checks?.requests ?? 0,
      successful24h: success,
      failed24h: checks?.failures ?? 0,
    },
  };
}

export async function modelIncidents(env: Env, modelId: string) {
  const result = await env.DB.prepare('SELECT * FROM incidents WHERE model_id=? ORDER BY started_at DESC LIMIT 200').bind(modelId).all();
  return result.results;
}

export async function allIncidents(env: Env) {
  const result = await env.DB.prepare(`SELECT i.*, m.name AS model_name, p.name AS provider_name FROM incidents i
    JOIN models m ON m.id=i.model_id JOIN providers p ON p.id=m.provider_id ORDER BY i.started_at DESC LIMIT 500`).all();
  return result.results;
}

export async function history(env: Env, modelId: string, range: string) {
  const duration = RANGE_MS[range] ?? RANGE_MS['24h'];
  const since = new Date(Date.now() - duration).toISOString();
  const retention = await env.DB.prepare("SELECT value FROM settings WHERE key='retentionDays'").first<{ value: string }>();
  const retentionDays = Math.max(7, Math.min(30, Number(retention?.value) || Number(env.DEFAULT_RETENTION_DAYS) || 14));
  const detailCutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const result = await env.DB.prepare(`SELECT id, checked_at, available, status, status_code, latency_ms, ttft_ms, error_type,
    error_message, error_headers_json, error_body, response_size, timed_out, response_preview FROM checks
    WHERE model_id=? AND checked_at>=? ORDER BY checked_at ASC LIMIT 50000`).bind(modelId, since).all<DetailedCheck>();
  const oldStart = Date.parse(since) < Date.parse(detailCutoff) ? since : detailCutoff;
  const aggregates = Date.parse(since) < Date.parse(detailCutoff) ? await env.DB.prepare(`SELECT * FROM check_aggregates WHERE model_id=? AND bucket_start>=? AND bucket_start<? ORDER BY bucket_start ASC`)
    .bind(modelId, oldStart, detailCutoff).all<AggregateBucket>() : { results: [] as AggregateBucket[] };
  const compact = aggregates.results.map((bucket) => ({
    id: `hour-${bucket.bucket_start}`, checked_at: bucket.bucket_start,
    available: bucket.failure_count === 0 && bucket.known_count > 0 ? 1 : bucket.success_count === 0 ? 0 : null,
    status: bucket.failure_count ? 'DEGRADED' : 'UP', status_code: null,
    latency_ms: bucket.average_latency_ms === null ? null : Math.round(bucket.average_latency_ms), ttft_ms: bucket.average_ttft_ms === null ? null : Math.round(bucket.average_ttft_ms),
    error_type: 'HOURLY_AGGREGATE', error_message: null, error_headers_json: null, error_body: null, response_size: 0, timed_out: 0,
    response_preview: `${bucket.request_count} checks · hourly average`,
  }));
  const all = [...compact, ...result.results].sort((a, b) => a.checked_at.localeCompare(b.checked_at));
  if (all.length <= 5000) return all;
  const stride = Math.ceil(all.length / 4900);
  const sampled = all.filter((_, index) => index % stride === 0);
  const recent = all.slice(-20);
  const byId = new Map([...sampled, ...recent].map((item) => [item.id, item]));
  return [...byId.values()].sort((a, b) => a.checked_at.localeCompare(b.checked_at));
}

import { runModelCheck } from './monitor';
import type { Env } from './types';

function percentile(values: number[], rate: number): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return values[Math.max(0, Math.ceil(values.length * rate / 100) - 1)] ?? null;
}

async function aggregateRetention(env: Env): Promise<number> {
  const settings = await env.DB.prepare("SELECT key, value FROM settings WHERE key IN ('retentionDays','aggregateRetentionDays')").all<{ key: string; value: string }>();
  const values = Object.fromEntries(settings.results.map((row) => [row.key, Number(row.value)]));
  const detailDays = Math.max(7, Math.min(30, values.retentionDays || Number(env.DEFAULT_RETENTION_DAYS) || 14));
  const aggregateDays = Math.max(90, Math.min(180, values.aggregateRetentionDays || 180));
  const cutoff = Date.now() - detailDays * 86_400_000;
  const aggregateCutoff = new Date(Date.now() - aggregateDays * 86_400_000).toISOString();
  await env.DB.prepare('DELETE FROM checks WHERE checked_at<?').bind(aggregateCutoff).run();
  const oldest = await env.DB.prepare("SELECT MIN(checked_at) AS oldest FROM checks WHERE checked_at>=? AND checked_at < ?")
    .bind(aggregateCutoff, new Date(cutoff).toISOString()).first<{ oldest: string | null }>();
  if (oldest?.oldest) {
    const cursorKey = 'retention:aggregate_cursor';
    const saved = await env.CACHE.get(cursorKey);
    let cursor = saved ? new Date(saved).getTime() : new Date(oldest.oldest).getTime();
    cursor = Math.max(Math.floor(Date.parse(aggregateCutoff) / 3_600_000) * 3_600_000, Math.min(cursor, new Date(oldest.oldest).getTime()));
    cursor = Math.floor(cursor / 3_600_000) * 3_600_000;
    const limit = Math.min(cutoff, cursor + 12 * 3_600_000);
    if (limit > cursor) {
      const from = new Date(cursor).toISOString();
      const to = new Date(limit).toISOString();
      const rows = await env.DB.prepare(`SELECT id, model_id, checked_at, available, latency_ms, ttft_ms FROM checks
        WHERE checked_at>=? AND checked_at<? ORDER BY checked_at LIMIT 100000`).bind(from, to).all<{
          id: string; model_id: string; checked_at: string; available: number | null; latency_ms: number | null; ttft_ms: number | null;
        }>();
      const buckets = new Map<string, typeof rows.results>();
      for (const row of rows.results) {
        const bucket = `${row.model_id}|${new Date(Math.floor(Date.parse(row.checked_at) / 3_600_000) * 3_600_000).toISOString()}`;
        const list = buckets.get(bucket) ?? [];
        list.push(row);
        buckets.set(bucket, list);
      }
      const statements: D1PreparedStatement[] = [];
      for (const [key, list] of buckets) {
        const [modelId, bucket] = key.split('|');
        const latency = list.map((row) => row.latency_ms).filter((value): value is number => value !== null);
        const ttft = list.map((row) => row.ttft_ms).filter((value): value is number => value !== null);
        const known = list.filter((row) => row.available !== null);
        const success = known.filter((row) => row.available === 1).length;
        statements.push(env.DB.prepare(`INSERT OR REPLACE INTO check_aggregates (model_id,bucket_start,request_count,known_count,success_count,
          failure_count,latency_count,average_latency_ms,median_latency_ms,p95_latency_ms,p99_latency_ms,minimum_latency_ms,maximum_latency_ms,ttft_count,average_ttft_ms)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(modelId, bucket, list.length, known.length, success, known.length - success, latency.length,
          latency.length ? latency.reduce((sum, value) => sum + value, 0) / latency.length : null, percentile([...latency], 50),
          percentile([...latency], 95), percentile([...latency], 99), latency.length ? Math.min(...latency) : null,
          latency.length ? Math.max(...latency) : null, ttft.length, ttft.length ? ttft.reduce((sum, value) => sum + value, 0) / ttft.length : null));
      }
      for (let index = 0; index < statements.length; index += 50) await env.DB.batch(statements.slice(index, index + 50));
      await env.DB.prepare('DELETE FROM checks WHERE checked_at>=? AND checked_at<?').bind(from, to).run();
      await env.CACHE.put(cursorKey, new Date(limit).toISOString(), { expirationTtl: 180 * 24 * 60 * 60 });
    }
  }
  await env.DB.prepare('DELETE FROM check_aggregates WHERE bucket_start<?').bind(aggregateCutoff).run();
  return detailDays;
}

export async function scheduled(event: ScheduledController, env: Env): Promise<void> {
  const maxChecks = Math.max(1, Math.min(200, Number(env.MAX_CHECKS_PER_CRON) || 50));
  const concurrency = Math.max(1, Math.min(20, Number(env.CHECK_CONCURRENCY) || 5));
  const due = await env.DB.prepare(`SELECT id FROM models WHERE enabled=1 AND (next_check_at IS NULL OR next_check_at<=?)
    ORDER BY COALESCE(next_check_at, created_at) ASC LIMIT ?`).bind(new Date().toISOString(), maxChecks).all<{ id: string }>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < due.results.length) {
      const model = due.results[cursor++];
      if (!model) return;
      try { await runModelCheck(env, model.id); }
      catch (error) {
        const safe = error instanceof Error ? error.message.replace(/(?:sk-|key=)[^\s&]+/gi, '[redacted]') : 'unknown error';
        console.error('scheduled model check failed', model.id, safe);
        const fallback = await env.DB.prepare('SELECT interval_seconds FROM models WHERE id=?').bind(model.id).first<{ interval_seconds: number }>();
        if (fallback) await env.DB.prepare('UPDATE models SET next_check_at=?, updated_at=? WHERE id=?').bind(
          new Date(Date.now() + Math.max(60, fallback.interval_seconds) * 1000).toISOString(), new Date().toISOString(), model.id).run();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.results.length) }, worker));
  try { await aggregateRetention(env); }
  catch (error) { console.error('history retention job failed', error instanceof Error ? error.message : 'unknown error'); }
  void event;
}

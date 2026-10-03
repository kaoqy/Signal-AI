export type ApiType = 'openai' | 'gemini' | 'anthropic' | 'custom';
export type MonitorStatus = 'UP' | 'SLOW' | 'DOWN' | 'TIMEOUT' | 'ERROR' | 'DISABLED' | 'UNKNOWN' | 'UNKNOWN_RESPONSE' | 'DEGRADED' | 'RECOVERING';
export type ErrorType = 'AUTH_ERROR' | 'RATE_LIMIT' | 'TIMEOUT' | 'NETWORK_ERROR' | 'SERVER_ERROR' | 'MODEL_NOT_FOUND' | 'INVALID_REQUEST' | 'PROVIDER_ERROR' | 'UNKNOWN_ERROR';

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  ENCRYPTION_KEY?: string;
  APP_ORIGIN?: string;
  MAX_CHECKS_PER_CRON?: string;
  CHECK_CONCURRENCY?: string;
  DEFAULT_RETENTION_DAYS?: string;
}

export interface ProviderRow {
  id: string;
  name: string;
  api_type: ApiType;
  base_url: string;
  api_key_cipher: string | null;
  secret_headers_cipher: string | null;
  headers_json: string;
  custom_method: string;
  custom_path: string;
  custom_body: string;
  custom_body_cipher?: string | null;
  expected_status_json: string;
  response_path: string;
}

export interface ModelRow {
  id: string;
  provider_id: string;
  name: string;
  enabled: number;
  actual_call: number;
  interval_seconds: number;
  jitter_seconds: number;
  timeout_ms: number;
  prompt: string;
  max_tokens: number;
  temperature: number;
  warning_latency_ms: number;
  critical_latency_ms: number;
  floating_enabled: number;
  floating_percent: number;
  baseline_method: string;
  baseline_samples: number;
  failure_threshold: number;
  recovery_threshold: number;
  next_check_at: string | null;
  current_status: MonitorStatus;
  raw_status: MonitorStatus;
  consecutive_failures: number;
  consecutive_successes: number;
  last_checked_at: string | null;
  last_latency_ms: number | null;
  provider_name?: string;
  api_type?: ApiType;
  base_url?: string;
  api_key_cipher?: string | null;
  secret_headers_cipher?: string | null;
  headers_json?: string;
  custom_method?: string;
  custom_path?: string;
  custom_body?: string;
  expected_status_json?: string;
  response_path?: string;
}

export interface CheckOutcome {
  available: boolean | null;
  status: MonitorStatus;
  statusCode: number | null;
  latency: number;
  ttft: number | null;
  error: string | null;
  errorType: ErrorType | null;
  errorHeaders: Record<string, string> | null;
  errorBody: string | null;
  responseSize: number;
  timedOut: boolean;
  responsePreview: string | null;
  checkedAt: string;
}

export interface ModelSummary extends Record<string, unknown> {
  id: string;
  provider_id: string;
  provider_name: string;
  api_type: ApiType;
  name: string;
  enabled: number;
  current_status: MonitorStatus;
  raw_status: MonitorStatus;
  last_checked_at: string | null;
  last_latency_ms: number | null;
  consecutive_failures: number;
  consecutive_successes: number;
}

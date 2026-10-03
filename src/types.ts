export type Status = 'UP' | 'SLOW' | 'DOWN' | 'TIMEOUT' | 'ERROR' | 'DISABLED' | 'UNKNOWN' | 'UNKNOWN_RESPONSE' | 'DEGRADED' | 'RECOVERING';
export type ApiType = 'openai' | 'gemini' | 'anthropic' | 'custom';
export type RequestFormat = 'openai_chat' | 'openai_responses' | 'anthropic_messages' | 'gemini_generate';

export interface Model {
  id: string;
  provider_id: string;
  provider_name: string;
  api_type: ApiType;
  request_format: RequestFormat;
  name: string;
  enabled: number;
  current_status: Status;
  raw_status: Status;
  last_checked_at: string | null;
  last_latency_ms: number | null;
  consecutive_failures: number;
  consecutive_successes: number;
  warning_latency_ms: number;
  critical_latency_ms: number;
  interval_seconds: number;
  jitter_seconds: number;
  timeout_ms: number;
  floating_enabled: number;
  floating_percent: number;
  uptime?: number | null;
}

export interface Provider {
  id: string;
  name: string;
  api_type: ApiType;
  request_format: RequestFormat;
  base_url: string;
  keyHint: string;
  apiKeySet: boolean;
  headers: Record<string, string>;
  custom_method: string;
  custom_path: string;
  custom_body: string;
  customBodySet?: boolean;
  expected_status_json: string;
  response_path: string;
  models: Model[];
}

export interface Check {
  id: string;
  checked_at: string;
  available: number | null;
  status: Status;
  status_code: number | null;
  latency_ms: number | null;
  ttft_ms: number | null;
  error_type: string | null;
  error_message: string | null;
  error_headers_json: string | null;
  error_body: string | null;
  response_size: number;
  timed_out: number;
  response_preview: string | null;
}

export interface Incident {
  id: string;
  model_id: string;
  model_name: string;
  provider_name: string;
  status: Status;
  started_at: string;
  resolved_at: string | null;
  title: string;
  error_type: string | null;
  error_message: string | null;
  status_code: number | null;
}

export interface Summary {
  totalModels: number;
  up: number;
  slow: number;
  down: number;
  error: number;
  unknown: number;
  disabled: number;
  averageLatency: number | null;
  uptime24h: number | null;
  operationalPercent: number | null;
  requests24h: number;
  successful24h: number;
  failed24h: number;
}

export interface ApiResult<T> { success: boolean; data?: T; error?: { code: string; message: string } }

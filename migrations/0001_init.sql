PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_type TEXT NOT NULL CHECK (api_type IN ('openai', 'gemini', 'anthropic', 'custom')),
  base_url TEXT NOT NULL,
  api_key_cipher TEXT,
  secret_headers_cipher TEXT,
  headers_json TEXT NOT NULL DEFAULT '{}',
  custom_method TEXT NOT NULL DEFAULT 'POST',
  custom_path TEXT NOT NULL DEFAULT '',
  custom_body TEXT NOT NULL DEFAULT '',
  custom_body_cipher TEXT,
  expected_status_json TEXT NOT NULL DEFAULT '[200]',
  response_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  actual_call INTEGER NOT NULL DEFAULT 1 CHECK (actual_call IN (0, 1)),
  interval_seconds INTEGER NOT NULL DEFAULT 300 CHECK (interval_seconds >= 60),
  jitter_seconds INTEGER NOT NULL DEFAULT 0 CHECK (jitter_seconds >= 0),
  timeout_ms INTEGER NOT NULL DEFAULT 15000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
  prompt TEXT NOT NULL DEFAULT 'Reply with exactly: OK',
  max_tokens INTEGER NOT NULL DEFAULT 5 CHECK (max_tokens BETWEEN 1 AND 4096),
  temperature REAL NOT NULL DEFAULT 0,
  warning_latency_ms INTEGER NOT NULL DEFAULT 3000,
  critical_latency_ms INTEGER NOT NULL DEFAULT 8000,
  floating_enabled INTEGER NOT NULL DEFAULT 0,
  floating_percent REAL NOT NULL DEFAULT 50,
  baseline_method TEXT NOT NULL DEFAULT 'trimmed_average' CHECK (baseline_method IN ('rolling_average', 'trimmed_average', 'median', 'p95')),
  baseline_samples INTEGER NOT NULL DEFAULT 20 CHECK (baseline_samples BETWEEN 5 AND 500),
  failure_threshold INTEGER NOT NULL DEFAULT 3 CHECK (failure_threshold BETWEEN 1 AND 10),
  recovery_threshold INTEGER NOT NULL DEFAULT 2 CHECK (recovery_threshold BETWEEN 1 AND 10),
  next_check_at TEXT,
  current_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  raw_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_latency_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS checks (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  available INTEGER CHECK (available IN (0, 1)),
  status TEXT NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  ttft_ms INTEGER,
  error_type TEXT,
  error_message TEXT,
  error_headers_json TEXT,
  error_body TEXT,
  response_size INTEGER NOT NULL DEFAULT 0,
  timed_out INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0, 1)),
  response_preview TEXT
);

CREATE TABLE IF NOT EXISTS check_aggregates (
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  bucket_start TEXT NOT NULL,
  request_count INTEGER NOT NULL,
  known_count INTEGER NOT NULL,
  success_count INTEGER NOT NULL,
  failure_count INTEGER NOT NULL,
  latency_count INTEGER NOT NULL,
  average_latency_ms REAL,
  median_latency_ms INTEGER,
  p95_latency_ms INTEGER,
  p99_latency_ms INTEGER,
  minimum_latency_ms INTEGER,
  maximum_latency_ms INTEGER,
  ttft_count INTEGER NOT NULL,
  average_ttft_ms REAL,
  PRIMARY KEY (model_id, bucket_start)
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  resolved_at TEXT,
  title TEXT NOT NULL,
  error_type TEXT,
  error_message TEXT,
  status_code INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('webhook', 'discord', 'telegram', 'email_webhook')),
  config_cipher TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '["DOWN","RECOVERED","SLOW","HIGH_LATENCY","AUTH_ERROR","RATE_LIMIT"]',
  cooldown_minutes INTEGER NOT NULL DEFAULT 15,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  last_sent_at TEXT,
  last_event_key TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_events (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  incident_key TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  UNIQUE(notification_id, incident_key, event_type)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_models_due ON models(enabled, next_check_at);
CREATE INDEX IF NOT EXISTS idx_models_provider ON models(provider_id);
CREATE INDEX IF NOT EXISTS idx_checks_model_time ON checks(model_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_checks_checked_at ON checks(checked_at);
CREATE INDEX IF NOT EXISTS idx_check_aggregates_bucket ON check_aggregates(bucket_start);
CREATE INDEX IF NOT EXISTS idx_incidents_model_time ON incidents(model_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(resolved_at, model_id);
CREATE INDEX IF NOT EXISTS idx_notifications_enabled ON notifications(enabled);
CREATE INDEX IF NOT EXISTS idx_notification_events_cooldown ON notification_events(notification_id, sent_at DESC);

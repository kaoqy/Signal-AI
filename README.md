# Signal AI — AI Model Availability Monitor

Signal AI 是一套部署在 Cloudflare 上的 AI API 可用性监控平台。它会按模型自己的周期发送小型真实模型请求，记录状态、HTTP 响应、耗时、TTFT、错误详情和 Incident，并提供一个 React 管理面板与可选公开状态页。

## Features

- 自定义 Provider 和 Model；支持 OpenAI Compatible、Gemini、Anthropic Messages 与可配置 Custom API。
- 真实模型调用，默认 Prompt 为 `Reply with exactly: OK`，最大输出为 5 tokens。可选关闭模型调用，改为 API Base URL 的 HTTP 可达性检测。
- 记录 UP、SLOW、DOWN、TIMEOUT、ERROR、DEGRADED、RECOVERING、UNKNOWN 与 UNKNOWN_RESPONSE；自定义失败/恢复连续次数，避免单次失败改变最终状态。
- 固定延迟阈值以及滚动平均、去除两端各 10% 后的平均、Median、P95 基线。浮动阈值只取最近 N 次成功请求。
- 定时检测最小间隔 1 分钟；Cron 每分钟调度，各次检测支持 jitter，单次 Cron 最多运行 50 项、并发默认 5 项。
- D1 检测历史、Incident 与小时聚合；默认保留 14 天详细数据、180 天聚合数据，可在 UI 调整。
- 按 1h/6h/24h/7d/30d 汇总 uptime、downtime、成功率、平均/中位/P95/P99 延迟及 TTFT。
- Webhook、Discord Webhook、Telegram Bot、邮件服务 Webhook 通知；事件订阅与 5–1440 分钟冷却。
- HttpOnly/Secure/SameSite 会话 Cookie、签名会话、CSRF token、登录 IP 限流；管理 API 不允许匿名访问。
- Provider Key、自定义敏感 Header、通知目标凭据使用 `ENCRYPTION_KEY` 经 AES-GCM 加密后写入 D1。API 只返回遮罩值。
- 响应式面板、Dark/Light 模式、模型搜索和过滤、批量启停/删除/强制检测，以及 `/status` 公开页。

## Architecture

```text
React + TypeScript + Vite + Tailwind
              │ same-origin REST API
              ▼
Cloudflare Worker ── Fetch API ── AI Provider APIs
      │                 │
      ├── D1: providers / models / checks / incidents / aggregates / notifications / settings
      ├── KV: login rate limit / notification cooldown / retention cursor
      ├── Cron Trigger (* * * * *): due checks, bounded concurrency, retention aggregation
      └── Workers Assets: Vite production build
```

`worker/` contains the Worker, authentication, encrypted secret handling, provider adapters, persistence and scheduler. `src/` contains the single-page management and public status UIs. `migrations/0001_init.sql` defines all D1 tables, foreign keys and query indexes.

## Requirements

- Node.js 20.19+ or 22.12+ (Vite 8 runtime requirement)
- npm
- A Cloudflare account for production deployment
- Wrangler login for D1/KV creation and deployment

## Local development

```sh
npm install
npm run dev
```

The dev command builds the initial asset bundle, creates `.dev.vars` from `.dev.vars.example` if needed, applies local D1 migrations, then starts Vite at `http://localhost:5173` and Wrangler at `http://localhost:8787`. Vite proxies `/api` to the local Worker. The starter login is `admin` / `change-this-local-password`; set your own password in the ignored `.dev.vars` file before adding real API keys.

Useful local commands:

```sh
npm run db:migrate:local
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run visual-smoke
```

`.dev.vars` is local-only and excluded from Git. It contains `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`, and `ENCRYPTION_KEY`. Use independent, random values for production.
`npm run visual-smoke` additionally needs Microsoft Edge on Windows and the local dev servers; it checks mobile/desktop layouts, both themes and API-key redaction in the expanded error details.

## Cloudflare setup and deployment

Install packages and authenticate:

```sh
npm install
npx wrangler login
```

Create the D1 database and the production and preview KV namespaces:

```sh
npx wrangler d1 create model-monitor
npx wrangler kv namespace create model-monitor-cache
npx wrangler kv namespace create model-monitor-cache-preview
```

Copy the returned D1 database ID over the sample `00000000-0000-0000-0000-000000000001` in `database_id` in `wrangler.toml`. Copy the first KV ID over the sample `00000000000000000000000000000001` to `[[kv_namespaces]].id` and the second ID over `00000000000000000000000000000002` in `preview_id`. Keep the configured binding names `DB` and `CACHE`.

Apply the schema and configure credentials as Cloudflare Worker Secrets:

```sh
npx wrangler d1 migrations apply model-monitor --remote
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ENCRYPTION_KEY
```

Enter each value at the prompt. Use a strong, unique password and at least 32 random bytes for both `SESSION_SECRET` and `ENCRYPTION_KEY`. Do not put production credentials in `[vars]`, frontend environment variables, or source control. Set `APP_ORIGIN` in `wrangler.toml` to the deployed application origin (for example, `https://monitor.example.com`) before deploying.

Deploy the Worker and built frontend together:

```sh
npm run deploy
```

`npm run deploy` runs `npm run build` first, then `wrangler deploy`. The `[assets]` binding serves `dist/`; the Worker handles `/api/*`. The Cron Trigger is configured in `wrangler.toml` as `* * * * *` and is deployed with the Worker. Production database changes use:

```sh
npm run db:migrate:remote
```

Local data changes use `npm run db:migrate:local`. D1 migrations are forward-only; back up production data before schema changes.

### Cloudflare resources

- **D1**: required; stores provider metadata, encrypted secrets, models, checks, incidents, notification definitions, settings and hourly aggregates.
- **KV**: required; login-attempt rate limits, notification cooldowns and the history aggregation cursor.
- **Cron Trigger**: every minute; selects due enabled models and runs a bounded worker pool. The scheduler caps each tick at 50 checks by default; increase `MAX_CHECKS_PER_CRON` or `CHECK_CONCURRENCY` in `[vars]` only after considering provider rate limits and Worker execution limits.
- **Secrets**: `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `SESSION_SECRET`, `ENCRYPTION_KEY` are set with `wrangler secret put`.
- **Workers Assets**: Vite's `dist/` build is served by the same Worker origin, so browser API calls are same-origin.

## Add a Provider

1. Sign in and choose **Providers → Add provider**.
2. Choose OpenAI Compatible, Gemini, Anthropic, or Custom API.
3. Enter provider name, public HTTPS base URL, model name and API Key. Choose interval, timeout, Prompt and fixed latency thresholds.
4. Use **Advanced** to tune method/path/body, response parser, expected status, custom headers, jitter, dynamic baseline, sample count, and failure/recovery thresholds.
5. Select **Test connection** to execute a real minimal model request before saving.

Provider-specific request behavior:

- OpenAI Compatible: `POST {baseURL}/chat/completions`, with `model`, one user message, `max_tokens`, `temperature`, and `stream: true` to measure TTFT when SSE is returned.
- Anthropic: `POST {baseURL}/v1/messages`, with the required `anthropic-version` header and streaming enabled.
- Gemini: `POST {baseURL}/models/{model}:generateContent`; TTFT is not reported for the non-streaming Gemini request.
- Custom: relative URL path, method, headers, JSON/string body, expected status codes and optional dotted/indexed response path. The body can use `{{model}}`, `{{prompt}}`, and `{{max_tokens}}` placeholders.

Response parsing recognizes OpenAI `choices[0].message.content`, `choices[0].text`, `output_text`, top-level `content`, Anthropic text blocks and Gemini `candidates[0].content.parts[0].text`. A successful HTTP response with no recognized text becomes `UNKNOWN_RESPONSE`; it is not counted as an outage.

## Status logic and latency

- A request timeout is a TIMEOUT. HTTP/API errors are stored with their raw error classification; after the configured consecutive-failure threshold, the current model state moves to DOWN (or TIMEOUT).
- A successful response exceeding the Critical latency limit is treated as a failed health check; Warning marks SLOW. Dynamic latency can also mark a successful result SLOW when it exceeds the selected baseline by the configured percentage.
- UP/DOWN recovery state changes use the per-model consecutive-success threshold. A successful recovery remains RECOVERING until that threshold is met.
- Baselines use recent successful samples only. The recommended trimmed average removes the highest and lowest 10% before averaging.
- Incidents open for SLOW, DOWN, TIMEOUT or ERROR states and resolve on recovery. Consecutive low-level failures under the threshold show DEGRADED and do not immediately open a DOWN incident.

## REST API

All routes are same-origin JSON and return `{ "success": true, "data": ... }` or `{ "success": false, "error": { "code": ..., "message": ... } }`. All management routes require the signed HttpOnly session cookie and `X-CSRF-Token` returned by `GET /api/auth/me`. `POST /api/auth/login` establishes a session. `POST /api/auth/logout` ends it.

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/providers` | List providers (API keys masked) / create provider plus its first model |
| PUT / DELETE | `/api/providers/:id` | Update or delete a provider and its linked models |
| POST | `/api/providers/test` | Run an unsaved connection test |
| GET | `/api/models` | List models with current state |
| GET / PUT / DELETE | `/api/models/:id` | Read/update/delete a model |
| POST | `/api/models/:id/check` | Run and persist an immediate check |
| GET | `/api/models/:id/history?range=24h` | Read check history (`1h`, `6h`, `24h`, `7d`, `30d`) and uptime/latency metrics |
| GET | `/api/models/:id/incidents` | Read model incidents |
| POST | `/api/models/batch` | `{ "action": "enable\|disable\|delete\|check", "ids": [...] }`, up to 50 IDs |
| GET | `/api/dashboard` | Models and dashboard metrics |
| GET | `/api/incidents` | Incident timeline |
| GET / PUT | `/api/settings` | Read or update retention, public status, and new-model threshold defaults |
| GET / POST | `/api/notifications` | List or add notification destinations |
| PUT / DELETE | `/api/notifications/:id` | Update or remove a destination |
| GET | `/api/status` | Public provider status when enabled; otherwise 404 unless authenticated |

The UI calls `/api/dashboard`, `/api/settings`, `/api/notifications`, and the REST resources above. A full API Key is never included in any response. Custom error bodies are truncated and sensitive values are redacted before being stored or returned.

## Notifications

Add a destination from **Settings → Notifications**. Supported types are generic JSON Webhook, Discord Webhook, Telegram Bot and Email via Webhook. Select events (DOWN, RECOVERED, SLOW, AUTH_ERROR, RATE_LIMIT) and the channel applies a 15-minute default cooldown. The cooldown is configurable from 5 minutes to 24 hours through the REST API. A webhook delivery is an outbound HTTPS POST.

Cloudflare Workers do not expose a native TCP SMTP socket. `Email via Webhook` is the compatible option for an email delivery service that accepts HTTPS JSON webhooks; direct SMTP is not implemented. Generic email provider webhook payloads may require a relay/adapter that reshapes Signal AI's JSON to the service's schema.

## Security notes

- Set the four required Worker secrets before production use. Requests fail closed if the signing/encryption keys are missing.
- `ENCRYPTION_KEY` encrypts provider API Keys, sensitive custom headers, and notification destinations before D1 writes. Cloudflare Secret bindings cannot be created dynamically from the dashboard, so user-entered per-provider keys use application-level AES-GCM encryption in D1.
- The browser holds API keys only in an input's transient React state while editing/testing. Keys are not put in localStorage/sessionStorage, HTML attributes, request logs or API responses. The theme preference alone uses localStorage.
- Session cookies are HttpOnly, SameSite=Strict, Secure on HTTPS, and signed with HMAC-SHA256. Mutating requests require an Origin check and session-bound CSRF token. Login attempts are rate-limited by client IP in KV.
- The Worker serves the UI and API on one origin, does not enable wildcard CORS, and sets CSP, frame, MIME-sniffing, referrer and permissions headers on frontend assets.
- Provider URLs require HTTPS except loopback HTTP during local development. Private IP literals, common metadata hosts and credential-bearing URLs are rejected. Only add API endpoints you trust; a Worker must fetch the configured provider URL to run a check.
- Back up `ENCRYPTION_KEY` securely. Rotating it without decrypting and re-encrypting existing D1 values makes stored provider/notification credentials unreadable.

## Troubleshooting

- **`npm run dev` cannot find npm**: install Node.js 20.19+ or 22.12+ and ensure npm is on PATH.
- **Login says authentication is not configured**: verify local `.dev.vars` or production Worker Secrets include username, password and a 24+ character session secret.
- **Provider secret cannot be decrypted**: confirm the same `ENCRYPTION_KEY` used when saving it. Do not replace this key without a migration plan.
- **D1/KV binding error during deploy**: replace placeholder IDs in `wrangler.toml`, then rerun the D1 migration and deploy.
- **No automatic check appears**: verify the Worker Cron Trigger is deployed, model is enabled, `next_check_at` is due, and Worker logs show no provider timeout/rate-limit errors.
- **A model is UNKNOWN_RESPONSE**: its HTTP request succeeded but no recognized text path was found. Add a Custom response path or adjust the API type/body/response format.
- **429 errors**: increase the interval, reduce the number of enabled model checks, or account for the provider's rate limits.
- **Local login fails after changing `.dev.vars`**: restart `npm run dev` so Wrangler reloads local secrets.

## Upgrade and data retention

Add new SQL files as the next ordered file in `migrations/`, apply locally with `npm run db:migrate:local`, deploy, then apply remotely with `npm run db:migrate:remote`. Do not edit a migration that has already been applied to production. The hourly retention task rolls detailed checks into `check_aggregates` and then removes details older than the configured 7–30 days; hourly aggregates remain for 90–180 days.

The scheduler and D1 are intentionally bounded per Cron invocation. When many checks are due, later models wait for a later minute. Long-range percentiles are derived from hourly percentile summaries after detail compaction and therefore are approximate; request counts, success counts, averages, min/max and uptime remain aggregated from the stored hourly data.

## Validation commands

```sh
npm run typecheck
npm run lint
npm run build
npx wrangler deploy --dry-run
npx wrangler d1 migrations list model-monitor --local
npm run smoke
```

`npm run smoke` expects `npm run dev` to be running. It starts a local fake OpenAI-compatible endpoint and exercises session/CSRF checks, provider/model CRUD, streaming TTFT, error redaction, history, incidents, batch actions, notifications and the public status route; it does not call an external AI provider.

# Signal AI — AI 模型可用性监控平台

Signal AI 支持在一个 Provider 下保存多个模型。它是一套部署在 Cloudflare 上的 AI API 可用性监控平台。它会按模型自己的周期发送小型真实模型请求，记录状态、HTTP 响应、耗时、TTFT、错误详情和 Incident，并提供中英双语的 React 管理面板与免登录公开状态首页。

## 部署前先看：需要创建什么？

生产部署需要 **1 个 D1 数据库**、**1 个 KV 命名空间**和 **4 个 Worker Secrets**。本仓库的 `wrangler.toml` 已绑定 Signal AI 当前使用的 D1/KV 资源；部署到同一个 Cloudflare 账号时不要重复创建。若部署到其他账号或全新项目，再创建资源并替换绑定 ID。项目已配置每分钟 Cron；执行 `npm run deploy` 时会一起部署 Worker、前端静态资源和 Cron，不需要另外创建服务器或单独设置 Cron。

本地开发不需要创建 Cloudflare D1/KV：Wrangler 会使用本地模拟资源。每个 Provider 的模型 API Key 在登录后的网页中填写，并使用 `ENCRYPTION_KEY` 加密保存到 D1；不需要为每个 Provider 单独创建 Cloudflare Secret。

| 项目 | 是否需要 | 用途 |
|---|---|---|
| D1 数据库 | 需要 1 个 | 保存 Provider、模型、加密后的凭据、检测历史、Incident 和设置 |
| KV 命名空间 | 需要 1 个 | 登录限流、通知冷却和历史聚合游标 |
| Worker Secrets | 需要 4 个 | 管理员登录、会话签名和数据库凭据加密 |
| Preview KV | 可选 | 仅在需要远程预览/测试环境时自行创建；本项目默认配置不需要 |
| Cron Trigger | 不需要手动创建 | `wrangler.toml` 已配置为每分钟运行，随 Worker 部署 |

## 功能

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
- 中文和英文界面切换、响应式面板、Dark/Light 模式、模型搜索和过滤、批量启停/删除/强制检测。
- `/` 和 `/status` 提供免登录、每分钟自动刷新的公开状态页；`/admin` 进入需要管理员登录的管理后台。

## 架构

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

`worker/` 目录包含 Worker、认证、加密凭据处理、Provider 适配器、数据持久化和调度器；`src/` 目录包含中英双语管理面板和公开状态页；D1 数据表、外键和查询索引由 `migrations/` 中的迁移文件定义。

## 环境要求

- Node.js 20.19+ 或 22.12+（Vite 8 的运行环境要求）
- npm
- 用于生产部署的 Cloudflare 账号
- 已登录 Wrangler，以便创建 D1/KV 并部署 Worker

## 本地开发

```sh
npm install
npm run dev
```

开发命令会先构建前端资源；如果 `.dev.vars` 不存在，则从 `.dev.vars.example` 复制一份；然后应用本地 D1 迁移，并启动 Vite（`http://localhost:5173`）和 Wrangler（`http://localhost:8787`）。Vite 会把 `/api` 请求代理到本地 Worker。默认登录账号是 `admin` / `change-this-local-password`；添加真实 API Key 前，请先在被 Git 忽略的 `.dev.vars` 文件中改掉默认密码。

Useful local commands:

```sh
npm run db:migrate:local
npm run typecheck
npm run lint
npm run build
npm run smoke
npm run visual-smoke
```

`.dev.vars` 仅用于本地开发，并已加入 Git 忽略规则。文件中包含 `ADMIN_USERNAME`、`ADMIN_PASSWORD`、`SESSION_SECRET` 和 `ENCRYPTION_KEY`；生产环境请为这些配置使用独立值。
`npm run visual-smoke` 还需要 Windows 上的 Microsoft Edge 和正在运行的本地开发服务；该命令会检查手机/桌面布局、深浅两种主题，以及错误详情中的 API Key 脱敏。

## Cloudflare 部署

以下命令在项目根目录运行。生产部署需要 Node.js 20.19+ 或 22.12+、Cloudflare 账号和 Wrangler 登录权限。

### 1. 安装依赖并登录 Cloudflare

```sh
npm install
npx wrangler login
```

### 2. 核对 D1 和 KV 绑定

本仓库已配置当前 Signal AI 项目的 D1 和 KV ID。部署到同一个 Cloudflare 账号时，核对 `wrangler.toml` 中 `database_id` 和 KV `id` 与 Dashboard 中该 Worker 的绑定一致即可，不要重复创建数据库或命名空间。

只有部署到另一个 Cloudflare 账号或全新项目时，才运行以下命令创建资源：

```sh
npx wrangler d1 create model-monitor
npx wrangler kv namespace create model-monitor-cache
```

命令会分别返回 D1 `database_id` 和 KV 命名空间 `id`。打开 `wrangler.toml`，将新 ID 填入对应位置，并保留绑定名称 `DB` 和 `CACHE`：

- 将 `[[d1_databases]]` 下的 `database_id` 替换为 D1 命令返回的 ID；数据库名保持 `model-monitor`。
- 将 `[[kv_namespaces]]` 下的 `id` 替换为 KV 命令返回的 ID。

本项目默认只绑定生产 D1/KV，不需要创建第二个预览 KV。若之后使用独立远程预览环境，再创建单独资源并按 Cloudflare 的预览配置进行绑定。

### 3. 设置生产环境 Secrets

下面四项必须设置。每条 `secret put` 命令会提示输入值；这些值由 Cloudflare 作为 Worker Secret 保存，不要提交到 Git，也不要写入前端变量：

```sh
npx wrangler secret put ADMIN_USERNAME
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put ENCRYPTION_KEY
```

`ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 是管理后台登录账号。请为 `ADMIN_PASSWORD` 设置强密码。`SESSION_SECRET` 和 `ENCRYPTION_KEY` 应分别使用独立的随机值，建议各生成至少 32 个随机字节。可运行下面命令两次，每次生成一个新值，并分别粘贴到对应提示中：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

请妥善备份 `ENCRYPTION_KEY`。更换该值而不先迁移 D1 中已加密的数据，会导致已保存的 Provider Key、敏感 Header 和通知凭据无法解密。Provider API Key 在网页中添加后会加密保存在 D1，不需要逐个创建 Cloudflare Secret。

如果使用 Cloudflare Workers Builds 从 GitHub 自动部署，请在 Cloudflare Dashboard 的 Worker **Settings → Variables and Secrets** 中把上述四项添加为 **Secrets**。如果这些值当前误放在普通 **Variables** 列表中，先删除普通变量，再用新值创建同名 Secrets。不要把密钥写进 `wrangler.toml` 的 `[vars]`；普通变量可能会出现在构建日志中。

### 4. 应用 D1 数据库迁移

```sh
npx wrangler d1 migrations apply model-monitor --remote
```

这会按 `migrations/` 中的 SQL 文件创建表、外键和索引。以后更新数据库结构时新增迁移文件，并使用 `npm run db:migrate:remote` 应用。

`0002_public_status_default.sql` 会将旧部署中已保存的公开状态页选项切换为开启。更新部署时请先应用迁移，再发布 Worker。

### 5. 部署 Worker、前端和 Cron

```sh
npm run deploy
```

该命令会先执行 TypeScript 检查和 Vite 构建，再运行 `wrangler deploy`。Worker Assets 从 `dist/` 提供前端，Worker 在同一域名处理 `/api/*`。部署完成后，Cloudflare 会按 `wrangler.toml` 中的 `* * * * *` 每分钟触发调度器；无需另行创建 Cron。

### 部署变量说明

| 名称 | 类型 | 必需 | 默认/说明 |
|---|---|---|---|
| `ADMIN_USERNAME` | Worker Secret | 是 | 管理员登录名 |
| `ADMIN_PASSWORD` | Worker Secret | 是 | 管理员登录密码 |
| `SESSION_SECRET` | Worker Secret | 是 | HMAC 会话签名密钥，至少 24 个字符；建议随机 32 字节以上 |
| `ENCRYPTION_KEY` | Worker Secret | 是 | 加密数据库中的 Provider Key 等敏感数据；建议随机 32 字节以上 |
| `APP_ORIGIN` | Wrangler `[vars]` / `.dev.vars` | 否 | 允许的跨域前端 Origin。生产已设为部署域名；本地开发通过 `.dev.vars` 覆盖为 `http://localhost:5173`。静态页面与 API 同域时会自动按请求域名校验 |
| `MAX_CHECKS_PER_CRON` | Wrangler `[vars]` 变量 | 否 | 每次 Cron 最多处理数量，默认 `50`，代码上限 `200` |
| `CHECK_CONCURRENCY` | Wrangler `[vars]` 变量 | 否 | 同时执行的检测数量，默认 `5`，代码上限 `20` |
| `DEFAULT_RETENTION_DAYS` | Wrangler `[vars]` 变量 | 否 | 详细检测数据保留天数，默认 `14`，范围 `7`–`30` |

后三项已有默认值，通常不需要在 Cloudflare Dashboard 额外填写；如需调整，请修改 `wrangler.toml` 的 `[vars]` 后重新部署。`APP_ORIGIN` 不是密钥。登录和加密密钥不要放在 `[vars]` 中。

### 本地数据库与部署数据库

本地开发使用 Wrangler 的本地 D1/KV 模拟，不会读写 Cloudflare 上的生产数据：

```sh
npm run db:migrate:local
```

生产数据库迁移使用：

```sh
npm run db:migrate:remote
```

D1 迁移采用增量方式，不要修改已经在生产环境执行过的迁移文件；修改表结构前请先备份生产数据。

## 添加 Provider

1. 登录后进入 **Providers → Add provider**。
2. 选择 OpenAI Compatible、Gemini、Anthropic 或 Custom API。
3. 填写 Provider 名称、公开的 HTTPS Base URL、模型名称和 API Key，并设置检测间隔、超时、Prompt 与固定延迟阈值。
4. 在 **Advanced** 中设置请求方法、路径、Body、响应解析器、预期状态码、自定义 Header、Jitter、动态基线、样本数量及失败/恢复阈值。
5. 点击 **Test connection**，保存前先执行一次真实的最小模型请求。

各 API 类型的请求方式：

- OpenAI Compatible：向 `POST {baseURL}/chat/completions` 发送包含 `model`、一条用户消息、`max_tokens`、`temperature` 的请求；启用 `stream: true`，并在收到 SSE 流时测量 TTFT。
- Anthropic：向 `POST {baseURL}/v1/messages` 发送请求，包含必需的 `anthropic-version` Header，并启用流式响应。
- Gemini：向 `POST {baseURL}/models/{model}:generateContent` 发送请求；当前使用非流式调用，因此不报告 TTFT。
- OpenAI 支持两种格式：`Chat Completions` 和 `Responses`；Anthropic 使用 `Messages`；Gemini 使用 `generateContent`。请求路径、Header 和 Body 会自动构造，普通用户无需手写 HTTP 请求。

响应解析支持 OpenAI 的 `choices[0].message.content`、`choices[0].text`、`output_text`、顶层 `content`，以及 Anthropic 文本块和 Gemini 的 `candidates[0].content.parts[0].text`。HTTP 请求成功但未找到可识别文本时，结果为 `UNKNOWN_RESPONSE`，不会直接计为服务故障。

## 状态与延迟判断

- 请求超时记为 `TIMEOUT`。HTTP/API 错误会保留对应错误分类；连续失败达到模型设置的阈值后，当前状态才转为 `DOWN`（或 `TIMEOUT`）。
- 成功响应超过 Critical 延迟阈值时，会按失败健康检查处理；超过 Warning 阈值时标记为 `SLOW`。如果启用动态延迟基线，成功请求的延迟超过基线和设定比例时也会标记为 `SLOW`。
- `UP`/`DOWN` 的恢复过程按模型配置的连续成功阈值判断。服务成功恢复后，在达到阈值前状态保持为 `RECOVERING`。
- 延迟基线仅使用最近的成功样本。推荐使用去除最高和最低各 10% 样本后的平均值。
- `SLOW`、`DOWN`、`TIMEOUT` 或 `ERROR` 状态会创建 Incident，并在恢复后关闭。连续失败尚未达到阈值时显示 `DEGRADED`，不会立即创建 `DOWN` Incident。

## REST API 接口

所有路由都使用同源 JSON，并统一返回 `{ "success": true, "data": ... }` 或 `{ "success": false, "error": { "code": ..., "message": ... } }`。管理接口需要已签名的 HttpOnly Session Cookie，以及 `GET /api/auth/me` 返回的 `X-CSRF-Token`。`POST /api/auth/login` 用于登录，`POST /api/auth/logout` 用于退出。

| Method | Path | Purpose |
|---|---|---|
| GET / POST | `/api/providers` | List providers with all models (keys masked) / create a provider and its first model |
| POST | `/api/providers/:id/models` | Add another model to an existing provider |
| PUT / DELETE | `/api/providers/:id` | Update or delete a provider and all linked models |
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
| GET | `/api/status` | 默认免登录返回公开状态；可在后台设置中改为私有 |

网页 `/` 是无需登录的模型可用性首页，`/status` 是兼容路径；管理后台位于 `/admin`，必须使用管理员账号登录。页面右上角可以切换中文或英文，语言偏好只保存在当前浏览器中。

界面会调用 `/api/dashboard`、`/api/settings`、`/api/notifications` 和上表中的 REST 接口。任何响应都不会包含完整 API Key。公开状态接口只返回服务商名称、模型名称、状态、延迟、检测时间和汇总统计，不包含 Provider 凭据。自定义错误 Body 会截断，并在存储或返回前脱敏其中的敏感值。

## 通知配置

在 **Settings → Notifications** 中添加通知目标。支持通用 JSON Webhook、Discord Webhook、Telegram Bot，以及通过 Webhook 接入邮件服务。可选择 `DOWN`、`RECOVERED`、`SLOW`、`AUTH_ERROR` 和 `RATE_LIMIT` 等事件；默认冷却时间为 15 分钟，可通过 REST API 调整为 5 分钟至 24 小时。Webhook 使用 HTTPS POST 发送通知。

Cloudflare Workers 不提供原生 TCP SMTP Socket。因此，邮件通知通过接受 HTTPS JSON Webhook 的邮件服务接入；项目未实现直接 SMTP。部分邮件服务要求特定的请求格式，可能需要中继服务将 Signal AI 的 JSON 转换为目标服务所需的格式。

## 安全说明

- 生产环境必须设置前述四个 Worker Secrets。缺少会话签名或加密密钥时，相关请求会拒绝执行。
- D1 写入前，`ENCRYPTION_KEY` 会加密 Provider API Key、敏感自定义 Header 和通知凭据。由于 Cloudflare Secret 绑定不能按用户输入动态创建，Provider Key 使用应用层 AES-GCM 加密后保存在 D1。
- 浏览器仅在编辑或测试时，将 API Key 暂存在 React 输入状态中。Key 不会写入 localStorage/sessionStorage、HTML 属性、请求日志或 API 响应。主题偏好使用 localStorage。
- Session Cookie 使用 HttpOnly、SameSite=Strict，并在 HTTPS 下设置 Secure；签名采用 HMAC-SHA256。修改类请求会检查 Origin 和与 Session 绑定的 CSRF Token。登录尝试按客户端 IP 在 KV 中限流。
- Worker 在同一域名提供界面和 API，不启用通配符 CORS，并为前端资源设置 CSP、Frame、MIME 嗅探、Referrer 和 Permissions 安全 Header。
- Provider URL 必须使用 HTTPS；本地开发时允许访问回环地址上的 HTTP。系统会拒绝私有 IP、常见云元数据地址和包含凭据的 URL。Worker 会主动请求所配置的 Provider URL，请只添加可信 API 地址。
- 请安全备份 `ENCRYPTION_KEY`。如果不先解密并重新加密 D1 中的现有数据，直接轮换此密钥会导致已保存的 Provider/通知凭据无法读取。

## 故障排查

- **运行 `npm run dev` 时找不到 npm**：安装 Node.js 20.19+ 或 22.12+，并确认 npm 已加入 PATH。
- **登录提示尚未配置认证**：检查本地 `.dev.vars` 或生产 Worker Secrets 是否包含用户名、密码和至少 24 个字符的 Session Secret。
- **Provider 凭据无法解密**：确认当前 `ENCRYPTION_KEY` 与保存凭据时使用的值相同。不要在没有数据迁移方案时更换密钥。
- **部署时出现 D1/KV 绑定错误**：检查 `wrangler.toml` 中的 D1/KV ID 是否对应当前 Cloudflare 账号，再重新应用 D1 迁移并部署。
- **提示 `KV namespace ... not found`**：KV ID 不存在于当前 Cloudflare 账号，或绑定 ID 填错。核对 `CACHE` 绑定的 ID 与 Dashboard 中该 Worker 使用的 KV 命名空间。
- **没有自动检测记录**：确认 Worker Cron 已部署、模型已启用、`next_check_at` 已到期，并检查 Worker 日志中的 Provider 超时或限流错误。
- **模型状态为 `UNKNOWN_RESPONSE`**：HTTP 请求成功，但未找到可识别的文本路径。请设置 Custom 响应路径，或调整 API 类型、Body 和响应格式。
- **出现 429 错误**：增加检测间隔、减少启用的模型数量，或遵守 Provider 的限流规则。
- **修改 `.dev.vars` 后本地无法登录**：重启 `npm run dev`，让 Wrangler 重新加载本地变量。

## 升级与数据保留

升级数据库时，在 `migrations/` 中按顺序新增 SQL 文件，先用 `npm run db:migrate:local` 在本地应用并验证，再部署代码，最后用 `npm run db:migrate:remote` 更新生产数据库。不要修改已在生产环境执行过的迁移。每小时保留任务会将详细检测记录汇总到 `check_aggregates`，然后删除超过配置保留期（7–30 天）的详细记录；小时聚合数据保留 90–180 天。

每次 Cron 调度处理的任务数和 D1 操作量都有上限。如果到期检测过多，剩余模型会在之后的分钟继续排队检测。详细数据压缩后，较长时间范围的百分位数由小时级百分位摘要推算，因此属于近似值；请求数、成功数、平均值、最大/最小值和可用率则根据保存的小时数据聚合。

## 本地验证命令

```sh
npm run typecheck
npm run lint
npm run build
npx wrangler deploy --dry-run
npx wrangler d1 migrations list model-monitor --local
npm run smoke
```

运行 `npm run smoke` 前需要先启动 `npm run dev`。该命令会启动本地模拟的 OpenAI Compatible 接口，并检查 Session/CSRF、Provider/Model 增删改查、流式 TTFT、错误脱敏、历史记录、Incident、批量操作、通知和公开状态页；它不会调用外部 AI Provider。

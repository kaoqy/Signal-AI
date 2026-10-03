import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, AlertCircle, ArrowDownRight, ArrowUpRight, ArrowUpRightFromSquare, Check, CheckCheck, ChevronDown,
  ChevronLeft, ChevronRight, CircleHelp, Clock3, ExternalLink, Eye, EyeOff, Gauge, Globe2, KeyRound,
  LayoutDashboard, LoaderCircle, LockKeyhole, LogOut, Menu, Moon, MoreHorizontal, Plus, Radio, RefreshCw,
  Search, Settings as SettingsIcon, ShieldCheck, Sun, Trash2, TriangleAlert, X, Zap,
} from 'lucide-react';
import type { ApiResult, Check as CheckRecord, Incident, Model, Provider, Status, Summary } from './types';
import { getLanguage, setLanguage, tr, type Language } from './i18n';

let csrfToken: string | null = null;
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase()) && csrfToken) headers.set('x-csrf-token', csrfToken);
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const result = await response.json() as ApiResult<T>;
  if (!response.ok || !result.success) throw new Error(result.error?.message ?? `Request failed (${response.status}).`);
  return result.data as T;
}

const routes = [
  { path: '/admin', label: 'Overview', icon: LayoutDashboard },
  { path: '/admin/models', label: 'Models', icon: Radio },
  { path: '/admin/incidents', label: 'Incidents', icon: TriangleAlert },
  { path: '/admin/providers', label: 'Providers', icon: Globe2 },
  { path: '/admin/settings', label: 'Settings', icon: SettingsIcon },
];
const statusLabels: Record<string, string> = {
  UP: 'Operational', SLOW: 'Slow', DOWN: 'Down', TIMEOUT: 'Timeout', ERROR: 'Error', DISABLED: 'Disabled',
  UNKNOWN: 'Unknown', UNKNOWN_RESPONSE: 'Unparsed', DEGRADED: 'Degraded', RECOVERING: 'Recovering',
};
const apiTypeLabels: Record<string, string> = { openai: 'OpenAI Compatible', gemini: 'Gemini', anthropic: 'Anthropic', custom: 'Custom API' };
const rangeLabels: Record<string, string> = { '1h': '1 hour', '6h': '6 hours', '24h': '24 hours', '7d': '7 days', '30d': '30 days' };

function App() {
  const [path, setPath] = useState(() => {
    const current = window.location.pathname;
    const legacy: Record<string, string> = { '/models': '/admin/models', '/incidents': '/admin/incidents', '/providers': '/admin/providers', '/settings': '/admin/settings' };
    const legacyModel = current.match(/^\/models\/([^/]+)$/)?.[1];
    const next = legacy[current] ?? (legacyModel ? `/admin/models/${legacyModel}` : undefined);
    if (next) window.history.replaceState({}, '', next);
    return next ?? current;
  });
  const [authenticated, setAuthenticated] = useState(false);
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [language, setLanguageState] = useState<Language>(getLanguage);
  const [username, setUsername] = useState('admin');
  const [models, setModels] = useState<Model[]>([]);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [notifications, setNotifications] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (localStorage.getItem('monitor-theme') as 'dark' | 'light') || 'dark');
  const [providerModal, setProviderModal] = useState<Provider | 'new' | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [detail, setDetail] = useState<Record<string, any> | null>(null);
  const [detailChecks, setDetailChecks] = useState<CheckRecord[]>([]);
  const [detailRange, setDetailRange] = useState('24h');

  function changeLanguage() {
    const next = language === 'zh-CN' ? 'en-US' : 'zh-CN';
    setLanguage(next);
    setLanguageState(next);
  }

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('monitor-theme', theme);
  }, [theme]);

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((next: string) => {
    window.history.pushState({}, '', next);
    setPath(next);
    setMobileMenuOpen(false);
  }, []);

  const notify = useCallback((message: string, kind: 'success' | 'error' = 'success') => {
    setToast({ message, kind });
    window.setTimeout(() => setToast(null), 3600);
  }, []);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const [dashboard, providerData, incidentData, settingData, notificationData] = await Promise.all([
        api<{ models: Model[]; summary: Summary }>('/api/dashboard'),
        api<Provider[]>('/api/providers'),
        api<Incident[]>('/api/incidents'),
        api<Record<string, unknown>>('/api/settings'),
        api<Array<Record<string, unknown>>>('/api/notifications'),
      ]);
      setModels(dashboard.models);
      setSummary(dashboard.summary);
      setProviders(providerData);
      setIncidents(incidentData);
      setSettings(settingData);
      setNotifications(notificationData);
    } catch (error) {
      if (!quiet) notify(error instanceof Error ? error.message : 'Could not refresh monitor data.', 'error');
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    if (path === '/' || path === '/status' || authenticated) {
      setCheckingAuth(false);
      return;
    }
    let active = true;
    setCheckingAuth(true);
    api<{ username: string; csrf: string }>('/api/auth/me').then((session) => {
      if (!active) return;
      csrfToken = session.csrf;
      setUsername(session.username);
      setAuthenticated(true);
      setCheckingAuth(false);
      setLoading(true);
      void refresh(true);
    }).catch(() => {
      if (!active) return;
      setCheckingAuth(false);
      setAuthenticated(false);
    });
    return () => { active = false; };
  }, [path, authenticated, refresh]);

  useEffect(() => {
    if (!authenticated) return;
    const id = window.setInterval(() => void refresh(true), 45_000);
    return () => window.clearInterval(id);
  }, [authenticated, refresh]);

  useEffect(() => {
    const modelId = path.match(/^\/admin\/models\/([^/]+)$/)?.[1];
    if (!authenticated || !modelId) { setDetail(null); return; }
    let current = true;
    setLoading(true);
    Promise.all([
      api<Record<string, any>>(`/api/models/${modelId}`),
      api<{ checks: CheckRecord[] }>(`/api/models/${modelId}/history?range=${detailRange}`),
    ]).then(([model, history]) => {
      if (current) { setDetail(model); setDetailChecks(history.checks); }
    }).catch((error) => notify(error instanceof Error ? error.message : 'Could not load model details.', 'error')).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [path, detailRange, authenticated, notify]);

  async function signIn(event: FormEvent<HTMLFormElement>, user: string, password: string) {
    event.preventDefault();
    const submit = event.currentTarget.querySelector<HTMLButtonElement>('button[type="submit"]');
    if (submit) submit.disabled = true;
    try {
      const result = await api<{ username: string; csrf: string }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: user, password }) });
      csrfToken = result.csrf;
      setUsername(result.username);
      setAuthenticated(true);
      setLoading(true);
      void refresh(true);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Sign in failed.', 'error');
      if (submit) submit.disabled = false;
    }
  }

  async function signOut() {
    try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* discard local session either way */ }
    csrfToken = null;
    setAuthenticated(false);
    navigate('/');
  }

  async function forceCheck(id: string) {
    try {
      const result = await api<{ status: Status; latency: number; available: boolean | null }>(`/api/models/${id}/check`, { method: 'POST', body: '{}' });
      notify(result.available === true ? `${tr('Check complete')} · ${formatMs(result.latency)} · ${tr(statusLabels[result.status])}` : `${tr('Check complete')} · ${tr(statusLabels[result.status])}`,
        result.status === 'UP' ? 'success' : result.status === 'SLOW' ? 'success' : 'error');
      await refresh(true);
      if (detail?.id === id) {
        const [model, historyData] = await Promise.all([api<Record<string, any>>(`/api/models/${id}`), api<{ checks: CheckRecord[] }>(`/api/models/${id}/history?range=${detailRange}`)]);
        setDetail(model); setDetailChecks(historyData.checks);
      }
    } catch (error) { notify(error instanceof Error ? error.message : 'Check failed.', 'error'); }
  }

  async function batch(action: string, ids: string[]) {
    if (!ids.length) return notify(tr('Select at least one model.'), 'error');
    try {
      const result = await api<{ affected: number }>('/api/models/batch', { method: 'POST', body: JSON.stringify({ action, ids }) });
      notify(getLanguage() === 'zh-CN' ? `已${action === 'check' ? '检测' : action === 'delete' ? '删除' : action === 'enable' ? '启用' : '停用'} ${result.affected} 个模型。` : `${result.affected} model${result.affected === 1 ? '' : 's'} ${action === 'check' ? 'checked' : action === 'delete' ? 'deleted' : `${action}d`}.`);
      await refresh(true);
    } catch (error) { notify(error instanceof Error ? error.message : 'Batch action failed.', 'error'); }
  }

  async function saveSettings(values: Record<string, unknown>) {
    try {
      setSettings(await api<Record<string, unknown>>('/api/settings', { method: 'PUT', body: JSON.stringify(values) }));
      notify('Settings saved.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not save settings.', 'error'); }
  }

  async function saveNotification(values: Record<string, unknown>) {
    try {
      await api('/api/notifications', { method: 'POST', body: JSON.stringify(values) });
      setNotifications(await api<Array<Record<string, unknown>>>('/api/notifications'));
      notify('Notification channel added.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not add notification.', 'error'); }
  }

  const activeRoute = path.startsWith('/admin/models/') ? '/admin/models' : path;
  const pageTitle = path === '/admin' ? 'Overview' : path === '/status' ? 'Public status' : path.startsWith('/admin/models/') ? 'Model details' : routes.find((route) => route.path === path)?.label ?? 'Monitor';
  if (path === '/' || path === '/status') return <PublicStatus navigate={navigate} theme={theme} setTheme={setTheme} language={language} onLanguageChange={changeLanguage} />;
  if (checkingAuth) return <div className="screen-center"><div className="loading-mark"><Activity size={22} /></div><LoaderCircle className="spin" size={18} /> {tr('Loading your monitor')}</div>;
  if (!authenticated) return <Login onSubmit={signIn} toast={toast} />;

  const content = path.startsWith('/admin/models/') && detail ? <ModelDetail model={detail} checks={detailChecks} range={detailRange} setRange={setDetailRange} onBack={() => navigate('/admin/models')} onCheck={() => forceCheck(detail.id)} loading={loading} />
    : path === '/admin/models' ? <ModelsPage models={models} providers={providers} onBatch={batch} onCheck={forceCheck} onOpen={(id) => navigate(`/admin/models/${id}`)} />
      : path === '/admin/incidents' ? <IncidentsPage incidents={incidents} onOpen={(id) => navigate(`/admin/models/${id}`)} />
        : path === '/admin/providers' ? <ProvidersPage providers={providers} onAdd={() => setProviderModal('new')} onEdit={(provider) => setProviderModal(provider)} onRefresh={() => void refresh(true)} notify={notify} />
          : path === '/admin/settings' ? <SettingsPage settings={settings} notifications={notifications} onSave={saveSettings} onSaveNotification={saveNotification} onRefresh={() => void refresh(true)} notify={notify} />
            : <DashboardPage models={models} summary={summary} incidents={incidents} onOpen={(id) => navigate(`/admin/models/${id}`)} onModels={() => navigate('/admin/models')} onProvider={() => setProviderModal('new')} />;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`}>
        <a className="brand" href="/admin" onClick={(event) => { event.preventDefault(); navigate('/admin'); }}>
          <span className="brand-mark"><Activity size={18} strokeWidth={2.5} /></span>
          <span className="brand-text">{tr("signal")}<span>{tr("ai")}</span><small>{tr("MODEL MONITOR")}</small></span>
        </a>
        <div className="workspace-switcher"><div className="workspace-icon">{tr("P")}</div><div className="workspace-meta"><strong>{tr("Personal workspace")}</strong><span>{tr("Free plan")}</span></div><ChevronDown size={15} /></div>
        <div className="nav-caption">{tr("MONITOR")}</div>
        <nav className="main-nav">
          {routes.map(({ path: route, label, icon: Icon }) => <a key={route} href={route} className={`nav-link ${activeRoute === route ? 'active' : ''}`} onClick={(event) => { event.preventDefault(); navigate(route); }}>
            <Icon size={17} strokeWidth={1.8} /><span>{tr(label)}</span>{label === 'Incidents' && incidents.some((item) => !item.resolved_at) && <i className="nav-alert-dot" />}
          </a>)}
        </nav>
        <div className="sidebar-status">
          <div className="live-indicator"><span className="pulse-dot" /> {tr("Live monitoring")}</div>
          <p>{models.filter((model) => model.enabled).length} {tr("active endpoints")}</p>
          <div className="sidebar-status-line"><span>{tr("Global uptime")}</span><strong>{summary?.uptime24h == null ? '—' : `${summary.uptime24h.toFixed(2)}%`}</strong></div>
        </div>
        <div className="sidebar-bottom">
          <a className="public-link" href="/" target="_blank" rel="noreferrer"><Globe2 size={16} /> {tr('Public status page')} <ArrowUpRightFromSquare size={13} /></a>
          <div className="user-card"><div className="avatar">{username.slice(0, 1).toUpperCase()}</div><div className="user-info"><strong>{username}</strong><span>{tr("Administrator")}</span></div>
            <button className="icon-button subtle" aria-label={tr("Sign out")} onClick={signOut}><LogOut size={16} /></button></div>
        </div>
      </aside>
      {mobileMenuOpen && <button className="sidebar-backdrop" aria-label={tr("Close navigation")} onClick={() => setMobileMenuOpen(false)} />}
      <main className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu-button" aria-label={tr('Open menu')} onClick={() => setMobileMenuOpen((open) => !open)}><Menu size={19} /></button>
          <div className="breadcrumb"><span>{tr('Workspace')}</span><ChevronRight size={14} /><strong>{tr(pageTitle)}</strong></div>
          <div className="topbar-actions"><div className="system-live"><span className="pulse-dot" /> {tr('All systems')} {summary?.down ? tr('not operational') : tr('operational')}</div>
            <button className="locale-toggle" onClick={changeLanguage} aria-label={language === 'zh-CN' ? 'Switch language to English' : '切换界面语言为中文'}>{language === 'zh-CN' ? 'EN' : '中文'}</button>
            <button className="icon-button" aria-label={tr("Refresh data")} title={tr("Refresh data")} onClick={() => void refresh()}><RefreshCw size={16} className={refreshing ? 'spin' : ''} /></button>
            <button className="icon-button" aria-label={tr("Toggle theme")} title={tr("Toggle theme")} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
          </div>
        </header>
        <div className="page-content">{content}</div>
      </main>
      {providerModal && <ProviderModal provider={providerModal === 'new' ? null : providerModal} onClose={() => setProviderModal(null)} onSaved={async (message) => { setProviderModal(null); await refresh(true); notify(message); }} notify={notify} />}
      {toast && <div className={`toast ${toast.kind}`}><span className="toast-icon">{toast.kind === 'success' ? <Check size={16} /> : <AlertCircle size={16} />}</span>{toast.message}<button onClick={() => setToast(null)} aria-label={tr("Dismiss")}><X size={15} /></button></div>}
    </div>
  );
}

function Login({ onSubmit, toast }: { onSubmit: (event: FormEvent<HTMLFormElement>, username: string, password: string) => void; toast: { kind: string; message: string } | null }) {
  const [user, setUser] = useState('admin');
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  return <div className="login-layout">
    <div className="login-art"><div className="login-art-grid" /><div className="login-orbit orbit-one" /><div className="login-orbit orbit-two" />
      <div className="login-brand"><span className="brand-mark"><Activity size={18} /></span><span className="brand-text">{tr("signal")}<span>{tr("ai")}</span></span></div>
      <div className="login-art-copy"><div className="eyebrow"><span className="pulse-dot" /> {tr("INTELLIGENCE, IN REAL TIME")}</div><h1>{tr("Your models.")}<br /><span>{tr("Always in view.")}</span></h1><p>{tr("Know when your AI is ready. Catch latency before your users do.")}</p>
        <div className="login-preview"><div className="preview-head"><span><i className="green-dot" /> {tr("API status")}</span><span>{tr("LIVE")}</span></div><div className="preview-row"><span className="preview-service"><i className="status-dot up" />{tr("OpenRouter ")}<small>{tr("Qwen 3.5")}</small></span><strong>{tr("842")}<span>{tr("ms")}</span></strong><span className="preview-spark" /></div><div className="preview-row"><span className="preview-service"><i className="status-dot slow" />{tr("Anthropic ")}<small>{tr("Claude Sonnet")}</small></span><strong>{tr("1.2")}<span>{tr("s")}</span></strong><span className="preview-spark orange" /></div><div className="preview-row"><span className="preview-service"><i className="status-dot up" />{tr("Google AI ")}<small>{tr("Gemini Flash")}</small></span><strong>{tr("321")}<span>{tr("ms")}</span></strong><span className="preview-spark blue" /></div></div>
      </div><div className="login-footer">{tr("PRIVATE BY DESIGN ")}<span>{tr("·")}</span> {tr("RUNS ON CLOUDFLARE")}</div>
    </div>
    <div className="login-form-side"><div className="login-card"><div className="mobile-login-brand"><span className="brand-mark"><Activity size={18} /></span><span className="brand-text">{tr("signal")}<span>{tr("ai")}</span></span></div>
      <div className="login-heading"><span className="login-icon"><LockKeyhole size={20} /></span><h2>{tr("Welcome back")}</h2><p>{tr("Sign in to your monitoring workspace.")}</p></div>
      {toast && <div className="inline-alert"><AlertCircle size={16} />{toast.message}</div>}
      <form onSubmit={(event) => onSubmit(event, user, password)} className="login-form">
        <label>{tr("Username")}<input value={user} onChange={(event) => setUser(event.target.value)} autoComplete="username" required /></label>
        <label>{tr("Password")}<div className="password-input"><input type={visible ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required /><button type="button" aria-label={tr(visible ? 'Hide password' : 'Show password')} onClick={() => setVisible((open) => !open)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button></div></label>
        <button className="button primary full flex items-center gap-2" type="submit">{tr("Sign in ")}<ArrowUpRight size={16} /></button>
      </form><div className="login-security"><ShieldCheck size={15} /> {tr("Secure session · Your credentials stay private")}</div>
      </div><div className="login-side-footer">{tr("© ")}{new Date().getFullYear()} {tr("Signal AI ")}<span>{tr("·")}</span> {tr("AI API Observability")}</div></div>
  </div>;
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="page-eyebrow">{tr(eyebrow ?? 'MONITORING')}</div><h1>{tr(title)}</h1>{description && <p>{tr(description)}</p>}</div>{action && <div className="heading-action">{action}</div>}</div>;
}

function DashboardPage({ models, summary, incidents, onOpen, onModels, onProvider }: { models: Model[]; summary: Summary | null; incidents: Incident[]; onOpen: (id: string) => void; onModels: () => void; onProvider: () => void }) {
  const active = models.filter((model) => model.enabled);
  const healthyPercent = active.length ? ((active.filter((model) => ['UP', 'SLOW'].includes(model.current_status)).length / active.length) * 100) : 0;
  const providerCount = new Set(active.map((model) => model.provider_id)).size;
  return <>
    <PageHeading eyebrow="YOUR AI INFRASTRUCTURE" title={tr("System overview")} description="A real-time pulse check across your AI model providers."
      action={<button className="button primary" onClick={onProvider}><Plus size={16} /> {tr("Add provider")}</button>} />
    <div className="hero-panel"><div className="hero-grid" /><div className="hero-copy"><div className="hero-kicker"><span className="pulse-dot" /> {tr("YOUR MONITOR IS RUNNING")}</div><h2>{tr(healthyPercent >= 99 ? 'Everything is looking good.' : healthyPercent >= 80 ? 'Your APIs are mostly healthy.' : 'Some models need your attention.')}</h2><p>{getLanguage() === 'zh-CN' ? `正在监控 ${active.length} 个模型端点，来自 ${providerCount} 个服务商。` : `Watching ${active.length} live endpoint${active.length === 1 ? '' : 's'} across ${providerCount} provider${providerCount === 1 ? '' : 's'}.`}</p>
      <div className="hero-metrics"><div><strong>{summary?.up ?? 0}</strong><span>{tr("operational")}</span></div><i /><div><strong>{summary?.slow ?? 0}</strong><span>{tr("degraded")}</span></div><i /><div><strong>{summary?.down ?? 0}</strong><span>{tr("down")}</span></div></div></div>
      <div className="hero-ring"><div className="ring-glow" /><div className="ring-content"><strong>{summary?.uptime24h == null ? '—' : `${summary.uptime24h.toFixed(1)}%`}</strong><span>{tr("24H UPTIME")}</span></div><div className="ring-caption">{summary?.failed24h ?? 0} {tr("failed checks")}<br />{tr("in the last day")}</div></div>
    </div>
    <section className="stats-grid">
      <StatCard label="Total models" value={summary?.totalModels ?? 0} hint={`${summary?.disabled ?? 0} disabled`} icon={<Radio size={17} />} tone="violet" />
      <StatCard label="Operational" value={summary?.up ?? 0} hint={`${summary?.uptime24h?.toFixed(2) ?? '—'}% uptime in 24h`} icon={<CheckCheck size={17} />} tone="green" />
      <StatCard label="Avg. latency" value={summary?.averageLatency == null ? '—' : formatMs(summary.averageLatency)} hint={`${summary?.requests24h ?? 0} checks in 24h`} icon={<Gauge size={17} />} tone="blue" />
      <StatCard label="Active incidents" value={incidents.filter((incident) => !incident.resolved_at).length} hint={`${incidents.filter((incident) => incident.resolved_at).length} resolved`} icon={<TriangleAlert size={17} />} tone={incidents.some((incident) => !incident.resolved_at) ? 'orange' : 'green'} />
    </section>
    <section className="section-block"><div className="section-heading"><div><h2>{tr("Model health")}</h2><p>{tr("The current availability of every monitored model.")}</p></div><button className="text-button" onClick={onModels}>{tr("View all models ")}<ChevronRight size={15} /></button></div>
      {models.length ? <ModelList models={models.slice(0, 6)} onOpen={onOpen} /> : <EmptyState icon={<Radio size={21} />} title={tr("No models being monitored")} description="Add a provider to start your first real API health check." action={<button className="button primary" onClick={onProvider}><Plus size={16} /> {tr("Add your first provider")}</button>} />}
    </section>
    <section className="section-block incidents-preview"><div className="section-heading"><div><h2>{tr("Recent incidents")}</h2><p>{tr("Service interruptions and latency events.")}</p></div></div>
      {incidents.length ? <div className="incident-list">{incidents.slice(0, 3).map((incident) => <IncidentRow key={incident.id} incident={incident} onClick={() => onOpen(incident.model_id)} />)}</div> : <div className="empty-inline"><CheckCheck size={18} /><span>{tr("No incidents recorded. It's been quiet.")}</span></div>}
    </section>
    <footer className="page-footer"><span>{tr("Signal AI Monitor")}</span><span>{tr("Checks run every minute via Cloudflare Workers Cron")}</span></footer>
  </>;
}

function StatCard({ label, value, hint, icon, tone }: { label: string; value: ReactNode; hint: string; icon: ReactNode; tone: string }) {
  return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><div className="stat-label">{tr(label)}</div><div className="stat-value">{value}</div><div className="stat-hint">{tr(hint)}</div></div>;
}

function StatusBadge({ status, small = false }: { status: Status | string; small?: boolean }) {
  return <span className={`status-badge ${String(status).toLowerCase()} ${small ? 'small' : ''}`}><i className="status-dot" />{tr(statusLabels[status] ?? status)}</span>;
}

function formatMs(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)}s` : `${Math.round(value)}ms`;
}
function formatDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const minutes = Math.floor(value / 60_000);
  if (minutes < 1) return `${Math.round(value / 1000)}${getLanguage() === 'zh-CN' ? '秒' : 's'}`;
  if (minutes < 60) return `${minutes}${getLanguage() === 'zh-CN' ? '分钟' : 'm'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return getLanguage() === 'zh-CN' ? `${hours}小时 ${minutes % 60}分钟` : `${hours}h ${minutes % 60}m`;
  return getLanguage() === 'zh-CN' ? `${Math.floor(hours / 24)}天 ${hours % 24}小时` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}
function formatJson(value: string): string {
  try { return JSON.stringify(JSON.parse(value) as unknown, null, 2); } catch { return value; }
}function timeAgo(date: string | null | undefined): string {
  if (!date) return tr('Never checked');
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 1000));
  if (seconds < 45) return tr('Just now');
  if (seconds < 3600) return getLanguage() === 'zh-CN' ? `${Math.floor(seconds / 60)} 分钟前` : `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return getLanguage() === 'zh-CN' ? `${Math.floor(seconds / 3600)} 小时前` : `${Math.floor(seconds / 3600)}h ago`;
  return getLanguage() === 'zh-CN' ? `${Math.floor(seconds / 86400)} 天前` : `${Math.floor(seconds / 86400)}d ago`;
}
function dateTime(date: string | null | undefined): string {
  return date ? new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date)) : '—';
}

function ModelList({ models, onOpen }: { models: Model[]; onOpen: (id: string) => void }) {
  return <div className="model-list">{models.map((model) => <button className="model-row" key={model.id} onClick={() => onOpen(model.id)}>
    <span className={`model-provider-mark ${model.api_type}`}><ProviderGlyph type={model.api_type} /></span>
    <span className="model-row-main"><strong>{model.name}</strong><span>{model.provider_name} <b>{tr("·")}</b> {tr(apiTypeLabels[model.api_type])}</span></span>
    <span className="model-row-latency"><strong>{model.last_latency_ms == null ? '—' : formatMs(model.last_latency_ms)}</strong><span>{timeAgo(model.last_checked_at)}</span></span>
    <StatusBadge status={model.enabled ? model.current_status : 'DISABLED'} />
    <ChevronRight className="row-chevron" size={16} />
  </button>)}</div>;
}

function ProviderGlyph({ type }: { type: string }) {
  return <span>{type === 'openai' ? '◉' : type === 'gemini' ? '✦' : type === 'anthropic' ? 'A' : '↗'}</span>;
}

function ModelsPage({ models, providers, onBatch, onCheck, onOpen }: { models: Model[]; providers: Provider[]; onBatch: (action: string, ids: string[]) => void; onCheck: (id: string) => void; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [provider, setProvider] = useState('all');
  const [type, setType] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const filtered = useMemo(() => models.filter((model) => `${model.name} ${model.provider_name}`.toLowerCase().includes(query.toLowerCase()) &&
    (status === 'all' || (status === 'DISABLED' ? !model.enabled : model.current_status === status)) && (provider === 'all' || model.provider_id === provider) && (type === 'all' || model.api_type === type)), [models, query, status, provider, type]);
  const allSelected = filtered.length > 0 && filtered.every((model) => selected.includes(model.id));
  return <>
    <PageHeading eyebrow="ENDPOINTS" title={tr("Models")} description="Monitor model availability, response time and recent health." />
    <div className="filter-toolbar"><div className="search-field"><Search size={16} /><input placeholder={tr("Search models or providers")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <select value={provider} onChange={(event) => setProvider(event.target.value)}><option value="all">{tr("All providers")}</option>{providers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <select value={type} onChange={(event) => setType(event.target.value)}><option value="all">{tr("All API types")}</option>{Object.entries(apiTypeLabels).map(([key, value]) => <option key={key} value={key}>{tr(value)}</option>)}</select>
      <select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">{tr("All statuses")}</option>{['UP', 'SLOW', 'DOWN', 'TIMEOUT', 'ERROR', 'DEGRADED', 'UNKNOWN', 'DISABLED'].map((item) => <option key={item} value={item}>{tr(statusLabels[item])}</option>)}</select>
    </div>
    {selected.length > 0 && <div className="bulk-toolbar"><span>{selected.length} {tr("selected")}</span><button onClick={() => onBatch('enable', selected)}>{tr("Enable")}</button><button onClick={() => onBatch('disable', selected)}>{tr("Disable")}</button><button onClick={() => onBatch('check', selected)}>{tr("Force check")}</button><button className="danger-text" onClick={() => onBatch('delete', selected)}>{tr("Delete")}</button><button className="bulk-clear" onClick={() => setSelected([])}>{tr("Clear")}</button></div>}
    <div className="data-card"><div className="list-heading"><label className="checkbox-control"><input type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? [] : filtered.map((model) => model.id))} /><span /></label><span>{tr("MODEL / PROVIDER")}</span><span>{tr("STATUS")}</span><span>{tr("LATENCY")}</span><span>{tr("LAST CHECKED")}</span><span>{tr("ACTIONS")}</span></div>
      {filtered.map((model) => <div className="data-row" key={model.id}><label className="checkbox-control"><input type="checkbox" checked={selected.includes(model.id)} onChange={() => setSelected((items) => items.includes(model.id) ? items.filter((id) => id !== model.id) : [...items, model.id])} /><span /></label>
        <button className="data-model" onClick={() => onOpen(model.id)}><span className={`model-provider-mark ${model.api_type}`}><ProviderGlyph type={model.api_type} /></span><span><strong>{model.name}</strong><small>{model.provider_name} <b>{tr("·")}</b> {tr(apiTypeLabels[model.api_type])}</small></span></button>
        <div><StatusBadge status={model.enabled ? model.current_status : 'DISABLED'} small /></div><strong className="data-latency">{model.last_latency_ms == null ? '—' : formatMs(model.last_latency_ms)}</strong><span className="muted-text">{timeAgo(model.last_checked_at)}</span>
        <div className="data-actions"><button className="icon-button tiny" title={tr("Force check")} onClick={() => onCheck(model.id)}><RefreshCw size={15} /></button><button className="icon-button tiny" title={tr("Open details")} onClick={() => onOpen(model.id)}><ChevronRight size={16} /></button></div>
      </div>)}
      {!filtered.length && <EmptyState icon={<Search size={19} />} title={tr("No matching models")} description={models.length ? 'Try another search or filter.' : 'Add a provider to start monitoring models.'} />}
      <div className="list-footer">{tr("Showing ")}{filtered.length} {tr("of ")}{models.length} {tr("models ")}<span>{tr("Checks are sampled at each model's configured interval")}</span></div>
    </div>
  </>;
}

function ProvidersPage({ providers, onAdd, onEdit, onRefresh, notify }: { providers: Provider[]; onAdd: () => void; onEdit: (provider: Provider) => void; onRefresh: () => void; notify: (message: string, kind?: 'success' | 'error') => void }) {
  async function remove(provider: Provider) {
    if (!window.confirm(`Delete ${provider.name} and its model history? This cannot be undone.`)) return;
    try { await api(`/api/providers/${provider.id}`, { method: 'DELETE' }); onRefresh(); notify(`${provider.name} deleted.`); }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not delete provider.', 'error'); }
  }
  return <>
    <PageHeading eyebrow="CONNECTIONS" title={tr("Providers")} description="Connect your AI APIs and configure exactly how each model is probed."
      action={<button className="button primary" onClick={onAdd}><Plus size={16} /> {tr("Add provider")}</button>} />
    <div className="provider-note"><KeyRound size={16} /><span><strong>{tr("Your API keys are encrypted at rest.")}</strong> {tr("They are never returned to the browser after saving.")}</span><ShieldCheck size={15} className="note-check" /></div>
    {providers.length ? <div className="provider-grid">{providers.map((provider) => <div className="provider-card" key={provider.id}>
      <div className="provider-card-top"><span className={`provider-logo ${provider.api_type}`}><ProviderGlyph type={provider.api_type} /></span><span className="provider-card-label"><strong>{provider.name}</strong><span>{tr(apiTypeLabels[provider.api_type])}</span></span><button className="icon-button tiny" title={tr("More provider actions")} onClick={() => onEdit(provider)}><MoreHorizontal size={18} /></button></div>
      <div className="provider-card-model"><span className={`status-dot ${provider.model?.current_status?.toLowerCase() ?? 'unknown'}`} /> <span>{provider.model?.name ?? tr('No model configured')}</span><StatusBadge status={provider.model?.enabled ? provider.model?.current_status ?? 'UNKNOWN' : 'DISABLED'} small /></div>
      <div className="provider-card-url" title={provider.base_url}><Globe2 size={13} />{provider.base_url}</div>
      <div className="provider-card-footer"><span>{provider.apiKeySet ? <><KeyRound size={13} /> {provider.keyHint}</> : <><CircleHelp size={13} /> {tr("No API key")}</>}</span><div><button className="text-button compact" onClick={() => onEdit(provider)}>{tr("Edit")}</button><button className="icon-button tiny danger-hover" title={tr("Delete provider")} onClick={() => void remove(provider)}><Trash2 size={14} /></button></div></div>
    </div>)}</div> : <EmptyState icon={<Globe2 size={20} />} title={tr("No providers connected")} description="Connect an OpenAI-compatible API, Gemini, Anthropic or a custom endpoint." action={<button className="button primary" onClick={onAdd}><Plus size={16} /> {tr("Connect your first provider")}</button>} />}
  </>;
}

type ProviderDraft = Record<string, string | number | boolean>;
const intervalPresets: Array<[number, string]> = [[60, '1 minute'], [120, '2 minutes'], [300, '5 minutes'], [600, '10 minutes'], [900, '15 minutes'], [1800, '30 minutes'], [3600, '1 hour'], [21600, '6 hours'], [43200, '12 hours'], [86400, '24 hours']];
const floatingPresets = [10, 20, 30, 50, 100];
const defaultDraft: ProviderDraft = {
  name: '', apiType: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: '', model: '', intervalSeconds: 300,
  jitterSeconds: 0, timeoutMs: 15000, prompt: 'Reply with exactly: OK', maxTokens: 5, temperature: 0,
  warningLatencyMs: 3000, criticalLatencyMs: 8000, floatingEnabled: false, floatingPercent: 50, baselineMethod: 'trimmed_average', baselineSamples: 20,
  failureThreshold: 3, recoveryThreshold: 2, actualCall: true, enabled: true, method: 'POST', path: '', body: '', expectedStatus: '200', responsePath: '',
};

function ProviderModal({ provider, onClose, onSaved, notify }: { provider: Provider | null; onClose: () => void; onSaved: (message: string) => void; notify: (message: string, kind?: 'success' | 'error') => void }) {
  const [draft, setDraft] = useState<ProviderDraft>(() => {
    const model = provider?.model;
    return provider ? {
      ...defaultDraft, name: provider.name, apiType: provider.api_type, baseUrl: provider.base_url, apiKey: '', model: model?.name ?? '',
      intervalSeconds: model?.interval_seconds ?? 300, jitterSeconds: (model as any)?.jitter_seconds ?? 0, timeoutMs: (model as any)?.timeout_ms ?? 15000,
      prompt: (model as any)?.prompt ?? defaultDraft.prompt, maxTokens: (model as any)?.max_tokens ?? 5, temperature: (model as any)?.temperature ?? 0,
      warningLatencyMs: model?.warning_latency_ms ?? 3000, criticalLatencyMs: model?.critical_latency_ms ?? 8000,
      floatingEnabled: Boolean((model as any)?.floating_enabled), floatingPercent: (model as any)?.floating_percent ?? 50, baselineMethod: (model as any)?.baseline_method ?? 'trimmed_average',
      baselineSamples: (model as any)?.baseline_samples ?? 20, failureThreshold: (model as any)?.failure_threshold ?? 3, recoveryThreshold: (model as any)?.recovery_threshold ?? 2,
      actualCall: Boolean((model as any)?.actual_call ?? true), enabled: Boolean(model?.enabled ?? true), method: provider.custom_method, path: provider.custom_path,
      body: provider.custom_body, expectedStatus: JSON.parse(provider.expected_status_json || '[200]').join(','), responsePath: provider.response_path,
    } : defaultDraft;
  });
  const [customInterval, setCustomInterval] = useState(() => Boolean(provider?.model && !intervalPresets.some(([seconds]) => seconds === provider.model?.interval_seconds)));
  const [customFloating, setCustomFloating] = useState(() => Boolean(provider?.model && !floatingPresets.includes((provider.model as any).floating_percent ?? 50)));
  const [headersText, setHeadersText] = useState(() => JSON.stringify(provider?.headers ?? {}, null, 2));
  const [tab, setTab] = useState<'basic' | 'advanced'>('basic');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<Record<string, any> | null>(null);
  const change = (key: string, value: string | number | boolean) => setDraft((current) => ({ ...current, [key]: value }));
  const val = (key: string) => typeof draft[key] === 'boolean' ? '' : draft[key] as string | number;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const headers = JSON.parse(headersText || '{}') as Record<string, string>;
      const payload = { ...draft, providerId: provider?.id, headers, expectedStatus: String(val('expectedStatus')).split(',').map((item) => Number(item.trim())).filter(Boolean) };
      await api(provider ? `/api/providers/${provider.id}` : '/api/providers', { method: provider ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      onSaved(provider ? 'Provider updated.' : 'Provider added and ready to monitor.');
    } catch (error) { notify(error instanceof Error ? error.message : 'Could not save provider.', 'error'); }
    finally { setSaving(false); }
  }

  async function testConnection() {
    setTesting(true); setTestResult(null);
    try {
      const headers = JSON.parse(headersText || '{}') as Record<string, string>;
      const result = await api<Record<string, any>>('/api/providers/test', { method: 'POST', body: JSON.stringify({ ...draft, providerId: provider?.id, headers, expectedStatus: String(val('expectedStatus')).split(',').map((item) => Number(item.trim())).filter(Boolean) }) });
      setTestResult(result);
    } catch (error) { setTestResult({ success: false, error: error instanceof Error ? error.message : 'Connection test failed.' }); }
    finally { setTesting(false); }
  }

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="modal provider-editor" role="dialog" aria-modal="true" aria-labelledby="provider-modal-title">
    <div className="modal-header"><div><div className="page-eyebrow">{tr(provider ? 'CONFIGURATION' : 'NEW CONNECTION')}</div><h2 id="provider-modal-title">{tr(provider ? 'Edit provider' : 'Add provider')}</h2></div><button className="icon-button" onClick={onClose} aria-label={tr("Close")}><X size={18} /></button></div>
    <div className="editor-tabs"><button className={tab === 'basic' ? 'selected' : ''} onClick={() => setTab('basic')}>{tr("Basic setup")}</button><button className={tab === 'advanced' ? 'selected' : ''} onClick={() => setTab('advanced')}>{tr("Advanced")}</button></div>
    <form onSubmit={submit}>
      <div className="modal-body">
        {tab === 'basic' ? <div className="form-grid">
          <label className="span-2">{tr("Provider name")}<input value={val('name')} onChange={(event) => change('name', event.target.value)} placeholder={tr("e.g. OpenRouter Production")} required /></label>
          <label>{tr("API type")}<select value={val('apiType')} onChange={(event) => { change('apiType', event.target.value); if (event.target.value === 'gemini') change('baseUrl', 'https://generativelanguage.googleapis.com/v1beta'); else if (event.target.value === 'anthropic') change('baseUrl', 'https://api.anthropic.com'); else if (event.target.value === 'openai') change('baseUrl', 'https://api.openai.com/v1'); }}><option value="openai">{tr("OpenAI Compatible")}</option><option value="gemini">{tr("Gemini")}</option><option value="anthropic">{tr("Anthropic")}</option><option value="custom">{tr("Custom API")}</option></select></label>
          <label>{tr("Model name")}<input value={val('model')} onChange={(event) => change('model', event.target.value)} placeholder={tr("e.g. gpt-4o-mini")} required /></label>
          <label className="span-2">{tr("API base URL")}<input type="url" value={val('baseUrl')} onChange={(event) => change('baseUrl', event.target.value)} placeholder={tr("https://api.example.com/v1")} required /><small>{tr("HTTPS is required for public endpoints. API paths are appended automatically.")}</small></label>
          <label className="span-2">{tr("API key ")}<input type="password" value={val('apiKey')} onChange={(event) => change('apiKey', event.target.value)} placeholder={provider?.keyHint ? getLanguage() === 'zh-CN' ? `已加密保存 · ${provider.keyHint} · 留空表示不修改` : `Saved securely · ${provider.keyHint} · leave blank to keep` : tr('Paste your API key')} autoComplete="new-password" /><small>{tr("Sent once, encrypted before storage, and never shown again.")}</small></label>
          <div className="form-separator span-2"><span>{tr("CHECK BEHAVIOR")}</span></div>
          <label>{tr("Check interval")}<select value={customInterval ? 'custom' : String(val('intervalSeconds'))} onChange={(event) => { if (event.target.value === 'custom') setCustomInterval(true); else { setCustomInterval(false); change('intervalSeconds', Number(event.target.value)); } }}>{intervalPresets.map(([seconds, label]) => <option key={seconds} value={seconds}>{tr(label)}</option>)}<option value="custom">{tr("Custom interval")}</option></select></label>
          {customInterval && <label>{tr("Custom interval (seconds)")}<input type="number" min="60" max="86400" step="1" value={val('intervalSeconds')} onChange={(event) => change('intervalSeconds', Number(event.target.value))} /><small>{tr("Choose any interval from 60 seconds to 24 hours.")}</small></label>}
          <label>{tr("Timeout")}<select value={val('timeoutMs')} onChange={(event) => change('timeoutMs', Number(event.target.value))}>{[[5000, '5 seconds'], [10000, '10 seconds'], [15000, '15 seconds'], [30000, '30 seconds'], [60000, '60 seconds'], [120000, '120 seconds']].map(([ms, label]) => <option value={ms} key={ms}>{tr(String(label))}</option>)}</select></label>
          <label>{tr("Warning latency")}<input type="number" min="1" value={val('warningLatencyMs')} onChange={(event) => change('warningLatencyMs', Number(event.target.value))} /><small>{tr("Requests above this mark as slow.")}</small></label>
          <label>{tr("Critical latency")}<input type="number" min="2" value={val('criticalLatencyMs')} onChange={(event) => change('criticalLatencyMs', Number(event.target.value))} /><small>{tr("Requests above this count as an outage.")}</small></label>
          <label className="span-2">{tr("Detection prompt")}<textarea rows={2} value={val('prompt')} onChange={(event) => change('prompt', event.target.value)} /></label>
        </div> : <div className="form-grid">
          <label className="span-2">{tr("Custom request method")}<select value={val('method')} onChange={(event) => change('method', event.target.value)}><option>{tr("POST")}</option><option>{tr("GET")}</option><option>{tr("PUT")}</option><option>{tr("PATCH")}</option></select></label>
          <label className="span-2">{tr("Custom path")}<input value={val('path')} onChange={(event) => change('path', event.target.value)} placeholder={tr("/chat/completions")} /><small>{tr("Relative to the base URL. Use ")}{'{{model}}'}{tr(", ")}{'{{prompt}}'}{tr(", and ")}{'{{max_tokens}}'} {tr("in body.")}</small></label>
          <label className="span-2">{tr("Custom request body")}<textarea rows={5} value={val('body')} onChange={(event) => change('body', event.target.value)} placeholder={provider?.customBodySet ? 'A request body is saved encrypted. Leave blank to keep it or enter a replacement.' : '{"model":"{{model}}","messages":[{"role":"user","content":"{{prompt}}"}],"max_tokens":{{max_tokens}}}'} /><small>{tr("Saved custom bodies are encrypted and are not returned to the browser.")}</small></label>
          <label className="span-2">{tr("Custom headers (JSON)")}<textarea rows={4} value={headersText} onChange={(event) => setHeadersText(event.target.value)} placeholder={'{"HTTP-Referer":"https://example.com","X-Title":"My App"}'} /><small>{tr("Authorization, API key, token and cookie header values are encrypted separately.")}</small></label>
          <label>{tr("Expected HTTP status")}<input value={val('expectedStatus')} onChange={(event) => change('expectedStatus', event.target.value)} placeholder={tr("200, 201")} /></label>
          <label>{tr("Response text path")}<input value={val('responsePath')} onChange={(event) => change('responsePath', event.target.value)} placeholder={tr("choices[0].message.content")} /></label>
          <label>{tr("Max output tokens")}<input type="number" min="1" max="4096" value={val('maxTokens')} onChange={(event) => change('maxTokens', Number(event.target.value))} /></label>
          <label>{tr("Temperature")}<input type="number" min="0" max="2" step="0.1" value={val('temperature')} onChange={(event) => change('temperature', Number(event.target.value))} /></label>
          <label>{tr("Request jitter (± seconds)")}<input type="number" min="0" value={val('jitterSeconds')} onChange={(event) => change('jitterSeconds', Number(event.target.value))} /></label>
          <label>{tr("Failure threshold")}<select value={val('failureThreshold')} onChange={(event) => change('failureThreshold', Number(event.target.value))}>{[1, 2, 3, 5, 10].map((value) => <option key={value} value={value}>{value} {tr("consecutive failures")}</option>)}</select></label>
          <label>{tr("Recovery threshold")}<select value={val('recoveryThreshold')} onChange={(event) => change('recoveryThreshold', Number(event.target.value))}>{[1, 2, 3, 5, 10].map((value) => <option key={value} value={value}>{value} {tr("consecutive successes")}</option>)}</select></label>
          <label>{tr("Floating baseline")}<select value={val('baselineMethod')} onChange={(event) => change('baselineMethod', event.target.value)}><option value="trimmed_average">{tr("Trimmed average (recommended)")}</option><option value="rolling_average">{tr("Rolling average")}</option><option value="median">{tr("Median")}</option><option value="p95">{tr("P95")}</option></select></label>
          <label>{tr("Baseline samples")}<input type="number" min="5" max="500" value={val('baselineSamples')} onChange={(event) => change('baselineSamples', Number(event.target.value))} /></label>
          <label>{tr("Floating threshold (%)")}<select value={customFloating ? 'custom' : String(val('floatingPercent'))} onChange={(event) => { if (event.target.value === 'custom') setCustomFloating(true); else { setCustomFloating(false); change('floatingPercent', Number(event.target.value)); } }}>{floatingPresets.map((value) => <option key={value} value={value}>{value}{tr("% above baseline")}</option>)}<option value="custom">{tr("Custom percentage")}</option></select></label>
          {customFloating && <label>{tr("Custom threshold (%)")}<input type="number" min="1" max="1000" step="0.1" value={val('floatingPercent')} onChange={(event) => change('floatingPercent', Number(event.target.value))} /></label>}
          <label className="toggle-line"><input type="checkbox" checked={draft.floatingEnabled === true} onChange={(event) => change('floatingEnabled', event.target.checked)} /><span className="toggle-ui" /><span>{tr("Enable dynamic latency threshold")}</span></label>
          <label className="toggle-line"><input type="checkbox" checked={draft.actualCall === true} onChange={(event) => change('actualCall', event.target.checked)} /><span className="toggle-ui" /><span>{tr("Make a real model request")}</span></label>
          <label className="toggle-line"><input type="checkbox" checked={draft.enabled === true} onChange={(event) => change('enabled', event.target.checked)} /><span className="toggle-ui" /><span>{tr("Enable scheduled checks")}</span></label>
        </div>}
      {testResult && <div className={`test-result ${testResult.success ? 'success' : 'error'}`}><div className="test-result-heading">{testResult.success ? <Check size={16} /> : <AlertCircle size={16} />}{testResult.success ? tr('Connection successful') : tr('Connection failed')}<span>{testResult.statusCode ? `HTTP ${testResult.statusCode}` : ''}</span></div>
          <p>{testResult.error ?? `${formatMs(testResult.latency)} response${testResult.ttft == null ? '' : ` · ${formatMs(testResult.ttft)} TTFT`}${testResult.response ? ` · “${testResult.response}”` : ''}`}</p>{testResult.errorType && <small>{testResult.errorType}</small>}</div>}
      </div>
      <div className="modal-footer"><button type="button" className="button secondary" onClick={onClose}>{tr("Cancel")}</button><button type="button" className="button outline" onClick={testConnection} disabled={testing || !val('baseUrl') || !val('model')}><Zap size={15} />{testing ? tr('Testing…') : tr('Test connection')}</button><button className="button primary" type="submit" disabled={saving}>{saving ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}{provider ? tr('Save changes') : tr('Add provider')}</button></div>
    </form>
  </div></div>;
}

function ModelDetail({ model, checks, range, setRange, onBack, onCheck, loading }: { model: Record<string, any>; checks: CheckRecord[]; range: string; setRange: (range: string) => void; onBack: () => void; onCheck: () => void; loading: boolean }) {
  const stats = model.stats?.stats ?? {};
  const selectedStats = stats[range] ?? stats['24h'];
  const graph = [...checks].map((check) => ({ time: new Date(check.checked_at).getTime(), label: new Date(check.checked_at).toLocaleString(), latency: check.latency_ms, success: check.available === 1 ? 1 : check.available === 0 ? 0 : null }));
  const uptime = stats[range]?.uptime;
  const hourlyBars = [...checks].slice(-48);
  return <>
    <button className="back-link" onClick={onBack}><ChevronLeft size={16} /> {tr("All models")}</button>
    <div className="detail-heading"><div className={`model-provider-mark large ${model.api_type}`}><ProviderGlyph type={model.api_type} /></div><div className="detail-heading-main"><div className="detail-breadcrumb">{model.provider_name} <ChevronRight size={13} /> {tr(apiTypeLabels[model.api_type])}</div><h1>{model.name}</h1><div className="detail-heading-meta"><StatusBadge status={model.enabled ? model.current_status : 'DISABLED'} /><span>{tr("Last checked ")}{timeAgo(model.last_checked_at)}</span><span className="meta-divider">{tr("·")}</span><span>{tr("Every ")}{formatInterval(model.interval_seconds)}</span></div></div>
      <div className="detail-actions"><button className="button secondary" onClick={() => void onCheck()}><RefreshCw size={15} /> {tr("Run check")}</button></div></div>
    <div className="detail-stat-grid">
      <DetailStat label="CURRENT LATENCY" value={model.last_latency_ms == null ? '—' : formatMs(model.last_latency_ms)} hint={`TTFT ${model.stats?.['24h']?.averageTtft == null ? '—' : formatMs(model.stats['24h'].averageTtft)}`} icon={<Gauge size={15} />} />
      <DetailStat label={`${tr(rangeLabels[range] ?? range)} ${tr('uptime')}`} value={uptime == null ? '—' : `${uptime.toFixed(2)}%`} hint={getLanguage() === 'zh-CN' ? `${selectedStats?.success ?? 0}/${selectedStats?.requests ?? 0} 次成功 · 停机 ${formatDuration(selectedStats?.downtimeMs)}` : `${selectedStats?.success ?? 0}/${selectedStats?.requests ?? 0} successful · ${formatDuration(selectedStats?.downtimeMs)} downtime`} icon={<Activity size={15} />} />
      <DetailStat label="AVERAGE RESPONSE" value={selectedStats?.averageLatency == null ? '—' : formatMs(selectedStats.averageLatency)} hint={`Median ${formatMs(selectedStats?.medianLatency)}`} icon={<ArrowUpRight size={15} />} />
      <DetailStat label="P95 / P99" value={`${formatMs(selectedStats?.p95Latency)} / ${formatMs(selectedStats?.p99Latency)}`} hint={`Max ${formatMs(selectedStats?.maxLatency)}`} icon={<ArrowDownRight size={15} />} />
    </div>
    <section className="chart-panel"><div className="chart-header"><div><h2>{tr("Response time")}</h2><p>{tr("Model latency and time to first token.")}</p></div><div className="segmented">{Object.keys(rangeLabels).map((key) => <button key={key} className={range === key ? 'active' : ''} onClick={() => setRange(key)}>{tr(rangeLabels[key])}</button>)}</div></div>
      {loading ? <div className="chart-loading"><LoaderCircle className="spin" size={18} /></div> : graph.length ? <LatencyChart points={graph} warning={model.warning_latency_ms} critical={model.critical_latency_ms} range={range} /> : <div className="chart-empty"><Activity size={19} /><span>{tr("Latency history will appear after the next check.")}</span></div>}
      <div className="chart-legend"><span><i className="legend-line" /> {tr("Response latency")}</span><span><i className="legend-dot" /> {tr("Warning at ")}{formatMs(model.warning_latency_ms)} <b /> {tr("Critical at ")}{formatMs(model.critical_latency_ms)}</span></div></section>
    <section className="detail-bottom-grid"><div className="section-card availability-card"><div className="section-heading compact-heading"><div><h2>{tr("Availability history")}</h2><p>{tr("Each square represents one model check.")}</p></div><span className="uptime-current">{uptime == null ? '—' : `${uptime.toFixed(2)}%`}</span></div><div className="availability-bars">{hourlyBars.length ? hourlyBars.map((check) => <span key={check.id} className={`availability-square ${check.available === 1 ? 'good' : check.available === 0 ? 'bad' : 'unknown'}`} title={`${dateTime(check.checked_at)} · ${check.status}${check.latency_ms == null ? '' : ` · ${formatMs(check.latency_ms)}`}`} />) : <span className="muted-text">{tr("Waiting for the first check.")}</span>}</div><div className="availability-legend"><span><i className="green-dot" /> {tr("Operational")}</span><span><i className="red-dot" /> {tr("Failed")}</span></div></div>
      <div className="section-card thresholds-card"><div className="section-heading compact-heading"><div><h2>{tr("Latency thresholds")}</h2><p>{tr("Fixed response time limits.")}</p></div></div><div className="threshold-line"><span className="threshold-marker warning" /><span>{tr("Warning after")}</span><strong>{formatMs(model.warning_latency_ms)}</strong></div><div className="threshold-line"><span className="threshold-marker critical" /><span>{tr("Critical after")}</span><strong>{formatMs(model.critical_latency_ms)}</strong></div><div className="detail-quiet-note"><ShieldCheck size={14} /> {tr("State changes require ")}{model.failure_threshold} {tr("failed / ")}{model.recovery_threshold} {tr("successful checks.")}</div></div></section>
    <section className="section-block detail-history"><div className="section-heading"><div><h2>{tr("Recent checks")}</h2><p>{tr("Detailed responses are retained for ")}{model.settings?.retentionDays ?? 14} {tr("days.")}</p></div></div>{checks.length ? <div className="data-card history-list">{[...checks].reverse().slice(0, 12).map((check) => <details className="history-entry" key={check.id}><summary className="history-row"><span className={`status-dot ${check.available === 1 ? (check.status === 'SLOW' ? 'slow' : 'up') : check.available === null ? 'unknown' : 'down'}`} /><span>{dateTime(check.checked_at)}</span><StatusBadge status={check.status} small /><span>{check.status_code ? `HTTP ${check.status_code}` : '—'}</span><strong>{formatMs(check.latency_ms)}</strong><span className="history-error">{check.error_message ?? check.response_preview ?? 'Open check details'}</span><ChevronDown className="history-chevron" size={14} /></summary><div className="history-detail-grid"><div><span>{tr("Status code")}</span><strong>{check.status_code ?? '—'}</strong></div><div><span>{tr("Error type")}</span><strong>{check.error_type ?? '—'}</strong></div><div><span>{tr("Request duration")}</span><strong>{formatMs(check.latency_ms)}</strong></div><div><span>{tr("TTFT")}</span><strong>{formatMs(check.ttft_ms)}</strong></div><div><span>{tr("Timed out")}</span><strong>{check.timed_out ? 'Yes' : 'No'}</strong></div><div><span>{tr("Response size")}</span><strong>{check.response_size} {tr("bytes")}</strong></div><div className="history-detail-wide"><span>{tr("Checked at")}</span><strong>{dateTime(check.checked_at)}</strong></div>{check.error_message && <div className="history-detail-wide"><span>{tr("Error message")}</span><p>{check.error_message}</p></div>}{check.error_headers_json && <div className="history-detail-wide"><span>{tr("Response headers")}</span><pre>{formatJson(check.error_headers_json)}</pre></div>}{(check.error_body || check.response_preview) && <div className="history-detail-wide"><span>{check.error_body ? 'Response body' : 'Model response'}</span><pre>{check.error_body ?? check.response_preview}</pre></div>}</div></details>)}</div> : <EmptyState icon={<Clock3 size={19} />} title={tr("No checks yet")} description="Run a check to start this model's history." />}</section>
    <section className="section-block"><div className="section-heading"><div><h2>{tr("Incidents")}</h2><p>{tr("Availability and degradation events for this model.")}</p></div></div>{model.incidents?.length ? <div className="incident-list">{model.incidents.slice(0, 10).map((incident: Incident) => <IncidentRow key={incident.id} incident={incident} />)}</div> : <div className="empty-inline"><CheckCheck size={18} /><span>{tr("No incidents recorded.")}</span></div>}</section>
  </>;
}

function DetailStat({ label, value, hint, icon }: { label: string; value: ReactNode; hint: string; icon: ReactNode }) {
  return <div className="detail-stat"><div className="detail-stat-label">{icon}{tr(label)}</div><strong>{value}</strong><span>{tr(hint)}</span></div>;
}
function formatInterval(seconds: number) { return getLanguage() === 'zh-CN' ? seconds < 3600 ? `${Math.round(seconds / 60)} 分钟` : seconds % 3600 ? `${(seconds / 3600).toFixed(1)} 小时` : `${seconds / 3600} 小时` : seconds < 3600 ? `${Math.round(seconds / 60)} min` : seconds % 3600 ? `${(seconds / 3600).toFixed(1)} hr` : `${seconds / 3600} hr`; }
function LatencyChart({ points, warning, critical, range }: { points: Array<{ time: number; label: string; latency: number | null; success: number | null }>; warning: number; critical: number; range: string }) {
  const width = 760, height = 235, left = 58, right = 12, top = 14, bottom = 31;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const highest = Math.max(warning, critical, ...points.map((point) => point.latency ?? 0), 10) * 1.12;
  const x = (index: number) => left + (points.length <= 1 ? plotWidth / 2 : index / (points.length - 1) * plotWidth);
  const y = (value: number) => top + (1 - Math.min(highest, value) / highest) * plotHeight;
  const segments: Array<Array<{ x: number; y: number }>> = [];
  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    if (point?.latency == null) continue;
    if (!segments.length || points[i - 1]?.latency == null) segments.push([]);
    segments[segments.length - 1]?.push({ x: x(i), y: y(point.latency) });
  }
  const path = segments.map((segment) => segment.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')).join(' ');
  const areaPath = segments.map((segment) => {
    if (!segment.length) return '';
    return `${segment.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')} L${segment.at(-1)?.x.toFixed(1)},${(top + plotHeight).toFixed(1)} L${segment[0]?.x.toFixed(1)},${(top + plotHeight).toFixed(1)} Z`;
  }).join(' ');
  const labels = [0, 0.5, 1].map((part) => ({ value: highest * (1 - part), y: top + plotHeight * part }));
  const xLabels = [0, .25, .5, .75, 1].map((part) => ({ index: Math.min(points.length - 1, Math.round((points.length - 1) * part)), x: left + plotWidth * part }));
  return <div className="chart-wrap"><svg className="latency-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={tr("Model response latency over time")} preserveAspectRatio="none">
    <defs><linearGradient id="latencyFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".22" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
    {labels.map((label) => <g key={label.y}><line x1={left} x2={width - right} y1={label.y} y2={label.y} className="svg-gridline" /><text x={left - 8} y={label.y + 3} textAnchor="end" className="svg-label">{formatMs(label.value)}</text></g>)}
    {[{ value: warning, cls: 'warning' }, { value: critical, cls: 'critical' }].filter((threshold) => threshold.value < highest).map((threshold) => <line key={threshold.cls} x1={left} x2={width - right} y1={y(threshold.value)} y2={y(threshold.value)} className={`svg-threshold ${threshold.cls}`} />)}
    <path d={areaPath} className="latency-area" /><path d={path} className="latency-line" />
    {points.map((point, index) => point.latency == null ? null : <circle key={`${point.time}-${index}`} cx={x(index)} cy={y(point.latency)} r={points.length < 20 ? 2.5 : 1.6} className={`latency-point ${point.success === 0 ? 'failure' : ''}`}><title>{point.label} {tr("· ")}{formatMs(point.latency)}{point.success === 0 ? ' · failed' : ''}</title></circle>)}
    {xLabels.map((label, index) => <text key={`${label.x}-${index}`} x={label.x} y={height - 7} textAnchor={index === 0 ? 'start' : index === 4 ? 'end' : 'middle'} className="svg-label">{points[label.index]?.time ? new Date(points[label.index].time).toLocaleString([], { hour: '2-digit', minute: '2-digit', ...(range.endsWith('d') ? { month: 'short', day: 'numeric' } : {}) }) : ''}</text>)}
  </svg></div>;
}

function IncidentRow({ incident, onClick }: { incident: Incident; onClick?: () => void }) {
  const start = Date.parse(incident.started_at);
  const end = incident.resolved_at ? Date.parse(incident.resolved_at) : Date.now();
  const minutes = Math.max(0, Math.floor((end - start) / 60_000));
  return <button className={`incident-row ${onClick ? 'clickable' : ''}`} onClick={onClick}><span className={`incident-icon ${incident.resolved_at ? 'resolved' : 'active'}`}>{incident.resolved_at ? <Check size={15} /> : <TriangleAlert size={15} />}</span>
    <span className="incident-main"><strong>{incident.title}</strong><span>{incident.provider_name} <b>{tr("·")}</b> {incident.model_name} <b>{tr("·")}</b> {dateTime(incident.started_at)}</span></span>
    <span className="incident-description">{tr(incident.error_type ?? statusLabels[incident.status])}{incident.status_code ? ` · HTTP ${incident.status_code}` : ''}{incident.error_message ? ` · ${incident.error_message}` : ''}</span>
    <span className="incident-duration">{incident.resolved_at ? getLanguage() === 'zh-CN' ? `${minutes}分钟` : `${minutes}m` : tr('Ongoing')}</span><StatusBadge status={incident.resolved_at ? 'UP' : incident.status} small />{onClick && <ChevronRight size={15} />}</button>;
}

function IncidentsPage({ incidents, onOpen }: { incidents: Incident[]; onOpen: (id: string) => void }) {
  const active = incidents.filter((incident) => !incident.resolved_at);
  const resolved = incidents.filter((incident) => incident.resolved_at);
  return <>
    <PageHeading eyebrow="RELIABILITY" title={tr("Incidents")} description="Every model outage, recovery and latency degradation in one timeline." />
    <div className="incident-summary"><div><span className="incident-summary-dot active" /><span>{tr("Active")}</span><strong>{active.length}</strong></div><div><span className="incident-summary-dot resolved" /><span>{tr("Resolved · last 30 days")}</span><strong>{resolved.filter((item) => Date.parse(item.started_at) > Date.now() - 30 * 86400_000).length}</strong></div><div><span className="incident-summary-dot" /><span>{tr("Total recorded")}</span><strong>{incidents.length}</strong></div></div>
    <div className="section-block"><div className="section-heading"><div><h2>{tr("Ongoing")}</h2><p>{tr("Issues that need attention right now.")}</p></div></div>{active.length ? <div className="incident-list elevated">{active.map((incident) => <IncidentRow key={incident.id} incident={incident} onClick={() => onOpen(incident.model_id)} />)}</div> : <div className="all-clear"><span className="all-clear-icon"><Check size={19} /></span><div><strong>{tr("No active incidents")}</strong><p>{tr("All monitored models are currently operational.")}</p></div></div>}</div>
    <div className="section-block"><div className="section-heading"><div><h2>{tr("Incident history")}</h2><p>{tr("Resolved and past service interruptions.")}</p></div></div>{resolved.length ? <div className="incident-list">{resolved.map((incident) => <IncidentRow key={incident.id} incident={incident} onClick={() => onOpen(incident.model_id)} />)}</div> : <div className="empty-inline"><Activity size={17} /><span>{tr("No incident history yet.")}</span></div>}</div>
  </>;
}

function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><strong>{tr(title)}</strong><p>{tr(description)}</p>{action}</div>;
}

function SettingsPage({ settings, notifications, onSave, onSaveNotification, onRefresh, notify }: { settings: Record<string, unknown>; notifications: Array<Record<string, unknown>>; onSave: (value: Record<string, unknown>) => void; onSaveNotification: (value: Record<string, unknown>) => void; onRefresh: () => void; notify: (message: string, kind?: 'success' | 'error') => void }) {
  const [form, setForm] = useState(settings);
  const [kind, setKind] = useState('webhook');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [eventSet, setEventSet] = useState(['DOWN', 'RECOVERED', 'SLOW', 'AUTH_ERROR', 'RATE_LIMIT']);
  useEffect(() => setForm(settings), [settings]);
  const update = (key: string, value: unknown) => setForm((current) => ({ ...current, [key]: value }));
  const submitNotification = (event: FormEvent) => {
    event.preventDefault();
    onSaveNotification({ name, kind, url, botToken, chatId, cooldownMinutes: 15, events: eventSet });
    setName(''); setUrl(''); setBotToken(''); setChatId('');
  };
  async function deleteNotification(id: string) {
    try { await api(`/api/notifications/${id}`, { method: 'DELETE' }); onRefresh(); notify('Notification channel removed.'); }
    catch (error) { notify(error instanceof Error ? error.message : 'Could not remove channel.', 'error'); }
  }
  return <>
    <PageHeading eyebrow="WORKSPACE" title={tr("Settings")} description="Retention, health thresholds, status page access and alert destinations." />
    <div className="settings-layout"><div className="settings-main">
      <section className="section-card settings-card"><div className="settings-card-heading"><span className="settings-card-icon violet"><SettingsIcon size={17} /></span><div><h2>{tr("Monitoring defaults")}</h2><p>{tr("Data retention and new model defaults.")}</p></div></div>
        <div className="settings-fields"><label>{tr("Detailed check retention")}<select value={form.retentionDays as number ?? 14} onChange={(event) => update('retentionDays', Number(event.target.value))}>{[7, 14, 30].map((value) => <option value={value} key={value}>{value} {tr("days")}</option>)}</select><small>{tr("Individual checks are then rolled into hourly aggregates.")}</small></label>
          <label>{tr("Aggregate retention")}<select value={form.aggregateRetentionDays as number ?? 180} onChange={(event) => update('aggregateRetentionDays', Number(event.target.value))}>{[90, 180].map((value) => <option value={value} key={value}>{value} {tr("days")}</option>)}</select></label>
          <label>{tr("Default failure threshold")}<select value={form.defaultFailureThreshold as number ?? 3} onChange={(event) => update('defaultFailureThreshold', Number(event.target.value))}>{[1, 2, 3, 5, 10].map((value) => <option key={value} value={value}>{value} {tr("consecutive failures")}</option>)}</select></label>
          <label>{tr("Default recovery threshold")}<select value={form.defaultRecoveryThreshold as number ?? 2} onChange={(event) => update('defaultRecoveryThreshold', Number(event.target.value))}>{[1, 2, 3, 5, 10].map((value) => <option key={value} value={value}>{value} {tr("consecutive successes")}</option>)}</select></label></div>
        <div className="settings-card-footer"><span><ShieldCheck size={14} /> {tr("Applied to new providers")}</span><button className="button primary small-button" onClick={() => onSave(form)}>{tr("Save settings")}</button></div>
      </section>
      <section className="section-card settings-card"><div className="settings-card-heading"><span className="settings-card-icon blue"><Globe2 size={17} /></span><div><h2>{tr("Public status page")}</h2><p>{tr("Share a safe, read-only view of provider health.")}</p></div></div>
        <div className="status-page-setting"><div><strong>{tr("Public access")}</strong><span>{tr("Shows provider status and incidents at ")}<code>/</code>{tr(". Never includes credentials.")}</span></div><label className="toggle-line"><input type="checkbox" checked={Boolean(form.publicStatus)} onChange={(event) => update('publicStatus', event.target.checked)} /><span className="toggle-ui" /><span>{form.publicStatus ? tr('Public') : tr('Private')}</span></label></div>
        <div className="settings-card-footer"><span><LockKeyhole size={14} /> {tr("Status details can be viewed publicly without signing in.")}</span><button className="button secondary small-button" onClick={() => window.open('/', '_blank', 'noopener,noreferrer')}>{tr("Preview page ")}<ExternalLink size={13} /></button></div>
      </section>
      <section className="section-card settings-card"><div className="settings-card-heading"><span className="settings-card-icon orange"><Zap size={17} /></span><div><h2>{tr("Notifications")}</h2><p>{tr("Alert destinations are encrypted and protected by cooldowns.")}</p></div></div>
        {notifications.length > 0 && <div className="notification-list">{notifications.map((item) => <div className="notification-row" key={String(item.id)}><span className={`notification-channel ${String(item.kind)}`}>{String(item.kind) === 'telegram' ? 'T' : String(item.kind) === 'discord' ? '◉' : '@'}</span><div><strong>{String(item.name)}</strong><span>{String(item.kind).replace('_', ' ')} {tr("· ")}{item.enabled === true || item.enabled === 1 ? 'Enabled' : 'Disabled'} {tr("· ")}{String(item.cooldown_minutes)} {tr("min cooldown")}</span></div><span className="configured-label"><i className="green-dot" />{item.configured ? 'Configured' : 'Missing target'}</span><button className="icon-button tiny danger-hover" aria-label={tr("Delete notification")} onClick={() => void deleteNotification(String(item.id))}><Trash2 size={14} /></button></div>)}</div>}
        <form className="notification-form" onSubmit={submitNotification}><div className="form-grid"><label>{tr("Channel name")}<input value={name} onChange={(event) => setName(event.target.value)} placeholder={tr("Production alerts")} required /></label><label>{tr("Delivery type")}<select value={kind} onChange={(event) => setKind(event.target.value)}><option value="webhook">{tr("Webhook")}</option><option value="discord">{tr("Discord webhook")}</option><option value="telegram">{tr("Telegram bot")}</option><option value="email_webhook">{tr("Email via webhook")}</option></select></label>
          {kind === 'telegram' ? <><label>{tr("Bot token")}<input type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} required /></label><label>{tr("Chat ID")}<input value={chatId} onChange={(event) => setChatId(event.target.value)} required /></label></> : <label className="span-2">{kind === 'email_webhook' ? 'Email service webhook URL' : 'Webhook URL'}<input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder={tr("https://hooks.example.com/...")} required /></label>}
        </div><div className="event-pills"><span>{tr("Notify for")}</span>{['DOWN', 'RECOVERED', 'SLOW', 'HIGH_LATENCY', 'AUTH_ERROR', 'RATE_LIMIT'].map((event) => <label key={event} className="event-pill"><input type="checkbox" checked={eventSet.includes(event)} onChange={() => setEventSet((current) => current.includes(event) ? current.filter((value) => value !== event) : [...current, event])} />{event.replace('_', ' ')}</label>)}</div>
          <div className="notification-submit"><span><Clock3 size={14} /> {tr("15-minute cooldown prevents alert spam")}</span><button className="button secondary small-button" type="submit"><Plus size={15} /> {tr("Add destination")}</button></div>
        </form>
      </section>
    </div><aside className="settings-aside"><div className="settings-tip"><span className="tip-icon"><ShieldCheck size={18} /></span><h3>{tr("Built for privacy")}</h3><p>{tr("Provider keys and notification secrets are encrypted with AES-GCM before they reach D1.")}</p><ul><li>{tr("Keys never enter local storage")}</li><li>{tr("Authenticated, CSRF-protected API")}</li><li>{tr("Dashboard is private by default")}</li></ul></div><div className="settings-runtime"><div><span className="runtime-label">{tr("EDGE RUNTIME")}</span><strong><span className="green-dot" /> {tr("Cloudflare Workers")}</strong></div><div><span className="runtime-label">{tr("SCHEDULER")}</span><strong><Clock3 size={14} /> {tr("Every minute")}</strong></div><div><span className="runtime-label">{tr("REGION")}</span><strong><Globe2 size={14} /> {tr("Global edge")}</strong></div></div></aside></div>
  </>;
}

function PublicStatus({ navigate, theme, setTheme, language, onLanguageChange }: { navigate: (path: string) => void; theme: 'dark' | 'light'; setTheme: (theme: 'dark' | 'light') => void; language: Language; onLanguageChange: () => void }) {
  const [data, setData] = useState<Record<string, any> | null>(null);
  const [privatePage, setPrivatePage] = useState(false);
  const [loadError, setLoadError] = useState(false);
  useEffect(() => {
    let active = true;
    const load = () => api<Record<string, any>>('/api/status').then((result) => {
      if (!active) return;
      setData(result);
      setPrivatePage(false);
      setLoadError(false);
    }).catch((error) => {
      if (!active) return;
      const isPrivate = error instanceof Error && error.message.toLowerCase().includes('private');
      setPrivatePage(isPrivate);
      setLoadError(!isPrivate);
    });
    void load();
    const timer = window.setInterval(() => void load(), 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const states = data?.status ?? [];
  const publicModels = data?.models ?? [];
  const publicIncidents = data?.incidents ?? [];
  const down = states.some((item: any) => item.status === 'DOWN');
  const slow = states.some((item: any) => item.status === 'SLOW');
  const headline = privatePage ? 'This status page is private.' : down ? 'Some systems are experiencing issues.' : slow ? 'Some systems are degraded.' : 'All systems operational.';
  const subtitle = privatePage ? 'Sign in to your monitor to enable public access.' : loadError ? 'Unable to load status right now.' : data ? (language === 'zh-CN' ? `${states.length} 个服务商 · 持续监控中` : `${states.length} ${states.length === 1 ? 'provider' : 'providers'} · monitored continuously`) : 'Loading service status…';
  return <div className="public-page">
    <header className="public-top">
      <a className="brand" href="/"><span className="brand-mark"><Activity size={18} /></span><span className="brand-text">signal<span>ai</span><small>{tr("STATUS")}</small></span></a>
      <div className="public-actions"><span className="public-updated"><span className="pulse-dot" /> {tr("LIVE STATUS")}</span><button className="locale-toggle" onClick={onLanguageChange} aria-label={language === 'zh-CN' ? 'Switch language to English' : '切换界面语言为中文'}>{language === 'zh-CN' ? 'EN' : '中文'}</button><button className="icon-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={tr("Toggle theme")}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button></div>
    </header>
    <main className="public-content">
      <div className={`public-hero ${down ? 'has-down' : slow ? 'has-slow' : ''}`}><span className="public-hero-icon">{down ? <TriangleAlert size={20} /> : <Check size={20} />}</span><div><span className="page-eyebrow">{tr("AI API STATUS")}</span><h1>{tr(headline)}</h1><p>{tr(subtitle)}</p></div></div>
      {privatePage ? <button className="button primary" onClick={() => navigate('/admin')}>{tr("Sign in to monitor ")}<ArrowUpRight size={15} /></button> : <>
        {data?.summary && <section className="public-summary-grid" aria-label={tr('Model availability summary')}>
          <div><span>{tr('Total models')}</span><strong>{data.summary.totalModels ?? 0}</strong></div>
          <div className="is-up"><span>{tr('Operational')}</span><strong>{data.summary.up ?? 0}</strong></div>
          <div className="is-slow"><span>{tr('Slow')}</span><strong>{data.summary.slow ?? 0}</strong></div>
          <div className="is-down"><span>{tr('Down')}</span><strong>{data.summary.down ?? 0}</strong></div>
          <div><span>{tr('Average latency')}</span><strong>{formatMs(data.summary.averageLatency)}</strong></div>
          <div><span>{tr('24h uptime')}</span><strong>{data.summary.uptime24h == null ? '—' : `${data.summary.uptime24h.toFixed(2)}%`}</strong></div>
        </section>}
        <section className="public-provider-list public-model-list">
          <div className="public-section-heading"><div><h2>{tr('Model availability')}</h2><p>{tr('Current health and latest response for each model.')}</p></div><span>{publicModels.length} {tr('models')}</span></div>
          {publicModels.map((item: any) => <div className="public-model-row" key={`${item.provider}-${item.model}`}>
            <span className={`public-provider-dot ${String(item.status).toLowerCase()}`} />
            <span className="public-model-name"><strong>{item.model}</strong><small>{item.provider} · {item.checkedAt ? dateTime(item.checkedAt) : tr('Waiting for the first check.')}</small></span>
            <span className="public-model-latency">{formatMs(item.latency)}</span>
            <StatusBadge status={item.status} small />
          </div>)}
          {!publicModels.length && <div className="empty-inline"><Radio size={16} /><span>{tr('No models being monitored')}</span></div>}
        </section>
        <section className="public-provider-list"><div className="public-section-heading"><div><h2>{tr("Provider status")}</h2><p>{tr("Current health across monitored AI providers.")}</p></div><span>{states.length} {tr("providers")}</span></div>
          {states.map((item: any) => <div className="public-provider-row" key={item.provider}><span className={`public-provider-dot ${String(item.status).toLowerCase()}`} /><strong>{item.provider}</strong><span>{item.models} {tr(item.models === 1 ? 'model' : 'models')}</span><StatusBadge status={item.status === 'UP' ? 'UP' : item.status === 'SLOW' ? 'SLOW' : item.status === 'DOWN' ? 'DOWN' : 'UNKNOWN'} /></div>)}
          {!states.length && <div className="empty-inline"><Radio size={16} /><span>{tr("No provider status is available yet.")}</span></div>}
        </section>
        {publicIncidents.length > 0 && <section className="public-provider-list public-incidents"><div className="public-section-heading"><div><h2>{tr("Recent incidents")}</h2><p>{tr("Service events from the last 30 days.")}</p></div></div>{publicIncidents.slice(0, 10).map((incident: any) => <div className="public-incident-row" key={incident.id}><span className={`status-dot ${incident.resolved_at ? 'up' : 'down'}`} /><div><strong>{incident.title}</strong><span>{dateTime(incident.started_at)}{incident.resolved_at ? ` · ${tr('Resolved')}${dateTime(incident.resolved_at)}` : ` · ${tr('Ongoing')}`}</span></div><StatusBadge status={incident.resolved_at ? 'UP' : incident.status} small /></div>)}</section>}
      </>}
    </main>
    <footer className="public-footer"><span>{tr("Powered by Signal AI Monitor")}</span><button className="text-button" onClick={() => navigate('/admin')}>{tr("Admin sign in ")}<ArrowUpRight size={14} /></button></footer>
  </div>;
}

export default App;

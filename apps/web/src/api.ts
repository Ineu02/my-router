import type {
  DashboardStats,
  HealthSnapshot,
  HealthStatus,
  ModelEntry,
  ProviderAttempt,
  ProviderStatusView,
  RequestLogEntry,
  RouterApiKey,
  TopologyView,
} from '@router/shared';

/**
 * Typed admin API client.
 *
 * Every response shape below is imported from `@router/shared` (the same types
 * the server projects from) rather than restated — the only additions are the
 * HTTP envelopes the routes wrap them in. All imports are type-only, so nothing
 * from the backend (and no zod) is emitted into the browser bundle.
 *
 * The client talks to a same-origin `/api/admin/*` — in dev the Vite proxy
 * forwards to the router, so the httpOnly session cookie rides along and there
 * is no CORS or token-in-JS surface. It never sees, sends, or stores key
 * material; the server only ever hands back masked strings.
 */

/** Thrown for any non-2xx admin response; carries the HTTP status. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** A request log as projected by the server: attempts parsed, clientIp dropped. */
export type PublicLog = Omit<RequestLogEntry, 'attempts' | 'clientIp'> & {
  attempts: ProviderAttempt[];
};

export interface SessionInfo {
  authenticated: boolean;
  adminTokenConfigured: boolean;
}

export interface TimelineBucket {
  t: number;
  total: number;
  errors: number;
}

export interface OverviewResponse {
  stats: DashboardStats;
  timeline: TimelineBucket[];
  recent: PublicLog[];
  providers: ProviderStatusView[];
  topology: TopologyView;
}

/** A model row, enriched by the server with its provider's live state. */
export type ModelRow = ModelEntry & {
  providerEnabled: boolean;
  providerRequests: number;
};

export interface LadderEntry {
  id: string;
  provider: string | null;
  model: string;
  displayName: string;
  enabled: boolean;
  missing: boolean;
}

export interface ProfileRow {
  id: string;
  displayName: string;
  description: string;
  models: string[];
  enabled: boolean;
  updatedAt: number;
  ladder: LadderEntry[];
}

export interface ProfilesResponse {
  profiles: ProfileRow[];
  availableModels: Array<{
    id: string;
    provider: string;
    model: string;
    displayName: string;
    enabled: boolean;
    capabilities: string[];
  }>;
  defaultProfile: string;
}

/** Per-credential health, labelled and masked for display. Never a raw key. */
export type HealthRow = HealthSnapshot & {
  label: string;
  maskedKey: string;
};

export interface HealthResponse {
  states: HealthRow[];
}

/** A router client key without its hash — safe to list. */
export type PublicRouterKey = Omit<RouterApiKey, 'keyHash'>;

/**
 * A connected ChatGPT/Codex OAuth account, as the server projects it — masked
 * and status-only. There is deliberately no token field anywhere in this shape:
 * the access/refresh/id tokens never leave the server.
 */
export interface CodexAccount {
  credentialId: string;
  accountId: string | null;
  email: string | null;
  label: string;
  maskedKey: string;
  enabled: boolean;
  scope: string | null;
  expiresAt: number | null;
  expired: boolean;
  health: HealthSnapshot | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'Network error — is the router running?');
  }

  const text = await res.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const message =
      payload && typeof payload === 'object' && 'error' in payload
        ? String(payload.error)
        : res.statusText || `HTTP ${res.status}`;
    throw new ApiError(res.status, message);
  }
  return payload as T;
}

const get = <T>(path: string): Promise<T> => request<T>(path);
const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  /* session / auth */
  session: (): Promise<SessionInfo> => get('/api/admin/session'),
  login: (token: string): Promise<{ ok: true }> => post('/api/admin/login', { token }),
  logout: (): Promise<{ ok: true }> => post('/api/admin/logout'),

  /* reads */
  overview: (): Promise<OverviewResponse> => get('/api/admin/overview'),
  stats: (): Promise<DashboardStats> => get('/api/admin/stats'),
  topology: (): Promise<TopologyView> => get('/api/admin/topology'),
  providers: (): Promise<{ providers: ProviderStatusView[] }> => get('/api/admin/providers'),
  models: (): Promise<{ models: ModelRow[] }> => get('/api/admin/models'),
  profiles: (): Promise<ProfilesResponse> => get('/api/admin/profiles'),
  keys: (): Promise<{ keys: PublicRouterKey[] }> => get('/api/admin/keys'),
  logs: (limit = 100): Promise<{ logs: PublicLog[]; total: number }> =>
    get(`/api/admin/logs?limit=${limit}`),
  health: (): Promise<HealthResponse> => get('/api/admin/health'),

  /* admin-only controls (still ADMIN_TOKEN-guarded server-side) */
  probeHealth: (): Promise<{ ok: true; states: HealthSnapshot[] }> =>
    post('/api/admin/health/probe'),
  resetHealth: (): Promise<{ ok: true; states: HealthSnapshot[] }> =>
    post('/api/admin/health/reset'),

  /* codex / chatgpt oauth accounts — masked + status only */
  codexAccounts: (): Promise<{ accounts: CodexAccount[] }> =>
    get('/api/admin/providers/codex/accounts'),
  codexConnect: (): Promise<{ ok: true; authorizeUrl: string; state: string }> =>
    post('/api/admin/providers/codex/connect'),
  codexDisconnect: (credentialId: string): Promise<{ ok: true }> =>
    post(`/api/admin/providers/codex/accounts/${encodeURIComponent(credentialId)}/disconnect`),
};

export type { DashboardStats, HealthStatus, ProviderStatusView, TopologyView };

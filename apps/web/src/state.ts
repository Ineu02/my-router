import type { DashboardStats, ProviderStatusView, TopologyView } from '@router/shared';
import type { HealthRow, ModelRow, ProfileRow, PublicLog, PublicRouterKey } from './api';
import type { LinkStatus, StreamEvent } from './events';

/**
 * Central UI store: the last-known snapshot of everything the panels render,
 * plus a rolling feed derived from the live event stream and the current
 * selection. Dead simple pub/sub — at this scale a full notify per change is
 * cheaper than any fine-grained reactivity, and keeps every panel honest about
 * reading from one source of truth.
 */

export type FeedKind = 'route' | 'fallback' | 'success' | 'error' | 'health' | 'attempt' | 'info';

export interface FeedEntry {
  id: number;
  at: number;
  kind: FeedKind;
  message: string;
  tag: string;
}

export interface AppState {
  stats: DashboardStats | null;
  topology: TopologyView | null;
  providers: ProviderStatusView[];
  models: ModelRow[];
  profiles: ProfileRow[];
  keys: PublicRouterKey[];
  logs: PublicLog[];
  health: HealthRow[];
  feed: FeedEntry[];
  link: LinkStatus;
  selectedProviderId: string | null;
}

const FEED_CAP = 80;

function initialState(): AppState {
  return {
    stats: null,
    topology: null,
    providers: [],
    models: [],
    profiles: [],
    keys: [],
    logs: [],
    health: [],
    feed: [],
    link: 'connecting',
    selectedProviderId: null,
  };
}

type Listener = (state: AppState) => void;

class Store {
  private state = initialState();
  private readonly listeners = new Set<Listener>();
  private feedSeq = 0;

  get(): AppState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  patch(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  select(providerId: string | null): void {
    if (this.state.selectedProviderId === providerId) return;
    this.patch({ selectedProviderId: providerId });
  }

  pushFeed(kind: FeedKind, tag: string, message: string, at: number): void {
    const entry: FeedEntry = { id: ++this.feedSeq, at, kind, tag, message };
    this.state = { ...this.state, feed: [entry, ...this.state.feed].slice(0, FEED_CAP) };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.state);
  }
}

export const store = new Store();

/** Short provider label lookup for feed messages. */
function labelFor(id: string): string {
  return store.get().providers.find((p) => p.id === id)?.displayName ?? id;
}

/**
 * Translate a live event into a feed line. Returns null for events that carry
 * no operator-facing narrative (they still drive the scene directly).
 */
export function feedLineFor(event: StreamEvent): { kind: FeedKind; tag: string; message: string } | null {
  switch (event.type) {
    case 'request.route':
      return {
        kind: 'route',
        tag: 'route',
        message: `${event.requestedModel} → ${event.profile ?? 'default'} · ${event.ladder.length} hop${event.ladder.length === 1 ? '' : 's'}`,
      };
    case 'request.attempt': {
      const a = event.attempt;
      const ok = a.status === 'success';
      return {
        kind: ok ? 'success' : 'attempt',
        tag: ok ? 'ok' : a.status,
        message: `${labelFor(a.provider)} · ${a.model} · ${Math.round(a.latency_ms)}ms`,
      };
    }
    case 'request.fallback':
      return {
        kind: 'fallback',
        tag: 'fallback',
        message: `${labelFor(event.from)} → ${labelFor(event.to)} · ${event.reason}`,
      };
    case 'request.end':
      return event.status === 'error'
        ? { kind: 'error', tag: 'failed', message: `request failed after ${Math.round(event.latencyMs)}ms` }
        : null;
    case 'health.change':
      return {
        kind: 'health',
        tag: 'health',
        message: `${labelFor(event.providerId)} · ${event.from} → ${event.to}`,
      };
    case 'model.disabled':
      return { kind: 'error', tag: 'disabled', message: `${event.modelId} disabled · ${event.reason}` };
    default:
      return null;
  }
}

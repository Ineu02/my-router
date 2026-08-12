import type { RouterEvent } from '@router/shared';

/**
 * Typed wrapper over the `/api/admin/events` SSE stream.
 *
 * The server emits *named* events (`event: request.route`, `event: stats`, …)
 * whose payloads are the `RouterEvent` union from `@router/shared`, plus a
 * `hello` on connect. This wrapper lets callers subscribe to one event type and
 * receive the correctly-narrowed payload, or to `onAny` for the live feed.
 *
 * EventSource gives us reconnection for free; we only surface a coarse link
 * status so the topbar can show live / reconnecting / down.
 */

export type HelloEvent = { type: 'hello'; at: number };
export type StreamEvent = RouterEvent | HelloEvent;
export type StreamEventName = StreamEvent['type'];
export type StreamEventOf<T extends StreamEventName> = Extract<StreamEvent, { type: T }>;

export type LinkStatus = 'connecting' | 'live' | 'reconnecting' | 'down';

const EVENT_NAMES: StreamEventName[] = [
  'hello',
  'request.start',
  'request.route',
  'request.attempt',
  'request.fallback',
  'request.end',
  'health.change',
  'model.disabled',
  'stats',
];

type AnyListener = (event: StreamEvent) => void;
type StatusListener = (status: LinkStatus) => void;

export class RouterEventStream {
  private source: EventSource | null = null;
  private readonly byType = new Map<StreamEventName, Set<AnyListener>>();
  private readonly anyListeners = new Set<AnyListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private status: LinkStatus = 'connecting';

  constructor(private readonly url = '/api/admin/events') {}

  connect(): void {
    if (this.source) return;
    this.setStatus('connecting');

    const source = new EventSource(this.url, { withCredentials: true });
    this.source = source;

    source.addEventListener('open', () => this.setStatus('live'));
    source.addEventListener('error', () => {
      // EventSource retries on its own; CLOSED means it gave up (bad status /
      // wrong content-type), otherwise it is mid-reconnect.
      this.setStatus(source.readyState === EventSource.CLOSED ? 'down' : 'reconnecting');
    });

    for (const name of EVENT_NAMES) {
      source.addEventListener(name, (ev: MessageEvent) => {
        const raw = typeof ev.data === 'string' ? ev.data : '';
        if (!raw) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return;
        this.dispatch(name, parsed as StreamEvent);
      });
    }
  }

  /** Subscribe to a single event type. Returns an unsubscribe fn. */
  on<T extends StreamEventName>(type: T, listener: (event: StreamEventOf<T>) => void): () => void {
    let set = this.byType.get(type);
    if (!set) {
      set = new Set();
      this.byType.set(type, set);
    }
    const wrapped = listener as AnyListener;
    set.add(wrapped);
    return () => set?.delete(wrapped);
  }

  /** Subscribe to every event — used by the live feed. Returns an unsubscribe fn. */
  onAny(listener: AnyListener): () => void {
    this.anyListeners.add(listener);
    return () => this.anyListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  close(): void {
    this.source?.close();
    this.source = null;
    this.setStatus('down');
  }

  private dispatch(name: StreamEventName, event: StreamEvent): void {
    const set = this.byType.get(name);
    if (set) for (const fn of set) fn(event);
    for (const fn of this.anyListeners) fn(event);
  }

  private setStatus(status: LinkStatus): void {
    if (status === this.status) return;
    this.status = status;
    for (const fn of this.statusListeners) fn(status);
  }
}

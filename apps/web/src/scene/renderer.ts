import type { TopologyView } from '@router/shared';

/** Callbacks the topology view raises back to the app. */
export interface SceneCallbacks {
  onSelect: (providerId: string | null) => void;
  onHover: (providerId: string | null) => void;
}

/**
 * The contract shared by the WebGL scene and the DOM fallback, so the rest of
 * the app is agnostic to which one is live. The pulse methods are visual-only;
 * the fallback may implement them as brief highlights or ignore them.
 */
export interface TopologyRenderer {
  setTopology(view: TopologyView): void;
  routePulse(ladder: string[]): void;
  attemptPulse(providerId: string, ok: boolean): void;
  fallbackPulse(fromId: string): void;
  select(providerId: string | null): void;
  resize(): void;
  dispose(): void;
}

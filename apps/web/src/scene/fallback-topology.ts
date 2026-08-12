import type { HealthStatus, TopologyView } from '@router/shared';
import type { SceneCallbacks, TopologyRenderer } from './renderer';

/**
 * Graceful fallback for when WebGL is unavailable: the same
 * CLIENT → ROUTER → PROVIDERS graph rendered as three DOM columns.
 *
 * It carries the same data the 3D scene does — health as a coloured LED,
 * latency, request counts, ladder position — so nothing is lost, only the
 * dimension. Traffic pulses become a brief edge highlight.
 */

const STATUS_VAR: Record<HealthStatus, string> = {
  ONLINE: 'var(--h-online)',
  DEGRADED: 'var(--h-degraded)',
  RATE_LIMITED: 'var(--h-rate)',
  OFFLINE: 'var(--h-offline)',
  DISABLED: 'var(--h-disabled)',
};

export class FallbackTopology implements TopologyRenderer {
  private readonly root: HTMLElement;
  private readonly providersCol: HTMLElement;
  private selected: string | null = null;
  private readonly rowEls = new Map<string, HTMLElement>();

  constructor(
    host: HTMLElement,
    private readonly cb: SceneCallbacks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'fallback';
    this.root.innerHTML = `
      <div class="fallback__note">WebGL unavailable — showing the topology in 2D.</div>
      <div class="flow">
        <div class="flow__col">
          <div class="flow__col-h">Client</div>
          <div class="node2d client"><b>Client</b><small>OpenAI-compatible callers</small></div>
        </div>
        <div class="flow__arrows">──▶</div>
        <div class="flow__col">
          <div class="flow__col-h">Router</div>
          <div class="node2d router"><b>Router</b><small class="js-router-sub">—</small></div>
        </div>
        <div class="flow__arrows">──▶</div>
        <div class="flow__col js-providers">
          <div class="flow__col-h">Providers</div>
        </div>
      </div>`;
    host.appendChild(this.root);
    this.providersCol = this.root.querySelector('.js-providers') as HTMLElement;
  }

  setTopology(view: TopologyView): void {
    const sub = this.root.querySelector('.js-router-sub');
    if (sub) sub.textContent = `profile ${view.router.profile} · ${view.router.providers} providers`;

    const seen = new Set<string>();
    const byShare = new Map(view.edges.map((e) => [e.to, e.share]));
    for (const node of view.nodes) {
      seen.add(node.id);
      let row = this.rowEls.get(node.id);
      if (!row) {
        row = document.createElement('div');
        row.className = 'node2d';
        row.setAttribute('role', 'button');
        row.tabIndex = 0;
        row.addEventListener('click', () => this.cb.onSelect(node.id));
        row.addEventListener('mouseenter', () => this.cb.onHover(node.id));
        row.addEventListener('mouseleave', () => this.cb.onHover(null));
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            this.cb.onSelect(node.id);
          }
        });
        this.providersCol.appendChild(row);
        this.rowEls.set(node.id, row);
      }
      const share = Math.round((byShare.get(node.id) ?? 0) * 100);
      row.style.borderColor = node.id === this.selected ? 'var(--hair-strong)' : 'var(--hair-soft)';
      row.innerHTML = `
        <span class="node2d__led" style="color:${STATUS_VAR[node.status]}"></span>
        <b>${escapeHtml(node.label)}</b>
        <small>${node.status} · ${node.latencyMs}ms · ${node.requests} req · ${share}%</small>`;
    }
    for (const [id, row] of this.rowEls) {
      if (!seen.has(id)) {
        row.remove();
        this.rowEls.delete(id);
      }
    }
  }

  routePulse(): void {
    /* no motion layer in the fallback */
  }

  attemptPulse(providerId: string, ok: boolean): void {
    const row = this.rowEls.get(providerId);
    if (!row) return;
    row.animate(
      [
        { boxShadow: `0 0 0 1px ${ok ? 'var(--h-online)' : 'var(--h-offline)'}` },
        { boxShadow: '0 0 0 1px transparent' },
      ],
      { duration: 700, easing: 'ease-out' },
    );
  }

  fallbackPulse(fromId: string): void {
    this.attemptPulse(fromId, false);
  }

  select(providerId: string | null): void {
    this.selected = providerId;
    for (const [id, row] of this.rowEls) {
      row.style.borderColor = id === providerId ? 'var(--hair-strong)' : 'var(--hair-soft)';
    }
  }

  resize(): void {
    /* CSS-driven; nothing to recompute */
  }

  dispose(): void {
    this.root.remove();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

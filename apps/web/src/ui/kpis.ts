import type { DashboardStats } from '@router/shared';
import { fmtMs, fmtNum, fmtPct, h } from './dom';

interface Tile {
  label: string;
  value: HTMLElement;
  trend: HTMLElement;
}

/** The six KPI tiles across the top, fed by DashboardStats (poll + SSE). */
export function createKpis(): { el: HTMLElement; update: (s: DashboardStats) => void } {
  const defs = ['Requests', 'Success', 'Active', 'Avg latency', 'Failovers', 'Profile'];
  const tiles: Tile[] = [];
  const root = h('div', { class: 'kpis' });

  for (const label of defs) {
    const value = h('div', { class: 'kpi__value', text: '—' });
    const trend = h('div', { class: 'kpi__trend', text: '' });
    root.append(h('div', { class: 'kpi' }, [h('div', { class: 'kpi__label', text: label }), value, trend]));
    tiles.push({ label, value, trend });
  }

  const set = (i: number, main: string, gold: boolean, trend: string): void => {
    const t = tiles[i];
    if (!t) return;
    t.value.textContent = main;
    t.value.classList.toggle('is-gold', gold);
    t.trend.textContent = trend;
  };

  const update = (s: DashboardStats): void => {
    set(0, fmtNum(s.totalRequests), false, `${fmtNum(s.requestsLast24h)} in 24h`);
    set(1, fmtPct(s.successRate), s.successRate >= 0.99, `${fmtNum(s.streamingRequests)} streamed`);
    set(2, `${s.activeProviders}/${s.totalProviders}`, s.activeProviders > 0, 'providers online');
    set(3, fmtMs(s.avgLatencyMs), false, 'mean upstream');
    set(4, fmtNum(s.failoverEvents), s.failoverEvents === 0 ? false : true, 'fallbacks');
    set(5, s.currentProfile, true, `${fmtNum(s.totalTokens)} tokens`);
  };

  return { el: root, update };
}

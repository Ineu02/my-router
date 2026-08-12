import { HEALTH_RANK, type ProviderStatusView } from '@router/shared';
import { clear, fmtAgo, fmtMs, fmtNum, fmtPct, h, statusClass } from './dom';

/**
 * Provider list — renders into a caller-owned body element. Ordered by health
 * then priority so whatever is degraded floats up. Selecting a row drives both
 * the 3D scene and the detail panel.
 */
export function providerList(
  body: HTMLElement,
  onSelect: (id: string) => void,
): (providers: ProviderStatusView[], selectedId: string | null) => void {
  return (providers, selectedId) => {
    clear(body);
    const sorted = [...providers].sort(
      (a, b) => HEALTH_RANK[a.status] - HEALTH_RANK[b.status] || b.priority - a.priority,
    );
    for (const p of sorted) {
      const led = h('span', { class: `prow__led ${statusClass(p.status)}` });
      const name = h('div', { class: 'prow__name' }, [
        h('b', { text: p.displayName }),
        h('small', { text: `${p.kind} · ${p.modelCount} models` }),
      ]);
      const stat = h('div', { class: 'prow__stat' }, [
        h('b', { text: fmtMs(p.avgLatencyMs) }),
        h('div', { class: statusClass(p.status), text: p.status }),
      ]);
      body.append(
        h(
          'div',
          {
            class: 'prow',
            role: 'button',
            tabIndex: 0,
            ariaSelected: p.id === selectedId,
            onClick: () => onSelect(p.id),
            onKeyDown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelect(p.id);
              }
            },
          },
          [led, name, stat],
        ),
      );
    }
    if (providers.length === 0) body.append(h('div', { class: 'feed__empty', text: 'No providers registered.' }));
  };
}

/**
 * Provider detail — live metrics, cooldown countdown, and credentials shown
 * ONLY as masked handles and per-key health. No key material crosses this
 * boundary: the server never sends it, and this never asks for it.
 */
export function providerDetail(
  body: HTMLElement,
  title: HTMLElement,
): (providers: ProviderStatusView[], selectedId: string | null) => void {
  const metric = (k: string, v: string, klass = ''): HTMLElement =>
    h('div', { class: 'metric' }, [
      h('div', { class: 'metric__k', text: k }),
      h('div', { class: `metric__v ${klass}`, text: v }),
    ]);

  return (providers, selectedId) => {
    clear(body);
    const p = providers.find((x) => x.id === selectedId);
    if (!p) {
      title.textContent = 'Detail';
      body.append(h('div', { class: 'feed__empty', text: 'Select a provider node to inspect it.' }));
      return;
    }
    title.textContent = p.displayName;

    const detail = h('div', { class: 'detail' });
    detail.append(
      h('div', { class: 'detail__title' }, [
        h('span', { class: `prow__led ${statusClass(p.status)}` }),
        h('b', { text: p.displayName }),
      ]),
      h('div', { class: 'detail__kind', text: `${p.kind} · priority ${p.priority} · ${p.status}` }),
      h('div', { class: 'detail__grid' }, [
        metric('Status', p.status, statusClass(p.status)),
        metric('Avg latency', fmtMs(p.avgLatencyMs)),
        metric('Requests', fmtNum(p.totalRequests)),
        metric('Failures', fmtNum(p.totalFailures), p.totalFailures > 0 ? 's-OFFLINE' : ''),
        metric('Success', fmtPct(p.successRate)),
        metric('Last success', fmtAgo(p.lastSuccessAt)),
      ]),
    );

    // Cooldown — soonest still-active backoff across this provider's credentials.
    const now = Date.now();
    const cooldowns = p.credentials
      .map((c) => c.health?.cooldownUntil ?? null)
      .filter((t): t is number => t !== null && t > now);
    if (cooldowns.length > 0) {
      const until = Math.min(...cooldowns);
      const remaining = Math.max(0, until - now);
      const ready = p.credentials.length - cooldowns.length;
      const bar = h('div', { class: 'cooldown__bar' }, [
        h('i', { attrs: { style: `width:${Math.min(100, (remaining / 60_000) * 100)}%` } }),
      ]);
      detail.append(
        h('div', {}, [
          h('div', { class: 'cooldown' }, [
            h('span', { text: `Cooldown active · ${ready}/${p.credentials.length} keys ready` }),
            h('b', { text: `${Math.ceil(remaining / 1000)}s` }),
          ]),
          bar,
        ]),
      );
    }

    // Credentials — masked handles + per-key health only. Never a raw secret.
    const creds = h('div', { class: 'creds' }, [
      h('div', { class: 'creds__h', text: `Credentials · ${p.credentials.length}` }),
    ]);
    for (const c of p.credentials) {
      const st = c.health?.status ?? (c.enabled ? 'OFFLINE' : 'DISABLED');
      creds.append(
        h('div', { class: 'cred' }, [
          h('div', { class: 'cred__key' }, [h('b', { text: c.label }), document.createTextNode(`  ${c.maskedKey}`)]),
          h('div', { class: `cred__meta ${statusClass(st)}`, text: c.enabled ? st : 'disabled' }),
        ]),
      );
    }
    detail.append(creds);
    body.append(detail);
  };
}
